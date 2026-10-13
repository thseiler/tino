"""Language Server Protocol manager for Tinymist."""

import asyncio
import logging
import os
import re
import shutil
from pathlib import Path

from fastapi import WebSocket, WebSocketDisconnect

logger = logging.getLogger(__name__)


class LspManager:  # pylint: disable=too-few-public-methods
    """Manages background Tinymist LSP processes and proxies JSON-RPC messages."""

    def __init__(self, compiler, data_dir: Path | str):
        self.compiler = compiler
        self.data_dir = Path(data_dir)

    async def serve(self, websocket: WebSocket, slug: str) -> None:
        """Initialize the LSP process and start the bidirectional message bridge."""
        bucket_dir = self.data_dir / slug

        tinymist_bin = shutil.which('tinymist')
        if not tinymist_bin:
            logger.error("Tinymist binary not found in system PATH!")
            await websocket.close(code=1011, reason="LSP server not installed")
            return

        env = os.environ.copy()
        if self.compiler.package_dir:
            env['TYPST_PACKAGE_PATH'] = str(self.compiler.package_dir)
        if self.compiler.font_dir and self.compiler.font_dir.is_dir():
            env['TYPST_FONT_PATHS'] = str(self.compiler.font_dir)

        process = await asyncio.create_subprocess_exec(
            tinymist_bin, 'lsp',
            cwd=str(bucket_dir),
            env=env,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE
        )

        logger.info('Started Tinymist LSP for bucket: %s (PID %d)', slug, process.pid)

        async def _log_stderr():
            async for line in process.stderr:
                logger.warning('[TINYMIST LSP] %s', line.decode().strip())

        stderr_task = asyncio.create_task(_log_stderr())

        bucket_uri = bucket_dir.as_uri()
        bucket_uri_pattern = re.compile(re.escape(bucket_uri), re.IGNORECASE)

        try:
            await asyncio.gather(
                # Pass the translation variables into the read/write pipes
                LspManager._ws_to_stdin(websocket, process.stdin, bucket_uri),
                LspManager._stdout_to_ws(process.stdout, websocket, bucket_uri_pattern)
            )
        except (WebSocketDisconnect, ConnectionError, RuntimeError):
            pass
        finally:
            stderr_task.cancel()
            if process.returncode is None:
                try:
                    process.terminate()
                    await process.wait()
                except OSError:
                    pass
            logger.info('Cleaned up Tinymist LSP for bucket: %s', slug)

    @staticmethod
    async def _ws_to_stdin(websocket: WebSocket,
                           stdin: asyncio.StreamWriter,
                           bucket_uri: str) -> None:
        '''Read raw JSON from WebSocket, translate URI, wrap with header, write to stdin.'''

        while True:  # pylint: disable=while-used
            msg = await websocket.receive_text()

            # Swap placeholder for absolute URI
            msg = msg.replace('file:///@tino-workspace@', bucket_uri)

            encoded = msg.encode('utf-8')
            header = f"Content-Length: {len(encoded)}\r\n\r\n".encode('utf-8')
            stdin.write(header + encoded)
            await stdin.drain()

    @staticmethod
    async def _stdout_to_ws(stdout: asyncio.StreamReader,
                            websocket: WebSocket,
                            bucket_uri_pattern: re.Pattern) -> None:
        """Read LSP content, parse header, translate URI back to placeholder, send to WS."""
        content_length = 0

        async for line in stdout:
            line_str = line.decode('utf-8', errors='replace')

            if line_str.startswith('Content-Length:'):
                content_length = int(line_str.split(':')[1].strip())

            elif line_str == '\r\n':
                # Empty line means headers are done, body follows
                if content_length > 0:
                    body = await stdout.readexactly(content_length)
                    body_str = body.decode('utf-8')

                    # Swap real URI back to placeholder for the frontend
                    body_str = bucket_uri_pattern.sub('file:///@tino-workspace@', body_str)
                    await websocket.send_text(body_str)

                    # Reset for the next message
                    content_length = 0
