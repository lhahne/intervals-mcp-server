import { describe, expect, it } from "vitest";
import type { RequestContext } from "../src/types.js";
import { authEnabled, localFallbackCredentials, requireEnv, resolveRequestCredentials } from "../src/config.js";
import { createEnv } from "./helpers/env.js";

describe("config", () => {
  it("detects when auth is fully configured", () => {
    expect(authEnabled(createEnv())).toBe(true);
    expect(authEnabled(createEnv({ GOOGLE_OAUTH_CLIENT_SECRET: undefined }))).toBe(false);
  });

  it("returns required env vars and throws when missing", () => {
    const env = createEnv();
    expect(requireEnv(env, "MCP_ISSUER_URL")).toBe("https://mcp.test");
    expect(() => requireEnv(createEnv({ MCP_ISSUER_URL: undefined }), "MCP_ISSUER_URL")).toThrow("Missing required environment variable");
  });

  it("resolves local fallback credentials", () => {
    expect(localFallbackCredentials(createEnv({ API_KEY: " key ", ATHLETE_ID: "i123" }))).toEqual({
      apiKey: "key",
      athleteId: "i123",
    });
  });

  it("prefers auth extras over local fallbacks", () => {
    const context: RequestContext = {
      env: createEnv({ API_KEY: "fallback", ATHLETE_ID: "i1" }),
      auth: {
        token: "t",
        clientId: "c",
        scopes: ["mcp"],
        extra: {
          userId: "u1",
          email: "test@example.com",
          intervalsAthleteId: "i99",
          intervalsApiKey: "override",
        },
      },
    };
    expect(resolveRequestCredentials(context)).toEqual({
      athleteId: "i99",
      apiKey: "override",
      userId: "u1",
      email: "test@example.com",
    });
  });
});

