'''WebSocket endpoint for language server protocol.'''


import logging

from fastapi import APIRouter, Depends, WebSocket

from tino.dependencies import get_lsp_manager, require_viewer
from tino.lsp import LspManager
from tino.models import User

logger = logging.getLogger(__name__)
router = APIRouter(tags=['lsp'])


@router.websocket('/api/buckets/{slug}/lsp')
async def lsp_websocket(
    websocket: WebSocket,
    slug: str,
    user: User = Depends(require_viewer),
    manager: LspManager = Depends(get_lsp_manager)
):
    '''Bridge for CodeMirror LSP client to Tinymist.'''
    await websocket.accept()
    logger.info('LSP session started: %s (user: %s)', slug, user.username)

    try:
        await manager.serve(websocket, slug)
    finally:
        logger.info('LSP session ended: %s (user: %s)', slug, user.username)
