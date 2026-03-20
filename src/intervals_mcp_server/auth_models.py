"""
Authentication and credential models for the Intervals MCP server.
"""

from __future__ import annotations

from dataclasses import dataclass

from mcp.server.auth.provider import AccessToken, AuthorizationCode, RefreshToken


@dataclass(slots=True)
class IntervalsCredentials:
    """Resolved Intervals.icu credentials for a user."""

    athlete_id: str
    api_key: str


class ServerAuthorizationCode(AuthorizationCode):
    """Authorization code enriched with user information."""

    user_id: str
    email: str | None = None


class ServerRefreshToken(RefreshToken):
    """Refresh token enriched with user information."""

    user_id: str
    resource: str | None = None


class ServerAccessToken(AccessToken):
    """Access token enriched with user and credential information."""

    user_id: str
    google_subject: str | None = None
    email: str | None = None
    intervals_athlete_id: str | None = None
    intervals_api_key: str | None = None
