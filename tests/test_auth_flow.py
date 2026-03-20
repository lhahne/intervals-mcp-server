"""
Tests for MCP auth and per-user credential resolution.
"""

from __future__ import annotations

import asyncio
import importlib
import os
import pathlib
import sys
from contextlib import contextmanager

import httpx

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "src"))

from mcp.server.auth.middleware.auth_context import auth_context_var
from mcp.server.auth.middleware.bearer_auth import AuthenticatedUser

from intervals_mcp_server.auth_models import IntervalsCredentials, ServerAccessToken
from intervals_mcp_server.auth_runtime import set_auth_repository
from intervals_mcp_server.auth_storage import create_sqlite_repository


@contextmanager
def _reloaded_server_with_auth(tmp_path):
    env_names = [
        "MCP_ISSUER_URL",
        "MCP_RESOURCE_SERVER_URL",
        "MCP_GOOGLE_CALLBACK_URL",
        "GOOGLE_OAUTH_CLIENT_ID",
        "GOOGLE_OAUTH_CLIENT_SECRET",
        "MCP_ENCRYPTION_SECRET",
        "MCP_AUTH_DB_PATH",
    ]
    old_env = {name: os.environ.get(name) for name in env_names}
    old_modules = {
        module_name: sys.modules.get(module_name)
        for module_name in [
            "intervals_mcp_server.auth_routes",
            "intervals_mcp_server.server",
            "intervals_mcp_server.mcp_instance",
        ]
    }

    os.environ["MCP_ISSUER_URL"] = "https://example.com"
    os.environ["MCP_RESOURCE_SERVER_URL"] = "https://example.com/mcp"
    os.environ["MCP_GOOGLE_CALLBACK_URL"] = "https://example.com/oauth/google/callback"
    os.environ["GOOGLE_OAUTH_CLIENT_ID"] = "google-client-id"
    os.environ["GOOGLE_OAUTH_CLIENT_SECRET"] = "google-client-secret"
    os.environ["MCP_ENCRYPTION_SECRET"] = "test-encryption-secret"
    os.environ["MCP_AUTH_DB_PATH"] = str(tmp_path / "auth.db")

    set_auth_repository(None)
    for module_name in old_modules:
        sys.modules.pop(module_name, None)

    try:
        server = importlib.import_module("intervals_mcp_server.server")
        bootstrap = importlib.import_module("intervals_mcp_server.auth_bootstrap")
        asyncio.run(bootstrap.ensure_local_auth_repository())
        yield server
    finally:
        set_auth_repository(None)
        for module_name, old_module in old_modules.items():
            sys.modules.pop(module_name, None)
            if old_module is not None:
                sys.modules[module_name] = old_module
        for name, value in old_env.items():
            if value is None:
                os.environ.pop(name, None)
            else:
                os.environ[name] = value


def test_streamable_http_requires_auth(tmp_path):
    with _reloaded_server_with_auth(tmp_path) as server:
        app = server.mcp.streamable_http_app()

        async def _run():
            transport = httpx.ASGITransport(app=app)
            async with httpx.AsyncClient(transport=transport, base_url="https://example.com") as client:
                return await client.post("/mcp", json={})

        response = asyncio.run(_run())
        assert response.status_code == 401
        assert 'error="invalid_token"' in response.headers["www-authenticate"]
        assert 'resource_metadata="https://example.com/.well-known/oauth-protected-resource/mcp"' in response.headers[
            "www-authenticate"
        ]


def test_protected_resource_metadata_endpoint_exists(tmp_path):
    with _reloaded_server_with_auth(tmp_path) as server:
        app = server.mcp.streamable_http_app()

        async def _run():
            transport = httpx.ASGITransport(app=app)
            async with httpx.AsyncClient(transport=transport, base_url="https://example.com") as client:
                return await client.get("/.well-known/oauth-protected-resource/mcp")

        response = asyncio.run(_run())
        body = response.json()
        assert response.status_code == 200
        assert body["resource"] == "https://example.com/mcp"
        assert body["authorization_servers"] == ["https://example.com/"]


def test_authenticated_request_uses_user_credentials(monkeypatch):
    from intervals_mcp_server.api.client import _prepare_request_config

    token = auth_context_var.set(
        AuthenticatedUser(
            ServerAccessToken(
                token="access-token",
                client_id="client-1",
                scopes=["mcp"],
                expires_at=9999999999,
                resource="https://example.com/mcp",
                user_id="user-1",
                intervals_athlete_id="i999",
                intervals_api_key="user-api-key",
            )
        )
    )
    try:
        full_url, auth, _headers, error = _prepare_request_config("/athlete/i999/events", None, "GET")
        assert error is None
        assert full_url.endswith("/athlete/i999/events")
        request = next(auth.auth_flow(httpx.Request("GET", full_url)))
        assert request.headers["Authorization"].startswith("Basic ")
    finally:
        auth_context_var.reset(token)


def test_credential_tools_roundtrip(tmp_path):
    repository = create_sqlite_repository(":memory:", "secret-key")
    asyncio.run(repository.initialize())
    user_id = asyncio.run(repository.upsert_user("google-subject", "athlete@example.com"))
    set_auth_repository(repository)

    auth_token = auth_context_var.set(
        AuthenticatedUser(
            ServerAccessToken(
                token="access-token",
                client_id="client-1",
                scopes=["mcp"],
                expires_at=9999999999,
                resource="https://example.com/mcp",
                user_id=user_id,
                email="athlete@example.com",
            )
        )
    )
    try:
        tools = importlib.import_module("intervals_mcp_server.tools.credentials")
        status_before = asyncio.run(tools.get_intervals_credentials_status())
        save_result = asyncio.run(tools.set_intervals_credentials("i42", "intervals-key"))
        status_after = asyncio.run(tools.get_intervals_credentials_status())
        saved = asyncio.run(repository.get_intervals_credentials(user_id))
        clear_result = asyncio.run(tools.clear_intervals_credentials())
        assert "not configured" in status_before
        assert "Saved Intervals.icu credentials" in save_result
        assert "athlete i42" in status_after
        assert clear_result == "Cleared your stored Intervals.icu credentials."
        assert saved == IntervalsCredentials(athlete_id="i42", api_key="intervals-key")
        assert asyncio.run(repository.get_intervals_credentials(user_id)) is None
    finally:
        auth_context_var.reset(auth_token)
        set_auth_repository(None)
