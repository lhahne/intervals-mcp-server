"""
Cloudflare Worker entrypoint for the authenticated streamable HTTP deployment.
"""

from __future__ import annotations

import os

import asgi
from workers import WorkerEntrypoint

from intervals_mcp_server.auth_runtime import set_auth_repository
from intervals_mcp_server.auth_storage import CloudflareD1AuthRepository

_worker_app = None


def _sync_env(env) -> None:
    os.environ["MCP_ISSUER_URL"] = env.MCP_ISSUER_URL
    os.environ["MCP_RESOURCE_SERVER_URL"] = env.MCP_RESOURCE_SERVER_URL
    os.environ["MCP_GOOGLE_CALLBACK_URL"] = env.MCP_GOOGLE_CALLBACK_URL
    os.environ["GOOGLE_OAUTH_CLIENT_ID"] = env.GOOGLE_OAUTH_CLIENT_ID
    os.environ["GOOGLE_OAUTH_CLIENT_SECRET"] = env.GOOGLE_OAUTH_CLIENT_SECRET
    os.environ["MCP_ENCRYPTION_SECRET"] = env.MCP_ENCRYPTION_SECRET
    if getattr(env, "MCP_SERVICE_DOCUMENTATION_URL", None):
        os.environ["MCP_SERVICE_DOCUMENTATION_URL"] = env.MCP_SERVICE_DOCUMENTATION_URL


async def _build_worker_app(env):
    _sync_env(env)
    repository = CloudflareD1AuthRepository(env.DB, env.MCP_ENCRYPTION_SECRET)
    await repository.initialize()
    set_auth_repository(repository)

    from intervals_mcp_server.server import mcp

    return mcp.streamable_http_app()


class Default(WorkerEntrypoint):
    """Cloudflare Worker fetch handler."""

    async def fetch(self, request):
        global _worker_app  # pylint: disable=global-statement  # noqa: PLW0603
        if _worker_app is None:
            _worker_app = await _build_worker_app(self.env)
        return await asgi.fetch(_worker_app, request, self.env)
