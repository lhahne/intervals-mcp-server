import type { RequestContext, ResolvedRequestCredentials } from "./types.js";
import { intervalsApiBaseUrl, resolveRequestCredentials, userAgent } from "./config.js";
import { pretty, toQueryString } from "./utils.js";

type IntervalsResult = Record<string, unknown> | Record<string, unknown>[] | null;

function userFacingError(status: number, fallback: string): string {
  switch (status) {
    case 401:
      return "401 Unauthorized: Please check your API key.";
    case 403:
      return "403 Forbidden: You may not have permission to access this resource.";
    case 404:
      return "404 Not Found: The requested endpoint or ID doesn't exist.";
    case 422:
      return "422 Unprocessable Entity: The server couldn't process the request (invalid parameters or unsupported operation).";
    case 429:
      return "429 Too Many Requests: Too many requests in a short time period.";
    case 500:
      return "500 Internal Server Error: The Intervals.icu server encountered an internal error.";
    case 503:
      return "503 Service Unavailable: The Intervals.icu server might be down or undergoing maintenance.";
    default:
      return fallback;
  }
}

export function requireAthleteId(athleteId?: string): string {
  if (!athleteId) {
    throw new Error(
      "No athlete ID is configured for this request. Set your credentials with set_intervals_credentials or configure ATHLETE_ID for local development.",
    );
  }
  return athleteId;
}

export function requestCredentials(context: RequestContext): ResolvedRequestCredentials {
  return resolveRequestCredentials(context);
}

export async function makeIntervalsRequest(
  context: RequestContext,
  path: string,
  options: {
    apiKey?: string | null;
    method?: string;
    params?: Record<string, unknown>;
    data?: unknown;
  } = {},
): Promise<IntervalsResult | { error: true; message: string; statusCode?: number }> {
  const credentials = resolveRequestCredentials(context);
  const apiKey = options.apiKey ?? credentials.apiKey;
  if (!apiKey) {
    return {
      error: true,
      message:
        "API key is required. Use set_intervals_credentials for authenticated access or configure API_KEY for local development.",
    };
  }

  const url = `${intervalsApiBaseUrl(context.env)}${path}${toQueryString(options.params)}`;
  const headers = new Headers({
    "user-agent": userAgent(),
    accept: "application/json",
    authorization: `Basic ${btoa(`API_KEY:${apiKey}`)}`,
  });
  if (options.data !== undefined) {
    headers.set("content-type", "application/json");
  }

  try {
    const response = await fetch(url, {
      method: options.method ?? "GET",
      headers,
      body: options.data === undefined ? undefined : JSON.stringify(options.data),
    });

    const text = await response.text();
    if (!response.ok) {
      return {
        error: true,
        statusCode: response.status,
        message: userFacingError(response.status, text || response.statusText),
      };
    }
    const parsed = text ? (JSON.parse(text) as IntervalsResult) : null;
    return parsed;
  } catch (error) {
    return {
      error: true,
      message: `Request error: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export function summarizeCollection(title: string, items: unknown[], preferredKeys: string[]): string {
  if (!items.length) {
    return `${title}: none found.`;
  }
  const rows = items.map((item) => summarizeObject(item, preferredKeys));
  return `${title}:\n\n${rows.join("\n\n")}`;
}

export function summarizeObject(item: unknown, preferredKeys: string[]): string {
  if (!item || typeof item !== "object") {
    return String(item);
  }
  const object = item as Record<string, unknown>;
  const orderedKeys = [...preferredKeys.filter((key) => key in object), ...Object.keys(object).slice(0, 12)];
  const unique = Array.from(new Set(orderedKeys));
  return unique
    .map((key) => {
      const value = object[key];
      if (value === undefined) {
        return null;
      }
      if (typeof value === "object" && value !== null) {
        return `${key}: ${pretty(value)}`;
      }
      return `${key}: ${String(value)}`;
    })
    .filter((line): line is string => Boolean(line))
    .join("\n");
}
