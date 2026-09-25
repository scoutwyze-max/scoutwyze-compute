#!/usr/bin/env node
// ScoutWyze Compute MCP server — a stateless pass-through wrapping
// /v1/compute/sample and /v1/compute/rank for MCP-native agent hosts
// (Claude Desktop, Cursor, custom agent frameworks).
//
// Hard boundary, not a suggestion (2026-09-24, confirmed explicitly):
// this server never holds a private key and never signs or settles an
// x402 payment itself. On an unauthenticated/unfunded call it relays
// the real 402 challenge as tool content; a wallet-capable CALLING
// agent — not this server — is responsible for paying it and retrying
// with the resulting X-PAYMENT proof. Auth is Bearer-only from this
// server's side, via an optional SCOUTWYZE_API_KEY env var.
//
// route/quote is deliberately NOT wrapped here (2026-09-24, Robert:
// "drop quote entirely to match the flagship product path and keep
// the schema lean") — only sample/rank, which share the one frozen
// envelope (see SOT.md §3).

import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { callCompute } from "./client.js";

// Real bug caught in a doc-audit pass, 2026-09-24: this was hardcoded
// to "0.1.0" and never bumped when the package moved to 0.1.1 for the
// MCP Registry submission — the server's own protocol handshake was
// already lying about its version. Read from package.json instead of
// a literal so it can't drift again; createRequire (not a JSON import
// attribute) specifically for compatibility across the full engines
// range this package declares (>=18), where import-attribute syntax
// for JSON isn't uniformly stable.
const pkg = createRequire(import.meta.url)("../package.json");

const server = new McpServer({
  name: "scoutwyze-compute",
  version: pkg.version,
  title: "ScoutWyze Compute",
});

/** 402 is a normal, actionable protocol state here (insufficient
 * credits OR a real x402 payment challenge) — never flagged as an
 * error, so a calling agent actually reads and acts on the payload
 * instead of discarding it as a failure. Every other 4xx/5xx is a real
 * error. Body is always the real, unmodified upstream JSON — this
 * server never reinterprets or restructures it, including
 * schema_version, which passes through untouched. */
function toolResult(status: number, body: unknown) {
  const isError = status >= 400 && status !== 402;
  return {
    isError,
    content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }],
  };
}

/** Fixed, generic message on network failure — deliberately not
 * `String(err)` or any interpolation of the actual error object. This
 * server must never risk echoing anything request/header-shaped back
 * to a caller, and a raw fetch error's message could in principle
 * include connection details that shouldn't leave this process. Fail
 * closed: no cached or fabricated result, ever. */
function unreachableResult() {
  return { isError: true, content: [{ type: "text" as const, text: "ScoutWyze Compute is unreachable right now. Try again shortly." }] };
}

server.registerTool(
  "scoutwyze_sample",
  {
    title: "ScoutWyze Compute — free sample",
    description:
      'Free, anonymous preview of a real ranked GPU offer from ScoutWyze Compute — ranks current RunPod GPU offers by price and freshness. Fixed query (cheapest preference), rate-limited per IP, never billed. Use this to see the real response shape and the current live price (billing.price_usd) before calling scoutwyze_rank.',
    inputSchema: {},
  },
  async () => {
    try {
      const { status, body } = await callCompute("/v1/compute/sample", { method: "GET" });
      return toolResult(status, body);
    } catch {
      return unreachableResult();
    }
  },
);

server.registerTool(
  "scoutwyze_rank",
  {
    title: "ScoutWyze Compute — rank GPU offers",
    description:
      'Ranks current RunPod GPU offers by price and freshness for a given workload. Billed per successful match — the real price is in the response\'s billing.price_usd field; never assume a fixed amount, it can change server-side. Auth: if a SCOUTWYZE_API_KEY env var is configured, calls with a prepaid Bearer key (billing.rail: "bearer" in the response — never charged on a no-match result). If unauthenticated, or the key is invalid, this tool returns a real HTTP 402 x402 payment challenge (nonce, payTo, maxAmountRequired, expiresAt) as its result content, not an error — this server holds no private key and cannot pay it. A wallet-capable calling agent must settle the challenge independently and retry with the resulting X-PAYMENT proof (billing.rail: "x402" on success — settles before scoring, no refund on a no-match result, see SOT.md §5).',
    inputSchema: {
      gpuClass: z.string().optional().describe('Filter by GPU model substring, e.g. "H100" (case-insensitive)'),
      minVramGb: z.number().nonnegative().optional().describe("Minimum GPU memory in GB"),
      region: z.string().optional().describe("Filter by region prefix (case-insensitive)"),
      maxPricePerHour: z.number().positive().optional().describe("Maximum vendor hourly price in USD"),
      preference: z.enum(["cheapest", "fastest", "balanced"]).optional().describe("Ranking strategy — defaults to cheapest"),
    },
  },
  async (args) => {
    try {
      const { status, body } = await callCompute("/v1/compute/rank", { method: "POST", body: args });
      return toolResult(status, body);
    } catch {
      return unreachableResult();
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
