"""
Shared MCP instance module.

This module provides a shared FastMCP instance that can be imported by both
the server module and tool modules without creating cyclic imports.
"""

from __future__ import annotations

import os

from mcp.server.fastmcp import FastMCP  # pylint: disable=import-error
from mcp.server.auth.settings import AuthSettings, ClientRegistrationOptions, RevocationOptions

from intervals_mcp_server.api.client import setup_api_client
from intervals_mcp_server.auth_provider import provider


def _build_auth_settings() -> AuthSettings | None:
    issuer_url = os.getenv("MCP_ISSUER_URL")
    resource_server_url = os.getenv("MCP_RESOURCE_SERVER_URL")
    if not issuer_url or not resource_server_url:
        return None
    return AuthSettings(
        issuer_url=issuer_url,
        resource_server_url=resource_server_url,
        service_documentation_url=os.getenv("MCP_SERVICE_DOCUMENTATION_URL"),
        required_scopes=["mcp"],
        client_registration_options=ClientRegistrationOptions(
            enabled=True,
            default_scopes=["mcp"],
            valid_scopes=["mcp"],
        ),
        revocation_options=RevocationOptions(enabled=True),
    )


_auth_settings = _build_auth_settings()

mcp: FastMCP = FastMCP(  # pylint: disable=invalid-name
    "intervals-icu",
    lifespan=setup_api_client,
    auth_server_provider=provider if _auth_settings else None,
    auth=_auth_settings,
)
