# Intervals.icu MCP Server for Cloudflare Workers

TypeScript port of the Python `intervals-mcp-server`, packaged separately for native Cloudflare Workers deployment.

## Usage

```bash
cd workers-ts
npm install
npm run check
npm run dev
```

Set the same Worker secrets used by the Python deployment:

- `DB`
- `MCP_ISSUER_URL`
- `MCP_RESOURCE_SERVER_URL`
- `MCP_GOOGLE_CALLBACK_URL`
- `GOOGLE_OAUTH_CLIENT_ID`
- `GOOGLE_OAUTH_CLIENT_SECRET`
- `MCP_ENCRYPTION_SECRET`

Optional local fallback credentials:

- `API_KEY`
- `ATHLETE_ID`
- `INTERVALS_API_BASE_URL`
