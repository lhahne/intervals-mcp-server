export function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(body), { ...init, headers });
}

export function textResponse(body: string, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "text/plain; charset=utf-8");
  return new Response(body, { ...init, headers });
}

export function nowEpochSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export function daysAgo(days: number): string {
  return daysFromNow(-days);
}

export function daysFromNow(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export function validateDate(date: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error("Invalid date format. Please use YYYY-MM-DD.");
  }
  return date;
}

export function validateAthleteId(athleteId: string): void {
  if (athleteId && !/^i?\d+$/.test(athleteId)) {
    throw new Error(
      "ATHLETE_ID must be all digits (e.g. 123456) or start with 'i' followed by digits (e.g. i123456)",
    );
  }
}

export function resolveDateRange(
  startDate?: string,
  endDate?: string,
  defaultStartDaysAgo = 30,
): [string, string] {
  const start = startDate ?? daysAgo(defaultStartDaysAgo);
  const end = endDate ?? todayIso();
  validateDate(start);
  validateDate(end);
  return [start, end];
}

export function asErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function toQueryString(params?: Record<string, unknown>): string {
  if (!params) {
    return "";
  }
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) {
      continue;
    }
    query.set(key, String(value));
  }
  const serialized = query.toString();
  return serialized ? `?${serialized}` : "";
}

export function pretty(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function unauthorized(message = "Unauthorized"): Response {
  return jsonResponse({ error: "unauthorized", error_description: message }, { status: 401 });
}

export function badRequest(message: string): Response {
  return jsonResponse({ error: "invalid_request", error_description: message }, { status: 400 });
}

export function redirectWithQuery(base: string, params: Record<string, string>): Response {
  const url = new URL(base);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return Response.redirect(url.toString(), 302);
}
