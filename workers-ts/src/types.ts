import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";

export type Json =
  | string
  | number
  | boolean
  | null
  | Json[]
  | { [key: string]: Json };

export interface Env {
  API_KEY?: string;
  ATHLETE_ID?: string;
  INTERVALS_API_BASE_URL?: string;
  DB: D1Database;
  MCP_ISSUER_URL?: string;
  MCP_RESOURCE_SERVER_URL?: string;
  MCP_GOOGLE_CALLBACK_URL?: string;
  MCP_SERVICE_DOCUMENTATION_URL?: string;
  GOOGLE_OAUTH_CLIENT_ID?: string;
  GOOGLE_OAUTH_CLIENT_SECRET?: string;
  MCP_ENCRYPTION_SECRET?: string;
}

export interface IntervalsCredentials {
  athleteId: string;
  apiKey: string;
}

export interface OAuthSession {
  state: string;
  clientId: string;
  redirectUri: string;
  redirectUriProvidedExplicitly: boolean;
  codeChallenge: string;
  scopes: string[];
  resource?: string | null;
  expiresAt: number;
}

export interface StoredClient {
  client_id: string;
  client_secret?: string;
  client_id_issued_at?: number;
  client_secret_expires_at?: number;
  redirect_uris: string[];
  token_endpoint_auth_method?: string;
  grant_types?: string[];
  response_types?: string[];
  client_name?: string;
  client_uri?: string;
  logo_uri?: string;
  scope?: string;
  contacts?: string[];
  tos_uri?: string;
  policy_uri?: string;
  jwks_uri?: string;
  jwks?: unknown;
  software_id?: string;
  software_version?: string;
  software_statement?: string;
}

export interface AuthorizationCodeRecord {
  code: string;
  userId: string;
  email?: string | null;
  scopes: string[];
  expiresAt: number;
  clientId: string;
  codeChallenge: string;
  redirectUri: string;
  redirectUriProvidedExplicitly: boolean;
  resource?: string | null;
}

export interface AccessTokenRecord {
  token: string;
  userId: string;
  clientId: string;
  scopes: string[];
  resource?: string | null;
  expiresAt: number;
  email?: string | null;
  googleSubject?: string | null;
  intervalsAthleteId?: string | null;
  intervalsApiKey?: string | null;
}

export interface RefreshTokenRecord {
  token: string;
  userId: string;
  clientId: string;
  scopes: string[];
  resource?: string | null;
  expiresAt: number;
}

export interface RequestContext {
  env: Env;
  auth?: AuthInfo;
}

export interface ResolvedRequestCredentials {
  athleteId?: string;
  apiKey?: string;
  userId?: string;
  email?: string;
}
