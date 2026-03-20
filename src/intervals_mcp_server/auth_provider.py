"""
OAuth provider and Google callback flow for MCP authentication.
"""

from __future__ import annotations

import logging
import os
import time
from urllib.parse import urlencode

from mcp.server.auth.provider import AuthorizeError, OAuthToken
from mcp.shared.auth import OAuthClientInformationFull
from starlette.requests import Request
from starlette.responses import JSONResponse, RedirectResponse, Response

from intervals_mcp_server.auth_models import (
    ServerAccessToken,
    ServerAuthorizationCode,
    ServerRefreshToken,
)
from intervals_mcp_server.auth_runtime import get_auth_repository
from intervals_mcp_server.auth_storage import OAuthSession
from intervals_mcp_server.google_oauth import (
    build_google_authorization_url,
    exchange_google_code,
    fetch_google_userinfo,
)
from intervals_mcp_server.security import generate_token

logger = logging.getLogger("intervals_icu_mcp_server")

AUTH_CODE_TTL_SECONDS = 300
ACCESS_TOKEN_TTL_SECONDS = 3600
REFRESH_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30


def _required_env(name: str) -> str:
    value = os.getenv(name, "").strip()
    if not value:
        raise RuntimeError(f"Missing required auth environment variable: {name}")
    return value


def _google_callback_url() -> str:
    return _required_env("MCP_GOOGLE_CALLBACK_URL")


def _resource_url() -> str:
    return _required_env("MCP_RESOURCE_SERVER_URL")


class IntervalsOAuthProvider:
    """MCP OAuth server provider backed by the configured auth repository."""

    async def get_client(self, client_id: str) -> OAuthClientInformationFull | None:
        repository = get_auth_repository()
        if repository is None:
            return None
        return await repository.get_client(client_id)

    async def register_client(self, client_info: OAuthClientInformationFull) -> None:
        repository = get_auth_repository()
        if repository is None:
            raise RuntimeError("Auth repository is not configured.")
        await repository.save_client(client_info)

    async def authorize(
        self,
        client: OAuthClientInformationFull,
        params,
    ) -> str:
        repository = get_auth_repository()
        if repository is None:
            raise RuntimeError("Auth repository is not configured.")

        if params.resource and params.resource != _resource_url():
            raise AuthorizeError("invalid_request", "Unsupported resource indicator.")

        state = generate_token(24)
        await repository.create_oauth_session(
            OAuthSession(
                state=state,
                client_id=client.client_id or "",
                redirect_uri=str(params.redirect_uri),
                redirect_uri_provided_explicitly=params.redirect_uri_provided_explicitly,
                code_challenge=params.code_challenge,
                scopes=params.scopes or ["mcp"],
                resource=params.resource or _resource_url(),
                expires_at=int(time.time()) + AUTH_CODE_TTL_SECONDS,
            )
        )
        return build_google_authorization_url(
            client_id=_required_env("GOOGLE_OAUTH_CLIENT_ID"),
            redirect_uri=_google_callback_url(),
            state=state,
        )

    async def load_authorization_code(
        self,
        client: OAuthClientInformationFull,
        authorization_code: str,
    ) -> ServerAuthorizationCode | None:
        repository = get_auth_repository()
        if repository is None:
            return None
        return await repository.pop_authorization_code(client.client_id or "", authorization_code)

    async def exchange_authorization_code(
        self,
        client: OAuthClientInformationFull,
        authorization_code: ServerAuthorizationCode,
    ) -> OAuthToken:
        repository = get_auth_repository()
        if repository is None:
            raise RuntimeError("Auth repository is not configured.")

        access_token = ServerAccessToken(
            token=generate_token(32),
            client_id=client.client_id or "",
            scopes=authorization_code.scopes,
            expires_at=int(time.time()) + ACCESS_TOKEN_TTL_SECONDS,
            resource=authorization_code.resource or _resource_url(),
            user_id=authorization_code.user_id,
            email=authorization_code.email,
        )
        refresh_token = ServerRefreshToken(
            token=generate_token(32),
            client_id=client.client_id or "",
            scopes=authorization_code.scopes,
            expires_at=int(time.time()) + REFRESH_TOKEN_TTL_SECONDS,
            user_id=authorization_code.user_id,
            resource=authorization_code.resource or _resource_url(),
        )
        await repository.save_access_token(access_token)
        await repository.save_refresh_token(refresh_token)
        return OAuthToken(
            access_token=access_token.token,
            expires_in=ACCESS_TOKEN_TTL_SECONDS,
            scope=" ".join(access_token.scopes),
            refresh_token=refresh_token.token,
        )

    async def load_refresh_token(
        self,
        client: OAuthClientInformationFull,
        refresh_token: str,
    ) -> ServerRefreshToken | None:
        repository = get_auth_repository()
        if repository is None:
            return None
        return await repository.pop_refresh_token(client.client_id or "", refresh_token)

    async def exchange_refresh_token(
        self,
        client: OAuthClientInformationFull,
        refresh_token: ServerRefreshToken,
        scopes: list[str],
    ) -> OAuthToken:
        repository = get_auth_repository()
        if repository is None:
            raise RuntimeError("Auth repository is not configured.")

        new_access_token = ServerAccessToken(
            token=generate_token(32),
            client_id=client.client_id or "",
            scopes=scopes,
            expires_at=int(time.time()) + ACCESS_TOKEN_TTL_SECONDS,
            resource=refresh_token.resource or _resource_url(),
            user_id=refresh_token.user_id,
        )
        new_refresh_token = ServerRefreshToken(
            token=generate_token(32),
            client_id=client.client_id or "",
            scopes=scopes,
            expires_at=int(time.time()) + REFRESH_TOKEN_TTL_SECONDS,
            resource=refresh_token.resource or _resource_url(),
            user_id=refresh_token.user_id,
        )
        await repository.save_access_token(new_access_token)
        await repository.save_refresh_token(new_refresh_token)
        return OAuthToken(
            access_token=new_access_token.token,
            expires_in=ACCESS_TOKEN_TTL_SECONDS,
            scope=" ".join(scopes),
            refresh_token=new_refresh_token.token,
        )

    async def load_access_token(self, token: str) -> ServerAccessToken | None:
        repository = get_auth_repository()
        if repository is None:
            return None
        access_token = await repository.get_access_token(token)
        if access_token is None:
            return None
        if access_token.resource and access_token.resource != _resource_url():
            return None
        return access_token

    async def revoke_token(self, token) -> None:
        repository = get_auth_repository()
        if repository is None:
            return
        await repository.revoke_token(token.token)


provider = IntervalsOAuthProvider()


async def handle_google_callback(request: Request) -> Response:
    """Complete the Google OAuth flow and redirect back to the MCP client."""
    repository = get_auth_repository()
    if repository is None:
        return JSONResponse({"error": "server_error", "message": "Auth repository not configured"}, status_code=500)

    if request.query_params.get("error"):
        return JSONResponse(
            {
                "error": request.query_params.get("error"),
                "error_description": request.query_params.get("error_description"),
            },
            status_code=400,
        )

    state = request.query_params.get("state", "")
    code = request.query_params.get("code", "")
    if not state or not code:
        return JSONResponse({"error": "invalid_request", "message": "Missing code or state."}, status_code=400)

    session = await repository.pop_oauth_session(state)
    if session is None:
        return JSONResponse({"error": "invalid_request", "message": "Unknown or expired session."}, status_code=400)

    try:
        google_tokens = await exchange_google_code(
            code=code,
            client_id=_required_env("GOOGLE_OAUTH_CLIENT_ID"),
            client_secret=_required_env("GOOGLE_OAUTH_CLIENT_SECRET"),
            redirect_uri=_google_callback_url(),
        )
        google_profile = await fetch_google_userinfo(google_tokens["access_token"])
    except Exception as exc:  # pylint: disable=broad-exception-caught
        logger.error("Google OAuth callback failed: %s", exc, exc_info=True)
        return JSONResponse({"error": "server_error", "message": "Google sign-in failed."}, status_code=502)

    google_subject = google_profile.get("sub")
    if not google_subject:
        return JSONResponse({"error": "server_error", "message": "Google user profile missing subject."}, status_code=502)

    user_id = await repository.upsert_user(google_subject=google_subject, email=google_profile.get("email"))
    authorization_code = ServerAuthorizationCode(
        code=generate_token(24),
        user_id=user_id,
        email=google_profile.get("email"),
        scopes=session.scopes,
        expires_at=float(int(time.time()) + AUTH_CODE_TTL_SECONDS),
        client_id=session.client_id,
        code_challenge=session.code_challenge,
        redirect_uri=session.redirect_uri,
        redirect_uri_provided_explicitly=session.redirect_uri_provided_explicitly,
        resource=session.resource,
    )
    await repository.save_authorization_code(authorization_code)

    query = urlencode({"code": authorization_code.code, "state": session.state})
    return RedirectResponse(url=f"{session.redirect_uri}?{query}", status_code=302)
