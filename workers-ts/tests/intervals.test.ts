import { afterEach, describe, expect, it, vi } from "vitest";
import { makeIntervalsRequest, requireAthleteId, summarizeCollection, summarizeObject } from "../src/intervals.js";
import type { RequestContext } from "../src/types.js";
import { createEnv } from "./helpers/env.js";

describe("intervals client", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("requires an athlete id when missing", () => {
    expect(() => requireAthleteId()).toThrow("No athlete ID is configured");
  });

  it("returns a configuration error without an api key", async () => {
    const result = await makeIntervalsRequest(
      { env: createEnv({ API_KEY: undefined }) },
      "/athlete/i1",
    );
    expect(result).toEqual({
      error: true,
      message:
        "API key is required. Use set_intervals_credentials for authenticated access or configure API_KEY for local development.",
    });
  });

  it("sends requests with headers, params, and body", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    globalThis.fetch = fetchMock as typeof fetch;
    const context: RequestContext = { env: createEnv({ API_KEY: "abc" }) };

    const result = await makeIntervalsRequest(context, "/athlete/i1/events", {
      method: "POST",
      params: { oldest: "2026-03-01", newest: "2026-03-10" },
      data: { name: "Workout" },
    });

    expect(result).toEqual({ ok: true });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://intervals.test/api/v1/athlete/i1/events?oldest=2026-03-01&newest=2026-03-10");
    expect(init.method).toBe("POST");
    expect(init.headers).toBeInstanceOf(Headers);
    expect((init.headers as Headers).get("authorization")).toBe(`Basic ${btoa("API_KEY:abc")}`);
    expect(init.body).toBe(JSON.stringify({ name: "Workout" }));
  });

  it("maps server-side status codes to user-facing messages", async () => {
    globalThis.fetch = vi.fn(async () => new Response("nope", { status: 401, statusText: "Unauthorized" })) as typeof fetch;
    const result = await makeIntervalsRequest({ env: createEnv({ API_KEY: "abc" }) }, "/activity/1");
    expect(result).toEqual({
      error: true,
      statusCode: 401,
      message: "401 Unauthorized: Please check your API key.",
    });
  });

  it("reports network errors", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("network down");
    }) as typeof fetch;
    const result = await makeIntervalsRequest({ env: createEnv({ API_KEY: "abc" }) }, "/activity/1");
    expect(result).toEqual({
      error: true,
      message: "Request error: network down",
    });
  });

  it("summarizes objects and collections", () => {
    expect(summarizeObject({ id: 1, name: "Ride", nested: { watts: 250 } }, ["name", "id"])).toContain("name: Ride");
    expect(summarizeCollection("Activities", [{ id: 1, name: "Ride" }], ["name"])).toContain("Activities:");
  });
});

