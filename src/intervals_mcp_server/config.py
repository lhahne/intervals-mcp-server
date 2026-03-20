"""
Configuration management for Intervals.icu MCP Server.

This module handles loading configuration from environment variables and
resolving request-scoped Intervals credentials when the server is running
behind MCP authentication.
"""

from __future__ import annotations

import os

from intervals_mcp_server.current_user import get_current_intervals_credentials
from intervals_mcp_server.utils.validation import validate_athlete_id

# Try to load environment variables from .env file if it exists
try:
    from dotenv import load_dotenv

    _ = load_dotenv()
except ImportError:
    pass


class Config:
    """Configuration settings for the Intervals.icu MCP Server."""

    def __init__(
        self,
        env_api_key: str | None = None,
        env_athlete_id: str | None = None,
        intervals_api_base_url: str = "https://intervals.icu/api/v1",
        user_agent: str = "intervalsicu-mcp-server/1.0",
        api_key: str | None = None,
        athlete_id: str | None = None,
    ) -> None:
        self._env_api_key = env_api_key if env_api_key is not None else (api_key or "")
        self._env_athlete_id = (
            env_athlete_id if env_athlete_id is not None else (athlete_id or "")
        )
        self.intervals_api_base_url = intervals_api_base_url
        self.user_agent = user_agent

    @property
    def api_key(self) -> str:
        credentials = get_current_intervals_credentials()
        if credentials is not None:
            return credentials.api_key
        return self._env_api_key

    @api_key.setter
    def api_key(self, value: str) -> None:
        self._env_api_key = value

    @property
    def athlete_id(self) -> str:
        credentials = get_current_intervals_credentials()
        if credentials is not None:
            return credentials.athlete_id
        return self._env_athlete_id

    @athlete_id.setter
    def athlete_id(self, value: str) -> None:
        self._env_athlete_id = value

    @property
    def env_api_key(self) -> str:
        """Return the local-development fallback API key."""
        return self._env_api_key

    @property
    def env_athlete_id(self) -> str:
        """Return the local-development fallback athlete id."""
        return self._env_athlete_id

    @property
    def auth_enabled(self) -> bool:
        return bool(
            os.getenv("MCP_ISSUER_URL")
            and os.getenv("MCP_RESOURCE_SERVER_URL")
            and os.getenv("GOOGLE_OAUTH_CLIENT_ID")
            and os.getenv("GOOGLE_OAUTH_CLIENT_SECRET")
        )


_config_instance: Config | None = None


def load_config() -> Config:
    """Load configuration from environment variables."""
    api_key = os.getenv("API_KEY", "")
    athlete_id = os.getenv("ATHLETE_ID", "")
    intervals_api_base_url = os.getenv("INTERVALS_API_BASE_URL", "https://intervals.icu/api/v1")
    user_agent = "intervalsicu-mcp-server/1.0"

    if athlete_id:
        validate_athlete_id(athlete_id)

    return Config(
        env_api_key=api_key,
        env_athlete_id=athlete_id,
        intervals_api_base_url=intervals_api_base_url,
        user_agent=user_agent,
    )


def get_config() -> Config:
    """Return the singleton configuration instance."""
    global _config_instance  # pylint: disable=global-statement  # noqa: PLW0603
    if _config_instance is None:
        _config_instance = load_config()
    return _config_instance
