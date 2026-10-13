"""WebSocket manager for live Typst preview via Tinymist."""

import asyncio
from asyncio.subprocess import Process
import json
import logging
import os
import shutil
import socket
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import websockets
from fastapi import WebSocket, WebSocketDisconnect
from websockets.client import connect as ws_connect

from tino import config

from .services.compiler import CompilerService

logger = logging.getLogger(__name__)


@dataclass
class PreviewSession:
    """Holds state for a running Tinymist preview daemon."""
    slug: str
    path: str
    data_port: int
    control_port: int
    bucket_dir: Path
    clients: set[WebSocket] = field(default_factory=set)
    process: Process | None = None


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
                await asyncio.sleep(0.1)
        raise RuntimeError(f"Tinymist failed to bind to port {port} in time.")

    async def serve(self, websocket: WebSocket, slug: str, path: str) -> None:
        """Proxy a WebSocket connection directly to Tinymist's internal server."""
        key = (slug, path)
        session = await self._prepare_session(websocket, key)

        if session is None:
            return

        try:
            await self._run_proxy_bridge(websocket, session)
        except WebSocketDisconnect:
            pass
        except (websockets.exceptions.WebSocketException, OSError) as e:
            logger.error('Tinymist sidecar error for %s/%s: %s', slug, path, e)
            await self._handle_zombie_session(key)
        finally:
            if session.process and session.process.returncode is not None:
                await self._handle_zombie_session(key)
            await self._schedule_teardown(websocket, key)

    async def _run_proxy_bridge(self, websocket: WebSocket, session: PreviewSession) -> None:
        """Establish internal WebSockets and run the bidirectional message bridge."""
        headers = {"Origin": "http://127.0.0.1"}

        async with ws_connect(  # pylint: disable=no-member
            f'ws://127.0.0.1:{session.data_port}',
            extra_headers=headers,
            max_size=None,
            ping_interval=None
        ) as data_ws, ws_connect(  # pylint: disable=no-member
            f'ws://127.0.0.1:{session.control_port}',
            extra_headers=headers,
            max_size=None,
            ping_interval=None
        ) as control_ws:
            t_client = asyncio.create_task(
                self._client_to_tinymist(websocket, data_ws, control_ws, session.bucket_dir)
            )
            t_data = asyncio.create_task(
                self._tinymist_data_to_client(websocket, data_ws)
            )
            t_control = asyncio.create_task(
                self._tinymist_control_to_client(websocket, control_ws, session.bucket_dir)
            )

            _, pending = await asyncio.wait(
                [t_client, t_data, t_control],
                return_when=asyncio.FIRST_COMPLETED
            )

            for task in pending:
                task.cancel()
            await asyncio.gather(*pending, return_exceptions=True)

    async def _prepare_session(
        self,
        websocket: WebSocket,
        key: tuple[str, str]
    ) -> PreviewSession | None:
        """Get or start a Tinymist session, and register the client."""
        lock = self._get_lock(key)
        async with lock:
            # Cancel any pending teardown
            ttl_task = self._ttl_tasks.pop(key, None)
            if ttl_task:
                ttl_task.cancel()

            session = self._sessions.get(key)

            # If the process terminated unexpectedly, clear it out
            if session and session.process and session.process.returncode is not None:
                logger.warning("Tinymist process for %s died unexpectedly. Restarting...", key)
                del self._sessions[key]
                session = None

            if not session:
                session = await self._spawn_tinymist_process(key[0], key[1], websocket)
                if session:
                    self._sessions[key] = session

            if session:
                session.clients.add(websocket)
            return session

    async def _handle_zombie_session(self, key: tuple[str, str]) -> None:
        """Terminate a crashed session process and remove it from state."""
        lock = self._get_lock(key)
        async with lock:
            if key in self._sessions:
                zombie = self._sessions.pop(key)
                if zombie.process:
                    try:
                        zombie.process.terminate()
                    except OSError:
                        pass

    async def _schedule_teardown(self, websocket: WebSocket, key: tuple[str, str]) -> None:
        """Remove client and schedule the TTL teardown if the room is empty."""
        lock = self._get_lock(key)
        async with lock:
            session = self._sessions.get(key)
            if session and websocket in session.clients:
                session.clients.remove(websocket)

            if session and not session.clients:
                self._ttl_tasks[key] = asyncio.create_task(
                    self._deferred_cleanup(key[0], key[1])
                )

    @staticmethod
    async def _client_to_tinymist(
        websocket: WebSocket,
        data_ws: WebSocket,
        control_ws: WebSocket,
        bucket_dir: Path
    ) -> None:
        try:
            while True:  # pylint: disable=while-used
                msg = await websocket.receive()

                if msg.get("type") == "websocket.disconnect":
                    break

                await PreviewManager._route_client_message(msg, data_ws, control_ws, bucket_dir)

        except (WebSocketDisconnect, websockets.exceptions.ConnectionClosed):
            pass

    @staticmethod
    async def _route_client_message(
        msg: Mapping[str, Any],
        data_ws: WebSocket,
        control_ws: WebSocket,
        bucket_dir: Path
    ) -> None:
        """Route incoming browser messages to the correct Tinymist plane."""
        if msg.get("type") != "websocket.receive":
            return

        if msg.get("text") is not None:
            text = msg["text"]
            # Route JSON editor commands and scroll requests to Control Plane
            if (
                text.startswith('{')
                or 'panelScrollTo' in text
                or 'sourceScrollBy' in text
            ):
                try:
                    data = json.loads(text)
                except (json.JSONDecodeError, TypeError):
                    data = None

                if isinstance(data, dict) and "filepath" in data:
                    if not isinstance(data["filepath"], str):
                        return
                    candidate = (bucket_dir / data["filepath"]).resolve()
                    if not candidate.is_relative_to(bucket_dir.resolve()):
                        return
                    data["filepath"] = candidate.as_posix()
                    text = json.dumps(data)

                logger.info("📍 Client -> Control Plane : %s", text)
                await control_ws.send(text)
            else:
                # Route "current" and viewport requests to Data Plane
                logger.info("📍 Client -> Data Plane : %s", text)
                await data_ws.send(text)
        elif msg.get("bytes") is not None:
            await data_ws.send(msg["bytes"])

    @staticmethod
    async def _tinymist_data_to_client(websocket: WebSocket, data_ws) -> None:
        try:
            async for msg in data_ws:
                if isinstance(msg, bytes):
                    await websocket.send_bytes(msg)
                else:
                    logger.info("📍 Data Plane -> client : %s", msg)
                    await websocket.send_text(msg)
        except (WebSocketDisconnect, websockets.exceptions.ConnectionClosed):
            pass

    @staticmethod
    async def _tinymist_control_to_client(
        websocket: WebSocket,
        control_ws,
        bucket_dir: Path
    ) -> None:
        """Forward Control Plane events from Tinymist back to the client,
        normalizing absolute system paths to clean workspace-relative paths.
        """
        async for msg in control_ws:
            try:
                data = json.loads(msg)

                # Check if this control event carries a file path
                if "filepath" in data:
                    raw_path = Path(data["filepath"])
                    try:
                        rel_path = raw_path.relative_to(bucket_dir)
                        data["filepath"] = rel_path.as_posix()
                    except ValueError:
                        # Fallback if the file lies outside the bucket directory
                        data["filepath"] = raw_path.name

                    msg = json.dumps(data)
            except (json.JSONDecodeError, TypeError):
                pass

            logger.info("📍 Control Plane -> Client : %s", msg)
            await websocket.send_text(msg)

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
        session = PreviewSession(slug, path, data_port, control_port, bucket_dir)
        relative_entry = source.relative_to(bucket_dir).as_posix()

        env = os.environ.copy()
        env['XDG_CACHE_HOME'] = str(config.TINO_DATA_DIR / '.cache')

        cmd = [
            tinymist_bin, 'preview',
            '--no-open',
            '--data-plane-host', f'127.0.0.1:{data_port}',
            '--control-plane-host', f'127.0.0.1:{control_port}',
            '--root', str(bucket_dir),
            relative_entry  # <-- Use the normalized relative path here
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
            if not session or session.clients:
                return

            if session.process:
                try:
                    session.process.terminate()
                    await session.process.wait()
                except OSError:
                    logger.exception('Failed to terminate tinymist preview sidecar')

            del self._sessions[key]
            logger.info('Cleaned up Tinymist preview for %s/%s', slug, path)

    async def shutdown(self) -> None:
        """Cancel pending TTL tasks and flush all active sessions."""
        for task in self._ttl_tasks.values():
            task.cancel()
        self._ttl_tasks.clear()

        for key in list(self._sessions.keys()):
            session = self._sessions.get(key)
            if session and session.process:
                try:
                    session.process.terminate()
                    await session.process.wait()
                except OSError:
                    pass
        self._sessions.clear()
