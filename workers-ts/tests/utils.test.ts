import { beforeEach, describe, expect, it, vi } from "vitest";
import { badRequest, redirectWithQuery, resolveDateRange, toQueryString, unauthorized, validateAthleteId, validateDate } from "../src/utils.js";

describe("utils", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-20T12:00:00.000Z"));
  });

  it("resolves default date ranges from current time", () => {
    expect(resolveDateRange()).toEqual(["2026-02-18", "2026-03-20"]);
  });

  it("validates dates and athlete ids", () => {
    expect(validateDate("2026-03-20")).toBe("2026-03-20");
    expect(() => validateDate("03/20/2026")).toThrow("Invalid date format");
    expect(() => validateAthleteId("i12345")).not.toThrow();
    expect(() => validateAthleteId("athlete-1")).toThrow("ATHLETE_ID");
  });

  it("serializes query strings while skipping nullish values", () => {
    expect(toQueryString({ a: 1, b: undefined, c: "x y" })).toBe("?a=1&c=x+y");
  });

  it("builds redirect and error responses", async () => {
    const redirect = redirectWithQuery("https://example.test/callback", { code: "abc", state: "xyz" });
    expect(redirect.status).toBe(302);
    expect(redirect.headers.get("location")).toBe("https://example.test/callback?code=abc&state=xyz");

    const unauthorizedJson = await unauthorized("Nope").json();
    expect(unauthorizedJson).toEqual({ error: "unauthorized", error_description: "Nope" });

    const badRequestJson = await badRequest("Bad").json();
    expect(badRequestJson).toEqual({ error: "invalid_request", error_description: "Bad" });
  });
});

