import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/types.js";
import { D1AuthRepository } from "../src/repository.js";
import { handleOAuthRoute, verifyBearerToken } from "../src/oauth.js";
import { sha256Base64Url } from "../src/security.js";
import { createEnv } from "./helpers/env.js";
import { MockD1Database } from "./helpers/d1.js";

vi.mock("../src/googleOAuth.js", () => ({
  buildGoogleAuthorizationUrl: vi.fn((clientId: string, redirectUri: string, state: string) => {
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("state", state);
    return url.toString();
  }),
  exchangeGoogleCode: vi.fn(async () => ({ access_token: "google-access-token" })),
  fetchGoogleUserinfo: vi.fn(async () => ({ sub: "google-subject", email: "athlete@example.com" })),
}));

describe("oauth routes", () => {
  let db: MockD1Database;
  let env: Env;
  let repository: D1AuthRepository;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-20T12:00:00.000Z"));
    db = new MockD1Database();
    env = createEnv({ DB: db as unknown as D1Database });
    repository = new D1AuthRepository(env);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("serves oauth metadata", async () => {
    const protectedResource = await handleOAuthRoute(env, new Request("https://mcp.test/.well-known/oauth-protected-resource/mcp"));
    expect(protectedResource?.status).toBe(200);
    await expect(protectedResource?.json()).resolves.toMatchObject({
      resource: "https://mcp.test/mcp",
      authorization_servers: ["https://mcp.test"],
    });

    const authorizationMetadata = await handleOAuthRoute(env, new Request("https://mcp.test/.well-known/oauth-authorization-server"));
    await expect(authorizationMetadata?.json()).resolves.toMatchObject({
      issuer: "https://mcp.test",
      token_endpoint: "https://mcp.test/token",
    });
  });

  it("registers oauth clients", async () => {
    const response = await handleOAuthRoute(
      env,
      new Request("https://mcp.test/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ redirect_uris: ["https://client.test/callback"], token_endpoint_auth_method: "client_secret_post" }),
      }),
    );

    expect(response?.status).toBe(201);
    const body = await response?.json();
    expect(body.redirect_uris).toEqual(["https://client.test/callback"]);
    expect(body.client_secret).toBeTypeOf("string");
  });

  it("starts authorize flow and stores the session state", async () => {
    await repository.saveClient({
      client_id: "client-1",
      client_secret: "client-secret",
      redirect_uris: ["https://client.test/callback"],
      token_endpoint_auth_method: "client_secret_post",
    });

    const response = await handleOAuthRoute(
      env,
      new Request("https://mcp.test/authorize?client_id=client-1&redirect_uri=https%3A%2F%2Fclient.test%2Fcallback&response_type=code&code_challenge=challenge&code_challenge_method=S256&scope=mcp"),
    );

    expect(response?.status).toBe(302);
    const location = response?.headers.get("location");
    expect(location).toContain("https://accounts.google.com/o/oauth2/v2/auth");
    const state = new URL(location ?? "").searchParams.get("state");
    expect(state).toBeTruthy();
    await expect(repository.popOAuthSession(state!)).resolves.toMatchObject({
      clientId: "client-1",
      redirectUri: "https://client.test/callback",
    });
  });

  it("completes google callback and redirects back with an authorization code", async () => {
    await repository.createOAuthSession({
      state: "state-1",
      clientId: "client-1",
      redirectUri: "https://client.test/callback",
      redirectUriProvidedExplicitly: true,
      codeChallenge: "challenge",
      scopes: ["mcp"],
      resource: "https://mcp.test/mcp",
      expiresAt: Math.floor(Date.now() / 1000) + 60,
    });

    const response = await handleOAuthRoute(
      env,
      new Request("https://mcp.test/oauth/google/callback?state=state-1&code=google-code"),
    );

    expect(response?.status).toBe(302);
    const redirect = new URL(response?.headers.get("location") ?? "");
    expect(redirect.origin + redirect.pathname).toBe("https://client.test/callback");
    expect(redirect.searchParams.get("state")).toBe("state-1");
    const authCode = redirect.searchParams.get("code");
    expect(authCode).toBeTruthy();
    await expect(repository.popAuthorizationCode("client-1", authCode!)).resolves.toMatchObject({
      userId: "user_google-subject",
      email: "athlete@example.com",
    });
  });

  it("exchanges authorization codes for tokens and exposes bearer auth info", async () => {
    await repository.saveClient({
      client_id: "client-1",
      client_secret: "client-secret",
      redirect_uris: ["https://client.test/callback"],
      token_endpoint_auth_method: "client_secret_post",
    });
    await repository.setIntervalsCredentials("user-1", { athleteId: "i123", apiKey: "api-key" });
    const verifier = "verifier-123";
    await repository.saveAuthorizationCode({
      code: "code-1",
      userId: "user-1",
      email: "athlete@example.com",
      scopes: ["mcp"],
      expiresAt: Math.floor(Date.now() / 1000) + 60,
      clientId: "client-1",
      codeChallenge: await sha256Base64Url(verifier),
      redirectUri: "https://client.test/callback",
      redirectUriProvidedExplicitly: true,
      resource: "https://mcp.test/mcp",
    });

    const response = await handleOAuthRoute(
      env,
      new Request("https://mcp.test/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: "client-1",
          client_secret: "client-secret",
          code: "code-1",
          code_verifier: verifier,
          redirect_uri: "https://client.test/callback",
        }),
      }),
    );

    expect(response?.status).toBe(200);
    const body = await response?.json();
    expect(body.access_token).toBeTypeOf("string");
    expect(body.refresh_token).toBeTypeOf("string");

    const authInfo = await verifyBearerToken(
      env,
      new Request("https://mcp.test/mcp", {
        headers: { authorization: `Bearer ${body.access_token}` },
      }),
    );
    expect(authInfo).toMatchObject({
      clientId: "client-1",
      extra: {
        userId: "user-1",
        intervalsAthleteId: "i123",
        intervalsApiKey: "api-key",
      },
    });
  });

  it("exchanges refresh tokens and revokes tokens", async () => {
    await repository.saveClient({
      client_id: "client-1",
      client_secret: "client-secret",
      redirect_uris: ["https://client.test/callback"],
      token_endpoint_auth_method: "client_secret_post",
    });
    await repository.setIntervalsCredentials("user-1", { athleteId: "i123", apiKey: "api-key" });
    await repository.saveRefreshToken({
      token: "refresh-1",
      userId: "user-1",
      clientId: "client-1",
      scopes: ["mcp"],
      resource: "https://mcp.test/mcp",
      expiresAt: Math.floor(Date.now() / 1000) + 60,
    });

    const refreshResponse = await handleOAuthRoute(
      env,
      new Request("https://mcp.test/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          client_id: "client-1",
          client_secret: "client-secret",
          refresh_token: "refresh-1",
        }),
      }),
    );
    expect(refreshResponse?.status).toBe(200);
    const refreshed = await refreshResponse?.json();
    expect(refreshed.access_token).toBeTypeOf("string");

    const revokeResponse = await handleOAuthRoute(
      env,
      new Request("https://mcp.test/revoke", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: "client-1",
          client_secret: "client-secret",
          token: refreshed.access_token,
        }),
      }),
    );
    expect(revokeResponse?.status).toBe(200);
    await expect(repository.getAccessToken(refreshed.access_token)).resolves.toBeNull();
  });
});

