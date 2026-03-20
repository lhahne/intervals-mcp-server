"""
Helpers for resolving the authenticated MCP user.
"""

from __future__ import annotations

from mcp.server.auth.middleware.auth_context import get_access_token

from intervals_mcp_server.auth_models import IntervalsCredentials, ServerAccessToken


def get_current_access_token() -> ServerAccessToken | None:
    """Return the authenticated access token for the current request, if any."""
    token = get_access_token()
    if isinstance(token, ServerAccessToken):
        return token
    return None


def get_current_user_id() -> str | None:
    """Return the authenticated user id for the current request, if any."""
    token = get_current_access_token()
    return token.user_id if token else None


def get_current_intervals_credentials() -> IntervalsCredentials | None:
    """Return the authenticated user's Intervals credentials, if available."""
    token = get_current_access_token()
    if not token or not token.intervals_api_key or not token.intervals_athlete_id:
        return None
    return IntervalsCredentials(
        athlete_id=token.intervals_athlete_id,
        api_key=token.intervals_api_key,
    )
