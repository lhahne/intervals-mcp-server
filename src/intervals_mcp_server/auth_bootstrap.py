"""
Bootstrap helpers for authentication services.
"""

from __future__ import annotations

import os

from intervals_mcp_server.auth_runtime import get_auth_repository, set_auth_repository
from intervals_mcp_server.auth_storage import create_sqlite_repository


async def ensure_local_auth_repository() -> None:
    """Create and initialize the local auth repository if auth is enabled."""
    if get_auth_repository() is not None:
        return

    encryption_secret = os.getenv("MCP_ENCRYPTION_SECRET", "").strip()
    db_path = os.getenv("MCP_AUTH_DB_PATH", ".local/auth.db").strip()
    if not encryption_secret:
        return

    repository = create_sqlite_repository(db_path=db_path, encryption_secret=encryption_secret)
    await repository.initialize()
    set_auth_repository(repository)
