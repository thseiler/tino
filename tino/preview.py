"""WebSocket manager for live Typst preview via Tinymist."""

import asyncio
import json
import logging
import os
import shutil
import socket
import time
from asyncio.subprocess import Process
from collections import deque
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import websockets
from fastapi import WebSocket, WebSocketDisconnect
from websockets.client import connect as ws_connect

from . import config
from .services.compiler import CompilerService

logger = logging.getLogger(__name__)


@dataclass
class UpstreamBridge:
    """Holds ports, sockets, and task state for the shared Tinymist connection."""
    data_port: int
    control_port: int
    data_ws: Any = None
    control_ws: Any = None
    task: asyncio.Task | None = None
    ready: asyncio.Event = field(default_factory=asyncio.Event)
    last_jump_requester: WebSocket | None = None
    scroll_waiters: deque[WebSocket] = field(default_factory=deque)


@dataclass
class PreviewSession:
    """Holds state for a running Tinymist preview daemon and connected clients."""
    slug: str
    path: str
    bucket_dir: Path
    bridge: UpstreamBridge
    active_clients: set[WebSocket] = field(default_factory=set)
    pending_clients: set[WebSocket] = field(default_factory=set)
    process: Process | None = None
    last_sync_request: float = 0.0

    @property
    def all_clients(self) -> set[WebSocket]:
        """Return all connected clients (both active and awaiting initial snapshot)."""
        return self.active_clients | self.pending_clients


class PreviewManager:
    """Manages background Tinymist compilers and proxies Vector IR data."""

    def __init__(self, compiler: CompilerService, room_ttl: int = 300):
        self.compiler = compiler
        self.room_ttl = room_ttl
        self._sessions: dict[tuple[str, str], PreviewSession] = {}
        self._locks: dict[tuple[str, str], asyncio.Lock] = {}
        self._ttl_tasks: dict[tuple[str, str], asyncio.Task] = {}

    def _get_lock(self, key: tuple[str, str]) -> asyncio.Lock:
        if key not in self._locks:
            self._locks[key] = asyncio.Lock()
        return self._locks[key]

    @staticmethod
    def _get_free_port() -> int:
        """Allocate a free ephemeral port from the OS."""
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.bind(('127.0.0.1', 0))
            return s.getsockname()[1]

    @staticmethod
    async def _wait_for_port(
        port: int,
        process: Process,
        timeout: float = 5.0
    ) -> None:
        """Poll the port until Tinymist binds to it and is ready."""
        if process.returncode is not None:
            raise RuntimeError("Tinymist failed to start.")

        interval = 0.1
        max_attempts = int(timeout / interval)

        for _ in range(max_attempts):
            try:
                _, writer = await asyncio.open_connection('127.0.0.1', port)
                writer.close()
                await writer.wait_closed()
                return
            except OSError:
                await asyncio.sleep(interval)
        raise RuntimeError(f"Tinymist failed to bind to port {port} in time.")

    @staticmethod
    def _binary_command(payload: bytes) -> bytes:
        """Extract the ASCII command prefix before the first comma in a binary frame."""
        comma_idx = payload.find(b',')
        if comma_idx == -1:
            return b''
        return payload[:comma_idx]

    @staticmethod
    def _is_diff_frame(payload: bytes) -> bool:
        """Return True if a binary Vector IR message is an incremental diff."""
        comma_idx = payload.find(b',')
        if comma_idx == -1:
            return False
        command = payload[:comma_idx].decode('utf-8', errors='ignore')
        return command.startswith('diff')

    async def serve(self, websocket: WebSocket, slug: str, path: str) -> None:
        """Attach a client WebSocket to the shared Tinymist preview session."""
        key = (slug, path)
        session = await self._prepare_session(websocket, key)
        if session is None:
            return

        try:
            await asyncio.wait_for(session.bridge.ready.wait(), timeout=5.0)
            await self._client_receive_loop(websocket, session)
        except WebSocketDisconnect:
            pass
        except (websockets.exceptions.WebSocketException, OSError) as e:
            logger.error('Tinymist sidecar error for %s/%s: %s', slug, path, e)
            await self._handle_zombie_session(key)
        finally:
            if session.process and session.process.returncode is not None:
                await self._handle_zombie_session(key)
            await self._schedule_teardown(websocket, key)

    async def _prepare_session(
        self,
        websocket: WebSocket,
        key: tuple[str, str]
    ) -> PreviewSession | None:
        """Get or start a Tinymist session, ensure its upstream bridge, and register client."""
        lock = self._get_lock(key)
        async with lock:
            ttl_task = self._ttl_tasks.pop(key, None)
            if ttl_task:
                ttl_task.cancel()

            session = self._sessions.get(key)

            if session and session.process and session.process.returncode is not None:
                logger.warning("Tinymist process for %s died unexpectedly. Restarting...", key)
                await self._stop_session_resources(session)
                del self._sessions[key]
                session = None

            if not session:
                session = await self._spawn_tinymist_process(key[0], key[1], websocket)
                if not session:
                    return None
                self._sessions[key] = session

            if not session.bridge.task or session.bridge.task.done():
                session.bridge.ready.clear()
                session.bridge.task = asyncio.create_task(
                    self._run_shared_upstream(session)
                )

            session.pending_clients.add(websocket)
            return session

    async def _run_shared_upstream(self, session: PreviewSession) -> None:
        """Maintain the single shared Data Plane and Control Plane connections to Tinymist."""
        key = (session.slug, session.path)
        headers = {"Origin": "http://127.0.0.1"}

        try:
            async with ws_connect(  # pylint: disable=no-member
                f'ws://127.0.0.1:{session.bridge.data_port}',
                extra_headers=headers,
                max_size=None,
                ping_interval=None
            ) as data_ws, ws_connect(  # pylint: disable=no-member
                f'ws://127.0.0.1:{session.bridge.control_port}',
                extra_headers=headers,
                max_size=None,
                ping_interval=None
            ) as control_ws:
                await self._bridge_streams(session, data_ws, control_ws)
        except asyncio.CancelledError:
            pass
        except (websockets.exceptions.WebSocketException, OSError) as e:
            logger.error("Shared upstream bridge failed for %s: %s", key, e)
            await self._handle_zombie_session(key)
        finally:
            session.bridge.data_ws = None
            session.bridge.control_ws = None
            session.bridge.ready.clear()

    async def _bridge_streams(
        self,
        session: PreviewSession,
        data_ws: Any,
        control_ws: Any
    ) -> None:
        """Bind upstream sockets to the session and run both pump tasks."""
        session.bridge.data_ws = data_ws
        session.bridge.control_ws = control_ws
        session.bridge.ready.set()

        await self._request_sync_snapshot(session)

        t_data = asyncio.create_task(self._pump_data_plane(session, data_ws))
        t_control = asyncio.create_task(self._pump_control_plane(session, control_ws))

        _, pending = await asyncio.wait(
            [t_data, t_control],
            return_when=asyncio.FIRST_COMPLETED
        )
        for task in pending:
            task.cancel()
        await asyncio.gather(*pending, return_exceptions=True)

    async def _request_sync_snapshot(self, session: PreviewSession, force: bool = False) -> None:
        """Send a rate-limited 'current' request only when pending_clients need a base frame."""
        key = (session.slug, session.path)
        lock = self._get_lock(key)
        should_send = False
        now = time.monotonic()

        async with lock:
            if not session.bridge.data_ws or not session.pending_clients:
                return
            if force or (now - session.last_sync_request) >= 0.8:
                session.last_sync_request = now
                should_send = True

        if should_send:
            logger.info("📍 Sync Barrier -> Data Plane ('current') for %s/%s",
                        session.slug, session.path)
            await session.bridge.data_ws.send('current')

    async def _pump_data_plane(self, session: PreviewSession, data_ws: Any) -> None:
        """Read from Tinymist Data Plane and fan out or target jump responses."""
        key = (session.slug, session.path)
        lock = self._get_lock(key)

        async for msg in data_ws:
            if not isinstance(msg, bytes):
                logger.info("📍 Data Plane -> clients : %s", msg)
                await self._broadcast_text(session, msg, list(session.all_clients))
                continue

            command = self._binary_command(msg)

            async with lock:
                if command == b'jump':
                    waiter = session.bridge.last_jump_requester
                    session.bridge.last_jump_requester = None
                    targets = [waiter] if waiter and waiter in session.all_clients else []
                elif command.startswith(b'diff'):
                    targets = list(session.active_clients)
                elif command == b'new':
                    session.active_clients.update(session.pending_clients)
                    session.pending_clients.clear()
                    targets = list(session.active_clients)
                else:
                    # Non-document metadata frames (e.g. cursor, outline, viewport)
                    targets = list(session.active_clients)

            if targets:
                await self._broadcast_bytes(session, msg, targets)

    @staticmethod
    def _pop_live_waiter(
        waiters: deque[WebSocket],
        session: PreviewSession
    ) -> WebSocket | None:
        """Pop the oldest waiting client that is still connected to this session."""
        live = session.all_clients
        for _ in range(len(waiters)):
            candidate = waiters.popleft()
            if candidate in live:
                return candidate
        return None

    @staticmethod
    def _parse_control_event(
        session: PreviewSession,
        msg: str
    ) -> tuple[str, str | None, bool]:
        """Normalize paths, return event name, and report if snapshot is needed."""
        try:
            data = json.loads(msg)
        except (json.JSONDecodeError, TypeError):
            return msg, None, False

        if not isinstance(data, dict):
            return msg, None, False

        event_name = data.get("event")
        should_trigger = (
            event_name == "compileStatus"
            and data.get("kind") == "CompileSuccess"
            and bool(session.pending_clients)
        )

        if "filepath" in data:
            raw_path = Path(data["filepath"])
            try:
                data["filepath"] = raw_path.relative_to(session.bucket_dir).as_posix()
            except ValueError:
                data["filepath"] = raw_path.name
            msg = json.dumps(data)

        return msg, event_name, should_trigger

    async def _pump_control_plane(self, session: PreviewSession, control_ws: Any) -> None:
        """Forward Control Plane events to all clients or the requesting client."""
        lock = self._get_lock((session.slug, session.path))

        async for raw_msg in control_ws:
            msg, event_name, should_trigger_snapshot = self._parse_control_event(
                session, raw_msg
            )
            logger.info("📍 Control Plane -> Clients : %s", msg)

            if event_name == "editorScrollTo":
                async with lock:
                    waiter = self._pop_live_waiter(session.bridge.scroll_waiters, session)
                targets = [waiter] if waiter else []
            else:
                targets = list(session.all_clients)

            if targets:
                await self._broadcast_text(session, msg, targets)

            if should_trigger_snapshot:
                await self._request_sync_snapshot(session, force=True)

    async def _broadcast_bytes(
        self,
        session: PreviewSession,
        data: bytes,
        targets: list[WebSocket]
    ) -> None:
        """Send binary frame to target clients and prune disconnected ones."""
        dead: list[WebSocket] = []
        for client in targets:
            try:
                await client.send_bytes(data)
            except (WebSocketDisconnect, RuntimeError, OSError):
                dead.append(client)
        if dead:
            await self._prune_clients(session, dead)

    async def _broadcast_text(
        self,
        session: PreviewSession,
        text: str,
        targets: list[WebSocket]
    ) -> None:
        """Send text frame to target clients and prune disconnected ones."""
        dead: list[WebSocket] = []
        for client in targets:
            try:
                await client.send_text(text)
            except (WebSocketDisconnect, RuntimeError, OSError):
                dead.append(client)
        if dead:
            await self._prune_clients(session, dead)

    async def _prune_clients(self, session: PreviewSession, dead: list[WebSocket]) -> None:
        lock = self._get_lock((session.slug, session.path))
        async with lock:
            for client in dead:
                self._remove_client_from_session(session, client)

    async def _client_receive_loop(
        self,
        websocket: WebSocket,
        session: PreviewSession
    ) -> None:
        """Read commands from a single client WebSocket and route to shared upstream."""
        try:
            while True:  # pylint: disable=while-used
                msg = await websocket.receive()
                if msg.get("type") == "websocket.disconnect":
                    break
                await self._route_client_message(websocket, msg, session)
        except (WebSocketDisconnect, websockets.exceptions.ConnectionClosed):
            pass

    @staticmethod
    def _normalize_control_payload(text: str, bucket_dir: Path) -> str | None:
        """Resolve and validate any filepath inside a JSON control payload."""
        try:
            data = json.loads(text)
        except (json.JSONDecodeError, TypeError):
            return text

        if not isinstance(data, dict) or "filepath" not in data:
            return text

        if not isinstance(data["filepath"], str):
            return None

        candidate = (bucket_dir / data["filepath"]).resolve()
        if not candidate.is_relative_to(bucket_dir.resolve()):
            return None

        data["filepath"] = candidate.as_posix()
        return json.dumps(data)

    async def _route_control_message(
        self,
        websocket: WebSocket,
        text: str,
        session: PreviewSession
    ) -> None:
        """Validate and forward a control-plane message to Tinymist."""
        if not session.bridge.control_ws:
            return
        normalized = self._normalize_control_payload(text, session.bucket_dir)
        if normalized is None:
            return
        if 'panelScrollTo' in normalized:
            async with self._get_lock((session.slug, session.path)):
                session.bridge.last_jump_requester = websocket
        logger.info("📍 Client -> Control Plane : %s", normalized)
        await session.bridge.control_ws.send(normalized)

    async def _route_text_message(
        self,
        websocket: WebSocket,
        text: str,
        session: PreviewSession
    ) -> None:
        """Route a text message to the sync barrier, control plane, or data plane."""
        if text == 'current':
            async with self._get_lock((session.slug, session.path)):
                if websocket in session.active_clients:
                    return
                session.pending_clients.add(websocket)
            await self._request_sync_snapshot(session)
            return

        if text.startswith('{') or 'panelScrollTo' in text or 'sourceScrollBy' in text:
            await self._route_control_message(websocket, text, session)
            return

        if session.bridge.data_ws:
            if text.startswith('src-point'):
                async with self._get_lock((session.slug, session.path)):
                    session.bridge.scroll_waiters.append(websocket)
            logger.info("📍 Client -> Data Plane : %s", text)
            await session.bridge.data_ws.send(text)

    async def _route_client_message(
        self,
        websocket: WebSocket,
        msg: Mapping[str, Any],
        session: PreviewSession
    ) -> None:
        """Route incoming browser messages to the shared Tinymist planes."""
        if msg.get("type") != "websocket.receive":
            return

        if msg.get("text") is not None:
            await self._route_text_message(websocket, msg["text"], session)
        elif msg.get("bytes") is not None and session.bridge.data_ws:
            await session.bridge.data_ws.send(msg["bytes"])

    async def _handle_zombie_session(self, key: tuple[str, str]) -> None:
        """Terminate a crashed session process and remove it from state."""
        lock = self._get_lock(key)
        async with lock:
            zombie = self._sessions.pop(key, None)
            if zombie:
                await self._stop_session_resources(zombie)

    async def _schedule_teardown(self, websocket: WebSocket, key: tuple[str, str]) -> None:
        """Remove client and schedule the TTL teardown if the room is empty."""
        lock = self._get_lock(key)
        async with lock:
            session = self._sessions.get(key)
            if session:
                self._remove_client_from_session(session, websocket)

                if not session.all_clients:
                    self._ttl_tasks[key] = asyncio.create_task(
                        self._deferred_cleanup(key[0], key[1])
                    )

    @staticmethod
    def _remove_client_from_session(session: PreviewSession, client: WebSocket) -> None:
        """Remove a client from active/pending sets and any pending sync queues."""
        session.active_clients.discard(client)
        session.pending_clients.discard(client)
        if session.bridge.last_jump_requester is client:
            session.bridge.last_jump_requester = None
        session.bridge.scroll_waiters = deque(
            w for w in session.bridge.scroll_waiters if w is not client
        )

    @staticmethod
    async def _stop_session_resources(session: PreviewSession) -> None:
        """Cancel background tasks and terminate the Tinymist process cleanly."""
        if session.bridge.task:
            session.bridge.task.cancel()
        if session.process and session.process.returncode is None:
            try:
                session.process.terminate()
                await asyncio.wait_for(session.process.wait(), timeout=3.0)
            except TimeoutError:
                session.process.kill()
                await session.process.wait()
            except OSError:
                pass

    async def _spawn_tinymist_process(
        self,
        slug: str,
        path: str,
        websocket: WebSocket
    ) -> PreviewSession | None:
        """Spin up the tinymist preview daemon on an ephemeral port."""
        tinymist_bin = shutil.which('tinymist')
        if not tinymist_bin:
            logger.error("Tinymist binary not found in system PATH!")
            await websocket.close(code=1011, reason="LSP server not installed")
            return None

        bucket_dir, source = self.compiler.resolve_source(slug, path)

        data_port = self._get_free_port()
        control_port = self._get_free_port()
        bridge = UpstreamBridge(data_port=data_port, control_port=control_port)
        session = PreviewSession(slug, path, bucket_dir, bridge)
        relative_entry = source.relative_to(bucket_dir).as_posix()

        env = os.environ.copy()
        env['XDG_CACHE_HOME'] = str(config.TINO_DATA_DIR / '.cache')

        cmd = [
            tinymist_bin, 'preview',
            '--no-open',
            '--data-plane-host', f'127.0.0.1:{data_port}',
            '--control-plane-host', f'127.0.0.1:{control_port}',
            '--root', str(bucket_dir),
            relative_entry
        ]

        if self.compiler.package_dir:
            cmd.extend(['--package-path', str(self.compiler.package_dir)])

        if self.compiler.font_dir and self.compiler.font_dir.is_dir():
            cmd.extend(['--font-path', str(self.compiler.font_dir)])

        session.process = await asyncio.create_subprocess_exec(
            *cmd,
            env=env,
            cwd=str(bucket_dir),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE
        )

        async def _log_stream(stream, prefix):
            async for line in stream:
                logger.debug('[%s] %s', prefix, line.decode().strip())

        if session.process.stdout and session.process.stderr:
            asyncio.create_task(_log_stream(session.process.stdout, 'TINYMIST STDOUT'))
            asyncio.create_task(_log_stream(session.process.stderr, 'TINYMIST STDERR'))

        await self._wait_for_port(data_port, session.process)
        await self._wait_for_port(control_port, session.process)
        logger.info('Started Tinymist proxy on port %d & %d for %s/%s',
                    data_port, control_port, slug, path)
        return session

    async def _deferred_cleanup(self, slug: str, path: str) -> None:
        """Tear down the sidecar after the TTL expires."""
        await asyncio.sleep(self.room_ttl)
        key = (slug, path)
        lock = self._get_lock(key)

        async with lock:
            self._ttl_tasks.pop(key, None)
            session = self._sessions.get(key)
            if not session or session.all_clients:
                return

            await self._stop_session_resources(session)
            del self._sessions[key]
            logger.info('Cleaned up Tinymist preview for %s/%s', slug, path)

    async def shutdown(self) -> None:
        """Cancel pending TTL tasks and flush all active sessions."""
        for task in self._ttl_tasks.values():
            task.cancel()
        self._ttl_tasks.clear()

        for session in list(self._sessions.values()):
            await self._stop_session_resources(session)
        self._sessions.clear()
