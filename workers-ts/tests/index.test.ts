import { describe, expect, it } from "vitest";
import worker from "../src/index.js";
import { createEnv } from "./helpers/env.js";

describe("worker entrypoint", () => {
  it("returns 404 for unknown routes", async () => {
    const response = await worker.fetch(new Request("https://mcp.test/unknown"), createEnv({ GOOGLE_OAUTH_CLIENT_SECRET: undefined }));
    expect(response.status).toBe(404);
  });

  it("requires bearer auth for /mcp when auth is enabled", async () => {
    const response = await worker.fetch(new Request("https://mcp.test/mcp"), createEnv());
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: "unauthorized",
      error_description: "Bearer token required for MCP access.",
    });
  });
});
