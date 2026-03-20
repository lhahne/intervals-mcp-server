"""
Runtime service registry for authentication-related components.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from intervals_mcp_server.auth_storage import AuthRepository


_auth_repository: AuthRepository | None = None


def set_auth_repository(repository: AuthRepository | None) -> None:
    """Set the active authentication repository."""
    global _auth_repository  # pylint: disable=global-statement  # noqa: PLW0603
    _auth_repository = repository


def get_auth_repository() -> AuthRepository | None:
    """Return the active authentication repository, if configured."""
    return _auth_repository
