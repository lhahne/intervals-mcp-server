# Deploying To Cloudflare Workers With Google SSO

This guide explains how to deploy the merged `main` branch to Cloudflare Workers, set up D1, and configure Google SSO for MCP authentication.

## Assumptions

- You want a production URL like `https://mcp.example.com`
- You want any Google account to be able to sign in
- You want ChatGPT to connect to `https://mcp.example.com/mcp`
- You will use Cloudflare D1 for auth, token, user, and per-user Intervals credential storage

## 1. Pull `main` and prepare the repo

```bash
git checkout main
git pull
cd intervals-mcp-server
uv sync
```

### Add the Cloudflare Python Worker runtime tools

The merged code includes the Worker entrypoint at `src/intervals_mcp_server/worker.py`, but the repo still needs the Cloudflare Python runtime tooling installed locally:

```bash
uv add --dev workers-py workers-runtime-sdk
```

## 2. Create a Wrangler config

Create `wrangler.toml` at the repo root:

```toml
name = "intervals-mcp"
main = "src/intervals_mcp_server/worker.py"
compatibility_date = "2026-03-20"
compatibility_flags = ["python_workers"]
workers_dev = true

[vars]
MCP_ISSUER_URL = "https://mcp.example.com"
MCP_RESOURCE_SERVER_URL = "https://mcp.example.com/mcp"
MCP_GOOGLE_CALLBACK_URL = "https://mcp.example.com/oauth/google/callback"
MCP_SERVICE_DOCUMENTATION_URL = "https://github.com/lhahne/intervals-mcp-server"

[[d1_databases]]
binding = "DB"
database_name = "intervals-mcp-prod"
database_id = "REPLACE_ME"
preview_database_id = "REPLACE_ME"
```

Use these exact meanings:

- `MCP_ISSUER_URL`: OAuth server base URL
- `MCP_RESOURCE_SERVER_URL`: MCP resource URL, expected to be `/mcp`
- `MCP_GOOGLE_CALLBACK_URL`: must exactly match the Google callback route

## 3. Create the D1 database

```bash
npx wrangler d1 create intervals-mcp-prod
```

Optional regional placement:

```bash
npx wrangler d1 create intervals-mcp-prod --location=weur
```

Paste the returned `database_id` into `wrangler.toml`.

## 4. Initialize the schema

Apply the schema from `cloudflare/schema.sql`:

```bash
npx wrangler d1 execute intervals-mcp-prod --remote --file cloudflare/schema.sql
```

This creates:

- `users`
- `oauth_sessions`
- `oauth_clients`
- `authorization_codes`
- `access_tokens`
- `refresh_tokens`
- `intervals_credentials`

## 5. Create the Google OAuth app

In Google Cloud Console:

1. Create a new Google Cloud project for production.
2. Configure the OAuth consent screen.
3. Choose `External` if any Google account should work.
4. Set app name, support email, and developer contact email.
5. Add scopes:
   - `openid`
   - `email`
   - `profile`
6. Create OAuth credentials of type `Web application`.
7. Add this exact redirect URI:

```text
https://mcp.example.com/oauth/google/callback
```

Important:

- It must match exactly, including scheme and trailing slash behavior.
- Use HTTPS in production.
- Use a separate Google Cloud project for production.

## 6. Decide your production domain

Recommended:

- Worker host: `mcp.example.com`
- MCP endpoint: `https://mcp.example.com/mcp`
- Google callback: `https://mcp.example.com/oauth/google/callback`

## 7. Set Cloudflare secrets

```bash
npx wrangler secret put GOOGLE_OAUTH_CLIENT_ID
npx wrangler secret put GOOGLE_OAUTH_CLIENT_SECRET
npx wrangler secret put MCP_ENCRYPTION_SECRET
```

Generate `MCP_ENCRYPTION_SECRET` with something like:

```bash
openssl rand -base64 32
```

## 8. Deploy the Worker

```bash
uv run pywrangler deploy
```

## 9. Attach the custom domain

Attach `mcp.example.com` to the Worker in the Cloudflare dashboard or add this to `wrangler.toml`:

```toml
[[routes]]
pattern = "mcp.example.com"
custom_domain = true
```

Then redeploy.

## 10. Verify the auth endpoints

Check these URLs:

```text
https://mcp.example.com/.well-known/oauth-authorization-server
https://mcp.example.com/.well-known/oauth-protected-resource/mcp
https://mcp.example.com/authorize
https://mcp.example.com/token
https://mcp.example.com/register
https://mcp.example.com/revoke
```

Expected behavior:

- metadata endpoints return JSON
- `/mcp` without auth returns `401`
- the `WWW-Authenticate` header includes `resource_metadata=...`

## 11. Connect ChatGPT

In ChatGPT custom MCP connectors:

- Server URL: `https://mcp.example.com/mcp`
- Authentication: OAuth

## 12. First user sign-in flow

1. ChatGPT connects to `https://mcp.example.com/mcp`
2. The server challenges with MCP OAuth
3. The client follows the auth metadata
4. The user signs in with Google
5. The callback lands on `https://mcp.example.com/oauth/google/callback`
6. The server issues MCP access and refresh tokens
7. The user is authenticated but still has no Intervals credentials yet

## 13. Tell users how to configure Intervals.icu

After Google sign-in, each user must provide:

- their Intervals athlete ID
- their Intervals API key

Useful tools:

- `set_intervals_credentials`
- `get_intervals_credentials_status`
- `clear_intervals_credentials`

## 14. Recommended production checklist

- Use a dedicated production Google Cloud project
- Use a custom domain you own
- Ensure the callback URI in Google exactly matches `MCP_GOOGLE_CALLBACK_URL`
- Add a public homepage and privacy policy in the Google consent screen
- Confirm D1 schema is applied remotely
- Confirm Worker secrets are set
- Confirm `/mcp` returns `401` when unauthenticated
- Confirm the OAuth metadata endpoints are reachable
- Test sign-in with one Google account
- Test `set_intervals_credentials`
- Test one read tool and one write tool against Intervals.icu

## 15. Common failure modes

### `redirect_uri_mismatch`

- The Google Console redirect URI does not exactly match `MCP_GOOGLE_CALLBACK_URL`
- Check scheme, host, path, and trailing slash

### Google sign-in works, but MCP requests still fail

- `MCP_ISSUER_URL` or `MCP_RESOURCE_SERVER_URL` is wrong
- You used a different public URL in ChatGPT than the Worker is advertising

### User signs in, but Intervals tools fail

- They have not run `set_intervals_credentials` yet
- Or the stored athlete ID or API key is wrong

### Worker deploy fails

- `workers-py` or `workers-runtime-sdk` not installed locally
- Missing `python_workers` compatibility flag
- Missing `DB` binding in Wrangler config

### D1 errors on startup

- `cloudflare/schema.sql` was never applied
- Wrong `database_id` in `wrangler.toml`

## 16. Minimal working values

If your domain is `mcp.example.com`, use exactly these:

```text
MCP_ISSUER_URL=https://mcp.example.com
MCP_RESOURCE_SERVER_URL=https://mcp.example.com/mcp
MCP_GOOGLE_CALLBACK_URL=https://mcp.example.com/oauth/google/callback
```

And in Google OAuth:

```text
Authorized redirect URI:
https://mcp.example.com/oauth/google/callback
```

## Sources

- https://developers.cloudflare.com/workers/languages/python/
- https://developers.cloudflare.com/workers/languages/python/packages/
- https://developers.cloudflare.com/workers/wrangler/configuration/
- https://developers.cloudflare.com/d1/get-started/
- https://developers.cloudflare.com/d1/reference/migrations/
- https://developers.cloudflare.com/d1/wrangler-commands/
- https://developers.cloudflare.com/workers/configuration/secrets/
- https://developers.cloudflare.com/workers/configuration/routing/custom-domains/
- https://developers.google.com/identity/protocols/oauth2/web-server
- https://developers.google.com/identity/protocols/oauth2/production-readiness/policy-compliance
