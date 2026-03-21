import type { Env, RequestContext, ResolvedRequestCredentials } from "./types.js";
import { validateAthleteId } from "./utils.js";

export function intervalsApiBaseUrl(env: Env): string {
  return env.INTERVALS_API_BASE_URL ?? "https://intervals.icu/api/v1";
}

export function userAgent(): string {
  return "intervalsicu-mcp-server-ts/1.0";
}

export function authEnabled(env: Env): boolean {
  return Boolean(
    env.MCP_ISSUER_URL &&
      env.MCP_RESOURCE_SERVER_URL &&
      env.MCP_GOOGLE_CALLBACK_URL &&
      env.GOOGLE_OAUTH_CLIENT_ID &&
      env.GOOGLE_OAUTH_CLIENT_SECRET &&
      env.MCP_ENCRYPTION_SECRET,
  );
}

export function requireEnv(env: Env, name: keyof Env): string {
  const value = env[name];
  if (!value || typeof value !== "string") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export function localFallbackCredentials(env: Env): ResolvedRequestCredentials {
  const athleteId = env.ATHLETE_ID?.trim();
  if (athleteId) {
    validateAthleteId(athleteId);
  }
  return {
    athleteId,
    apiKey: env.API_KEY?.trim(),
  };
}

export function resolveRequestCredentials(context: RequestContext): ResolvedRequestCredentials {
  const fallback = localFallbackCredentials(context.env);
  const extra = context.auth?.extra as Record<string, unknown> | undefined;
  const athleteId = typeof extra?.intervalsAthleteId === "string" ? extra.intervalsAthleteId : fallback.athleteId;
  const apiKey = typeof extra?.intervalsApiKey === "string" ? extra.intervalsApiKey : fallback.apiKey;
  const userId = typeof extra?.userId === "string" ? extra.userId : undefined;
  const email = typeof extra?.email === "string" ? extra.email : undefined;
  return { athleteId, apiKey, userId, email };
}
