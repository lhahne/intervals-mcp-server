"""
Public auth callback routes.
"""

from intervals_mcp_server.auth_provider import handle_google_callback
from intervals_mcp_server.mcp_instance import mcp


@mcp.custom_route("/oauth/google/callback", methods=["GET"], include_in_schema=False)
async def google_oauth_callback(request):
    """Handle the Google OAuth callback."""
    return await handle_google_callback(request)
