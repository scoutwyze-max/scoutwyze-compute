import type { FastifyInstance } from "fastify";
import type { ApiKeyStore } from "../../billing/apiKeyStore.js";
import type { CreditLedger } from "../../billing/creditLedger.js";
import type { ProcessedEventStore } from "../../payments/processedEvents.js";
import type { RequestLogStore } from "../../admin/requestLog.js";
import type { AgentLogStore } from "../../admin/agentLog.js";
import type { OutreachRunner } from "../../admin/outreachRunner.js";
import { checkAdminSecret } from "./admin.js";
import { createRequireAdminSession, issueSessionCookie, clearSessionCookie } from "../../admin/session.js";

export interface AdminConsoleRouteDeps {
  apiKeyStore: ApiKeyStore;
  creditLedger: CreditLedger;
  processedEvents: ProcessedEventStore;
  requestLog: RequestLogStore;
  agentLog: AgentLogStore;
  outreachRunner: OutreachRunner;
  adminSecret: string;
}

const OVERVIEW_WINDOW_HOURS = 24;
const RECENT_LEDGER_LIMIT = 25;
const RECENT_PURCHASES_LIMIT = 25;
const RECENT_BALANCES_LIMIT = 25;
const AGENT_LOG_LIMIT = 100;
const RECENT_SETTLEMENTS_LIMIT = 25;
const RECENT_REQUESTS_LIMIT = 50;

/**
 * Backend for the admin console (SOT.md-adjacent internal tool, not a
 * customer-facing endpoint) — 2026-09-24, Robert: "let's build v1 of
 * the ScoutWyze-Compute AI/SI Agent Console." Session-cookie gated
 * (admin/session.ts), not the raw X-Admin-Secret header used by
 * admin.ts's operational routes — the browser never holds the raw
 * secret past the one login call below.
 */
export function registerAdminConsoleRoutes(app: FastifyInstance, deps: AdminConsoleRouteDeps): void {
  // The ONE route that ever sees the raw secret from a browser —
  // exchanges it for a short-lived signed cookie and nothing else.
  app.post("/v1/admin/session", async (request, reply) => {
    if (!checkAdminSecret(request.headers["x-admin-secret"], deps.adminSecret)) {
      return reply.code(401).send({ error: "unauthorized", message: "Missing or invalid X-Admin-Secret header." });
    }
    reply.header("Set-Cookie", issueSessionCookie(deps.adminSecret));
    return reply.code(200).send({ ok: true });
  });

  app.post("/v1/admin/session/logout", async (_request, reply) => {
    reply.header("Set-Cookie", clearSessionCookie());
    return reply.code(200).send({ ok: true });
  });

  const requireSession = createRequireAdminSession(deps.adminSecret);

  app.get("/v1/admin/console/overview", { preHandler: requireSession }, async (_request, reply) => {
    const sinceIso = new Date(Date.now() - OVERVIEW_WINDOW_HOURS * 60 * 60 * 1000).toISOString();
    const chargeTotal24hUsd = deps.creditLedger.getChargeTotalSince(sinceIso);

    return reply.code(200).send({
      activeApiKeys: deps.apiKeyStore.countActive(),
      revenue24hUsd: chargeTotal24hUsd,
      // Same total as revenue24hUsd, expressed as a rate — see
      // getChargeTotalSince's own doc comment for why these share one
      // query rather than risk disagreeing.
      burnRatePerHourUsd: Math.round((chargeTotal24hUsd / OVERVIEW_WINDOW_HOURS) * 100) / 100,
      recentLedger: deps.creditLedger.getRecentLedgerAcrossAccounts(RECENT_LEDGER_LIMIT),
      recentStripePurchases: deps.processedEvents.recentStripePurchases(RECENT_PURCHASES_LIMIT),
      accountBalances: deps.creditLedger.getAllBalances(RECENT_BALANCES_LIMIT),
    });
  });

  app.get("/v1/admin/console/telemetry", { preHandler: requireSession }, async (_request, reply) => {
    const sinceIso = new Date(Date.now() - OVERVIEW_WINDOW_HOURS * 60 * 60 * 1000).toISOString();
    const rows = deps.requestLog.getTelemetrySince(sinceIso);
    const byRoute = new Map(rows.map((r) => [r.route, r]));
    // Always both routes, even at zero traffic — the panel shouldn't
    // silently omit an endpoint just because nobody hit it today.
    const routes = (["compute_sample", "compute_rank"] as const).map(
      (route) => byRoute.get(route) ?? { route, count: 0, errorCount: 0, avgLatencyMs: null, lastRequestAt: null },
    );
    return reply.code(200).send({ windowHours: OVERVIEW_WINDOW_HOURS, routes });
  });

  // Real on-chain x402/USDC settlements on Base (2026-09-25) — pure
  // exposure of data already durably recorded by verifyX402Payment's
  // recordIfNew() call in auth.ts; nothing new is captured here, this
  // just reads it back. txHash is the real Base tx hash, safe to link
  // straight to BaseScan client-side.
  app.get("/v1/admin/console/settlements", { preHandler: requireSession }, async (_request, reply) => {
    return reply.code(200).send({ settlements: deps.processedEvents.recentBaseSettlements(RECENT_SETTLEMENTS_LIMIT) });
  });

  // Raw per-request rows (2026-09-25), rail-aware — unlike /telemetry
  // above (aggregated counts per route), this is one row per request
  // so the console can show scoutwyze_rank vs scoutwyze_sample traffic
  // side by side with which rail (bearer/x402) served each one.
  app.get("/v1/admin/console/requests", { preHandler: requireSession }, async (_request, reply) => {
    return reply.code(200).send({ requests: deps.requestLog.recent(RECENT_REQUESTS_LIMIT) });
  });

  app.get("/v1/admin/console/agent-log", { preHandler: requireSession }, async (_request, reply) => {
    return reply.code(200).send({ entries: deps.agentLog.recent(AGENT_LOG_LIMIT) });
  });

  // The one fixed, non-operator-editable action (2026-09-24, Robert:
  // "fixed buttons only, no free-text commands"). Args are hardcoded
  // in outreachRunner.ts, not read from this request.
  app.post("/v1/admin/console/agent-runs/outreach", { preHandler: requireSession }, async (_request, reply) => {
    try {
      const { runId } = deps.outreachRunner.trigger();
      return reply.code(202).send({ started: true, runId });
    } catch (err) {
      return reply.code(409).send({ started: false, message: err instanceof Error ? err.message : String(err) });
    }
  });
}
