// Thin, stateless HTTP client for the real ScoutWyze Compute API. No
// business logic, no caching, no fallback data — every call either
// relays the real upstream response or fails closed. This module is
// the ONLY place that reads SCOUTWYZE_API_KEY; it is never returned
// or echoed anywhere, including in error paths (see callCompute's own
// comment on why errors here are deliberately generic).

const BASE_URL = process.env.SCOUTWYZE_BASE_URL || "https://scoutwyze-compute.fly.dev";
const API_KEY = process.env.SCOUTWYZE_API_KEY;

export interface ApiCallResult {
  status: number;
  body: unknown;
}

/**
 * Never throws on a non-2xx HTTP response — a 402 (insufficient
 * credits, OR a real x402 payment challenge) is a normal, expected
 * outcome this server passes straight through as real content, not an
 * error to swallow or retry itself (2026-09-24, Robert: "the server
 * surfaces the challenge payload as structured data... no silent
 * retries, no embedded wallet keys"). Only throws on a genuine
 * network/transport failure — callers must fail closed on that, never
 * fabricate a result.
 */
export async function callCompute(path: string, init: { method: "GET" | "POST"; body?: unknown }): Promise<ApiCallResult> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (API_KEY) headers["authorization"] = `Bearer ${API_KEY}`;

  const res = await fetch(`${BASE_URL}${path}`, {
    method: init.method,
    headers,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    // Upstream returned a non-JSON body (e.g. a proxy error page) —
    // fail closed with the real status, don't fabricate a response.
    body = { error: "invalid_upstream_response", message: `Upstream returned HTTP ${res.status} with a non-JSON body.` };
  }

  return { status: res.status, body };
}

export function hasApiKey(): boolean {
  return !!API_KEY;
}
