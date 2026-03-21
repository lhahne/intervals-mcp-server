import { beforeEach, describe, expect, it, vi } from "vitest";
import { D1AuthRepository } from "../src/repository.js";
import { createEnv } from "./helpers/env.js";
import { MockD1Database } from "./helpers/d1.js";

describe("D1AuthRepository", () => {
  let db: MockD1Database;
  let repository: D1AuthRepository;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-20T12:00:00.000Z"));
    db = new MockD1Database();
    repository = new D1AuthRepository(createEnv({ DB: db as unknown as D1Database }));
  });

  it("upserts users by google subject", async () => {
    const first = await repository.upsertUser("sub-1", "first@example.com");
    const second = await repository.upsertUser("sub-1", "updated@example.com");
    expect(second).toBe(first);
    expect(db.tables.users.get(first)?.email).toBe("updated@example.com");
  });

  it("creates and pops oauth sessions once", async () => {
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

    await expect(repository.popOAuthSession("state-1")).resolves.toMatchObject({
      state: "state-1",
      clientId: "client-1",
    });
    await expect(repository.popOAuthSession("state-1")).resolves.toBeNull();
  });

  it("stores and decrypts registered clients", async () => {
    await repository.saveClient({
      client_id: "client-1",
      client_secret: "secret-1",
      redirect_uris: ["https://client.test/callback"],
    });

    await expect(repository.getClient("client-1")).resolves.toMatchObject({
      client_id: "client-1",
      client_secret: "secret-1",
    });
  });

  it("stores authorization codes and consumes them once", async () => {
    await repository.saveAuthorizationCode({
      code: "code-1",
      userId: "user-1",
      email: "user@example.com",
      scopes: ["mcp"],
      expiresAt: Math.floor(Date.now() / 1000) + 60,
      clientId: "client-1",
      codeChallenge: "challenge",
      redirectUri: "https://client.test/callback",
      redirectUriProvidedExplicitly: true,
      resource: "https://mcp.test/mcp",
    });

    await expect(repository.popAuthorizationCode("client-1", "code-1")).resolves.toMatchObject({
      code: "code-1",
      userId: "user-1",
    });
    await expect(repository.popAuthorizationCode("client-1", "code-1")).resolves.toBeNull();
  });

  it("stores access and refresh tokens and revokes them", async () => {
    await repository.saveAccessToken({
      token: "access-1",
      userId: "user-1",
      clientId: "client-1",
      scopes: ["mcp"],
      resource: "https://mcp.test/mcp",
      expiresAt: Math.floor(Date.now() / 1000) + 60,
      intervalsAthleteId: "i123",
      intervalsApiKey: "api-key",
    });
    await repository.saveRefreshToken({
      token: "refresh-1",
      userId: "user-1",
      clientId: "client-1",
      scopes: ["mcp"],
      resource: "https://mcp.test/mcp",
      expiresAt: Math.floor(Date.now() / 1000) + 60,
    });

    await expect(repository.getAccessToken("access-1")).resolves.toMatchObject({ token: "access-1" });
    await expect(repository.popRefreshToken("client-1", "refresh-1")).resolves.toMatchObject({ token: "refresh-1" });

    await repository.revokeToken("access-1");
    await expect(repository.getAccessToken("access-1")).resolves.toBeNull();
  });

  it("stores encrypted intervals credentials", async () => {
    await repository.setIntervalsCredentials("user-1", { athleteId: "i123", apiKey: "api-key" });
    await expect(repository.getIntervalsCredentials("user-1")).resolves.toEqual({
      athleteId: "i123",
      apiKey: "api-key",
    });
    await repository.clearIntervalsCredentials("user-1");
    await expect(repository.getIntervalsCredentials("user-1")).resolves.toBeNull();
  });
});

