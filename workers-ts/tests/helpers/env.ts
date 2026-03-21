import type { Env } from "../../src/types.js";
import { MockD1Database } from "./d1.js";

export function createEnv(overrides: Partial<Env> = {}): Env {
  return {
    DB: "DB" in overrides ? overrides.DB! : ((new MockD1Database() as unknown) as D1Database),
    API_KEY: "API_KEY" in overrides ? overrides.API_KEY : undefined,
    ATHLETE_ID: "ATHLETE_ID" in overrides ? overrides.ATHLETE_ID : undefined,
    INTERVALS_API_BASE_URL:
      "INTERVALS_API_BASE_URL" in overrides ? overrides.INTERVALS_API_BASE_URL : "https://intervals.test/api/v1",
    MCP_ISSUER_URL: "MCP_ISSUER_URL" in overrides ? overrides.MCP_ISSUER_URL : "https://mcp.test",
    MCP_RESOURCE_SERVER_URL:
      "MCP_RESOURCE_SERVER_URL" in overrides ? overrides.MCP_RESOURCE_SERVER_URL : "https://mcp.test/mcp",
    MCP_GOOGLE_CALLBACK_URL:
      "MCP_GOOGLE_CALLBACK_URL" in overrides
        ? overrides.MCP_GOOGLE_CALLBACK_URL
        : "https://mcp.test/oauth/google/callback",
    MCP_SERVICE_DOCUMENTATION_URL:
      "MCP_SERVICE_DOCUMENTATION_URL" in overrides
        ? overrides.MCP_SERVICE_DOCUMENTATION_URL
        : "https://example.test/docs",
    GOOGLE_OAUTH_CLIENT_ID:
      "GOOGLE_OAUTH_CLIENT_ID" in overrides ? overrides.GOOGLE_OAUTH_CLIENT_ID : "google-client-id",
    GOOGLE_OAUTH_CLIENT_SECRET:
      "GOOGLE_OAUTH_CLIENT_SECRET" in overrides
        ? overrides.GOOGLE_OAUTH_CLIENT_SECRET
        : "google-client-secret",
    MCP_ENCRYPTION_SECRET:
      "MCP_ENCRYPTION_SECRET" in overrides ? overrides.MCP_ENCRYPTION_SECRET : "test-encryption-secret",
  };
}
