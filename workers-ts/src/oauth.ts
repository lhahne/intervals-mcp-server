import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { Env, StoredClient } from "./types.js";
import { authEnabled, requireEnv } from "./config.js";
import { buildGoogleAuthorizationUrl, exchangeGoogleCode, fetchGoogleUserinfo } from "./googleOAuth.js";
import { D1AuthRepository } from "./repository.js";
import { generateToken, sha256Base64Url } from "./security.js";
import { badRequest, jsonResponse, redirectWithQuery, unauthorized } from "./utils.js";

const AUTH_CODE_TTL_SECONDS = 300;
const ACCESS_TOKEN_TTL_SECONDS = 3600;
const REFRESH_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30;

export function protectedResourceMetadata(env: Env): Record<string, unknown> {
  return {
    resource: requireEnv(env, "MCP_RESOURCE_SERVER_URL"),
    authorization_servers: [requireEnv(env, "MCP_ISSUER_URL")],
    scopes_supported: ["mcp"],
    bearer_methods_supported: ["header"],
    resource_documentation: env.MCP_SERVICE_DOCUMENTATION_URL,
    resource_name: "Intervals.icu MCP",
  };
}

export function authorizationServerMetadata(env: Env): Record<string, unknown> {
  const issuer = requireEnv(env, "MCP_ISSUER_URL");
  return {
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    registration_endpoint: `${issuer}/register`,
    revocation_endpoint: `${issuer}/revoke`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    scopes_supported: ["mcp"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
    revocation_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
    service_documentation: env.MCP_SERVICE_DOCUMENTATION_URL,
  };
}

function parseClientBasicAuth(request: Request): { clientId?: string; clientSecret?: string } {
  const header = request.headers.get("authorization");
  if (!header?.startsWith("Basic ")) {
    return {};
  }
  try {
    const decoded = atob(header.slice(6));
    const [clientId, clientSecret] = decoded.split(":", 2);
    return { clientId, clientSecret };
  } catch {
    return {};
  }
}

async function parseForm(request: Request): Promise<URLSearchParams> {
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("application/x-www-form-urlencoded")) {
    return new URLSearchParams(await request.text());
  }
  if (contentType.includes("application/json")) {
    const body = (await request.json()) as Record<string, unknown>;
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(body)) {
      if (value !== undefined && value !== null) {
        params.set(key, String(value));
      }
    }
    return params;
  }
  return new URLSearchParams(await request.text());
}

async function authenticateClient(repository: D1AuthRepository, request: Request, params: URLSearchParams): Promise<StoredClient | null> {
  const basic = parseClientBasicAuth(request);
  const clientId = params.get("client_id") ?? basic.clientId;
  if (!clientId) {
    return null;
  }
  const client = await repository.getClient(clientId);
  if (!client) {
    return null;
  }
  const providedSecret = params.get("client_secret") ?? basic.clientSecret;
  const method = client.token_endpoint_auth_method ?? "none";
  if (method !== "none" && client.client_secret !== providedSecret) {
    return null;
  }
  return client;
}

export async function verifyBearerToken(env: Env, request: Request): Promise<AuthInfo | null> {
  if (!authEnabled(env)) {
    return null;
  }
  const header = request.headers.get("authorization");
  if (!header?.startsWith("Bearer ")) {
    return null;
  }
  const token = header.slice("Bearer ".length);
  const repository = new D1AuthRepository(env);
  const record = await repository.getAccessToken(token);
  if (!record) {
    return null;
  }
  return {
    token: record.token,
    clientId: record.clientId,
    scopes: record.scopes,
    expiresAt: record.expiresAt,
    resource: record.resource ? new URL(record.resource) : undefined,
    extra: {
      userId: record.userId,
      email: record.email,
      googleSubject: record.googleSubject,
      intervalsAthleteId: record.intervalsAthleteId,
      intervalsApiKey: record.intervalsApiKey,
    },
  };
}

export async function handleOAuthRoute(env: Env, request: Request): Promise<Response | null> {
  if (!authEnabled(env)) {
    return null;
  }
  const url = new URL(request.url);
  const repository = new D1AuthRepository(env);

  if (request.method === "GET" && url.pathname === "/.well-known/oauth-protected-resource/mcp") {
    return jsonResponse(protectedResourceMetadata(env));
  }
  if (request.method === "GET" && url.pathname === "/.well-known/oauth-authorization-server") {
    return jsonResponse(authorizationServerMetadata(env));
  }
  if (request.method === "POST" && url.pathname === "/register") {
    const body = (await request.json()) as Record<string, unknown>;
    const client: StoredClient = {
      client_id: generateToken(24),
      client_secret: body.token_endpoint_auth_method === "none" ? undefined : generateToken(32),
      client_id_issued_at: Math.floor(Date.now() / 1000),
      client_secret_expires_at: 0,
      redirect_uris: Array.isArray(body.redirect_uris) ? body.redirect_uris.map(String) : [],
      token_endpoint_auth_method:
        typeof body.token_endpoint_auth_method === "string" ? body.token_endpoint_auth_method : "none",
      grant_types: Array.isArray(body.grant_types) ? body.grant_types.map(String) : ["authorization_code", "refresh_token"],
      response_types: Array.isArray(body.response_types) ? body.response_types.map(String) : ["code"],
      client_name: typeof body.client_name === "string" ? body.client_name : undefined,
      client_uri: typeof body.client_uri === "string" ? body.client_uri : undefined,
      logo_uri: typeof body.logo_uri === "string" ? body.logo_uri : undefined,
      scope: typeof body.scope === "string" ? body.scope : "mcp",
      contacts: Array.isArray(body.contacts) ? body.contacts.map(String) : undefined,
      tos_uri: typeof body.tos_uri === "string" ? body.tos_uri : undefined,
      policy_uri: typeof body.policy_uri === "string" ? body.policy_uri : undefined,
      jwks_uri: typeof body.jwks_uri === "string" ? body.jwks_uri : undefined,
      jwks: body.jwks,
      software_id: typeof body.software_id === "string" ? body.software_id : undefined,
      software_version: typeof body.software_version === "string" ? body.software_version : undefined,
      software_statement: typeof body.software_statement === "string" ? body.software_statement : undefined,
    };
    if (!client.redirect_uris.length) {
      return badRequest("redirect_uris is required.");
    }
    await repository.saveClient(client);
    return jsonResponse(client, { status: 201 });
  }
  if (request.method === "GET" && url.pathname === "/authorize") {
    const clientId = url.searchParams.get("client_id");
    const redirectUri = url.searchParams.get("redirect_uri");
    const responseType = url.searchParams.get("response_type");
    const state = url.searchParams.get("state") ?? "";
    const oauthState = state || generateToken(24);
    const codeChallenge = url.searchParams.get("code_challenge");
    const codeChallengeMethod = url.searchParams.get("code_challenge_method");
    if (!clientId || !redirectUri || responseType !== "code" || !codeChallenge || codeChallengeMethod !== "S256") {
      return badRequest("Missing or invalid OAuth authorize parameters.");
    }
    const client = await repository.getClient(clientId);
    if (!client || !client.redirect_uris.includes(redirectUri)) {
      return badRequest("Unregistered client or redirect_uri.");
    }
    const resource = url.searchParams.get("resource") ?? requireEnv(env, "MCP_RESOURCE_SERVER_URL");
    await repository.createOAuthSession({
      state: oauthState,
      clientId,
      redirectUri,
      redirectUriProvidedExplicitly: true,
      codeChallenge,
      scopes: (url.searchParams.get("scope") ?? "mcp").split(" ").filter(Boolean),
      resource,
      expiresAt: Math.floor(Date.now() / 1000) + AUTH_CODE_TTL_SECONDS,
    });
    return Response.redirect(
      buildGoogleAuthorizationUrl(
        requireEnv(env, "GOOGLE_OAUTH_CLIENT_ID"),
        requireEnv(env, "MCP_GOOGLE_CALLBACK_URL"),
        oauthState,
      ),
      302,
    );
  }
  if (request.method === "GET" && url.pathname === "/oauth/google/callback") {
    const state = url.searchParams.get("state");
    const code = url.searchParams.get("code");
    if (!state || !code) {
      return badRequest("Missing code or state.");
    }
    const session = await repository.popOAuthSession(state);
    if (!session) {
      return badRequest("Unknown or expired session.");
    }
    const googleTokens = await exchangeGoogleCode(
      code,
      requireEnv(env, "GOOGLE_OAUTH_CLIENT_ID"),
      requireEnv(env, "GOOGLE_OAUTH_CLIENT_SECRET"),
      requireEnv(env, "MCP_GOOGLE_CALLBACK_URL"),
    );
    const googleProfile = await fetchGoogleUserinfo(googleTokens.access_token);
    const subject = googleProfile.sub;
    if (!subject) {
      return badRequest("Google user profile missing subject.");
    }
    const userId = await repository.upsertUser(subject, googleProfile.email);
    const authorizationCode = generateToken(24);
    await repository.saveAuthorizationCode({
      code: authorizationCode,
      userId,
      email: googleProfile.email,
      scopes: session.scopes,
      expiresAt: Math.floor(Date.now() / 1000) + AUTH_CODE_TTL_SECONDS,
      clientId: session.clientId,
      codeChallenge: session.codeChallenge,
      redirectUri: session.redirectUri,
      redirectUriProvidedExplicitly: session.redirectUriProvidedExplicitly,
      resource: session.resource ?? requireEnv(env, "MCP_RESOURCE_SERVER_URL"),
    });
    return redirectWithQuery(session.redirectUri, { code: authorizationCode, state: session.state });
  }
  if (request.method === "POST" && url.pathname === "/token") {
    const params = await parseForm(request);
    const grantType = params.get("grant_type");
    const client = await authenticateClient(repository, request, params);
    if (!client) {
      return unauthorized("Invalid OAuth client.");
    }
    if (grantType === "authorization_code") {
      const code = params.get("code");
      const codeVerifier = params.get("code_verifier");
      const redirectUri = params.get("redirect_uri");
      if (!code || !codeVerifier || !redirectUri) {
        return badRequest("Missing authorization_code grant parameters.");
      }
      const authorizationCode = await repository.popAuthorizationCode(client.client_id, code);
      if (!authorizationCode || authorizationCode.redirectUri !== redirectUri) {
        return badRequest("Invalid authorization code.");
      }
      const challenge = await sha256Base64Url(codeVerifier);
      if (challenge !== authorizationCode.codeChallenge) {
        return badRequest("Invalid code_verifier.");
      }
      const accessToken = generateToken(32);
      const refreshToken = generateToken(32);
      await repository.saveAccessToken({
        token: accessToken,
        userId: authorizationCode.userId,
        clientId: client.client_id,
        scopes: authorizationCode.scopes,
        resource: authorizationCode.resource,
        expiresAt: Math.floor(Date.now() / 1000) + ACCESS_TOKEN_TTL_SECONDS,
        email: authorizationCode.email,
      });
      await repository.saveRefreshToken({
        token: refreshToken,
        userId: authorizationCode.userId,
        clientId: client.client_id,
        scopes: authorizationCode.scopes,
        resource: authorizationCode.resource,
        expiresAt: Math.floor(Date.now() / 1000) + REFRESH_TOKEN_TTL_SECONDS,
      });
      return jsonResponse({
        access_token: accessToken,
        token_type: "bearer",
        expires_in: ACCESS_TOKEN_TTL_SECONDS,
        scope: authorizationCode.scopes.join(" "),
        refresh_token: refreshToken,
      });
    }
    if (grantType === "refresh_token") {
      const refreshToken = params.get("refresh_token");
      if (!refreshToken) {
        return badRequest("Missing refresh_token.");
      }
      const stored = await repository.popRefreshToken(client.client_id, refreshToken);
      if (!stored) {
        return badRequest("Invalid refresh token.");
      }
      const accessToken = generateToken(32);
      const newRefreshToken = generateToken(32);
      await repository.saveAccessToken({
        token: accessToken,
        userId: stored.userId,
        clientId: client.client_id,
        scopes: stored.scopes,
        resource: stored.resource,
        expiresAt: Math.floor(Date.now() / 1000) + ACCESS_TOKEN_TTL_SECONDS,
      });
      await repository.saveRefreshToken({
        token: newRefreshToken,
        userId: stored.userId,
        clientId: client.client_id,
        scopes: stored.scopes,
        resource: stored.resource,
        expiresAt: Math.floor(Date.now() / 1000) + REFRESH_TOKEN_TTL_SECONDS,
      });
      return jsonResponse({
        access_token: accessToken,
        token_type: "bearer",
        expires_in: ACCESS_TOKEN_TTL_SECONDS,
        scope: stored.scopes.join(" "),
        refresh_token: newRefreshToken,
      });
    }
    return badRequest("Unsupported grant_type.");
  }
  if (request.method === "POST" && url.pathname === "/revoke") {
    const params = await parseForm(request);
    const client = await authenticateClient(repository, request, params);
    if (!client) {
      return unauthorized("Invalid OAuth client.");
    }
    const token = params.get("token");
    if (!token) {
      return badRequest("Missing token.");
    }
    await repository.revokeToken(token);
    return new Response(null, { status: 200 });
  }

  return null;
}
