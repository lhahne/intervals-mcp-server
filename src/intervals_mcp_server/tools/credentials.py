"""
Credential-management tools for per-user Intervals.icu settings.
"""

from __future__ import annotations

from intervals_mcp_server.auth_models import IntervalsCredentials
from intervals_mcp_server.auth_runtime import get_auth_repository
from intervals_mcp_server.current_user import get_current_intervals_credentials, get_current_user_id
from intervals_mcp_server.mcp_instance import mcp
from intervals_mcp_server.utils.validation import validate_athlete_id


def _require_user_id() -> str | None:
    return get_current_user_id()


@mcp.tool()
async def get_intervals_credentials_status() -> str:
    """Return whether the authenticated user has configured Intervals.icu credentials."""
    user_id = _require_user_id()
    repository = get_auth_repository()
    if user_id is None or repository is None:
        return "Credential management requires authenticated MCP access."

    credentials = get_current_intervals_credentials() or await repository.get_intervals_credentials(user_id)
    if credentials is None:
        return "Intervals.icu credentials are not configured for your account."
    return f"Intervals.icu credentials are configured for athlete {credentials.athlete_id}."


@mcp.tool()
async def set_intervals_credentials(
    athlete_id: str,
    api_key: str,
) -> str:
    """Store or update the authenticated user's Intervals.icu credentials."""
    user_id = _require_user_id()
    repository = get_auth_repository()
    if user_id is None or repository is None:
        return "Credential management requires authenticated MCP access."

    try:
        validate_athlete_id(athlete_id)
    except ValueError as exc:
        return f"Error: {exc}"
    if not api_key.strip():
        return "Error: api_key must not be empty."

    await repository.set_intervals_credentials(
        user_id,
        IntervalsCredentials(athlete_id=athlete_id, api_key=api_key.strip()),
    )
    return f"Saved Intervals.icu credentials for athlete {athlete_id}."


@mcp.tool()
async def clear_intervals_credentials() -> str:
    """Delete the authenticated user's stored Intervals.icu credentials."""
    user_id = _require_user_id()
    repository = get_auth_repository()
    if user_id is None or repository is None:
        return "Credential management requires authenticated MCP access."
    await repository.clear_intervals_credentials(user_id)
    return "Cleared your stored Intervals.icu credentials."
