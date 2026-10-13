'''WebSocket endpoint for live WASM/Vector IR previews.'''

import logging

from fastapi import APIRouter, Depends, HTTPException, WebSocket

from ..auth import check_access, get_current_user
from ..dependencies import get_bucket_service, get_preview_manager
from ..models import User

logger = logging.getLogger(__name__)

router = APIRouter(prefix='/api/buckets/{slug}/preview', tags=['preview'])


@router.websocket('/{path:path}')
async def preview_websocket(
    websocket: WebSocket,
    slug: str,
    path: str,
    user: User = Depends(get_current_user)
):
    '''WebSocket endpoint for proxying binary Vector IR data from Tinymist.'''
    await websocket.accept()

    bucket = get_bucket_service().get(slug)

    if not bucket:
        await websocket.close(code=4004, reason='Bucket not found')
        return

    try:
        # Previews only require 'viewer' access
        check_access(user, bucket.access, 'viewer', slug)
    except HTTPException:
        await websocket.close(code=4403, reason='Viewer role required')
        return

    manager = get_preview_manager()
    logger.info('Preview session started: %s/%s (user: %s)', slug, path, user.username)
    await manager.serve(websocket, slug, path)
    logger.info('Preview session ended: %s/%s (user: %s)', slug, path, user.username)
