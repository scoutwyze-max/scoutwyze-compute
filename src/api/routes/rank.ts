import type { FastifyInstance, RouteHandlerMethod } from "fastify";
import { z } from "zod";
import type { IngestionCache } from "../../ingestion/cache.js";
import type { ApiKeyStore } from "../../billing/apiKeyStore.js";
import type { CreditLedger } from "../../billing/creditLedger.js";
import { computeRequestHash, DEFAULT_ROUTE_PRICE_USDC } from "../middleware/x402.js";
import { filterAndScore, type RankedCandidate } from "../../engine/rankedScoring.js";
import type { ProviderId } from "../../types/schema.js";
import type { RequestLogStore } from "../../admin/requestLog.js";
import { createRequestTimingHooks } from "../middleware/requestTiming.js";

export interface RankRouteDeps {
  cache: IngestionCache;
  apiKeyStore: ApiKeyStore;
  creditLedger: CreditLedger;
  requestLog: RequestLogStore;
  routePriceUsdc?: number;
  // Real gap closed 2026-09-22 (Robert: "Production path is RunPod
  // only... do not recommend a provider we will 401/unsupported") —
  // required, not optional, so a route can't accidentally recommend a
  // provider nothing can actually book. index.ts derives this from the
  // same registered-bookers list POST /v1/route/book uses, so the two
  // routes can't drift out of sync with each other.
  bookableProviders: ProviderId[];
}

const RankRequestBody = z.object({
  gpuClass: z.string().optional(),
  minVramGb: z.number().nonnegative().optional(),
  region: z.string().optional(),
  maxPricePerHour: z.number().positive().optional(),
  preference: z.enum(["cheapest", "fastest", "balanced"]).default("cheapest"),
});

// Frozen response envelope (2026-09-23 pivot: agent-side parsers cache
// against this shape) — bump only when the envelope SHAPE changes, not
// on every deploy or data change.
const SCHEMA_VERSION = "1.0";

// Static, not derived from any request/cache state — this route can
// NEVER reserve or provision anything regardless of what's in the
// cache. A machine-checkable boundary an agent can assert on, not
// just a claim in prose.
const NOT_PROVISIONED_LIMITS = { not_reserved: true, not_provisioned: true, can_provision: false } as const;

function liveProviders(candidates: RankedCandidate[]): ProviderId[] {
  return [...new Set(candidates.filter((c) => c.source === "live_api").map((c) => c.provider))];
}

/**
 * POST /v1/compute/rank (canonical) — rules-only ranked scoring,
 * new/separate from POST /v1/route/quote by deliberate choice
 * (2026-09-22): the existing route's response is locked to
 * CLAUDE.md's provider_observed/scoutwyze_estimated/metadata
 * provenance split, and its dual-rail x402-or-Bearer auth always
 * charges on successful auth regardless of whether results exist.
 * This route's spec explicitly wants a flatter response and "debit
 * only if a real match exists" — different enough to be its own
 * endpoint rather than a breaking rewrite of the other one (and its
 * ~30 existing tests).
 *
 * Also registered at /v1/route/rank — legacy alias (2026-09-23
 * namespace cleanup: /v1/compute/* is the canonical path now that a
 * second vertical is on the roadmap; /v1/route/* kept live since
 * nothing has broken it yet, not because anything currently depends
 * on it).
 *
 * Bearer-only, no x402 fallback: an unrecognized/missing key is a
 * real 401 here, not a 402 x402 challenge.
 */
export function registerRankRoute(app: FastifyInstance, deps: RankRouteDeps): void {
  const routePriceUsdc = deps.routePriceUsdc ?? DEFAULT_ROUTE_PRICE_USDC;

  // Fastify's TS shorthand overloads don't accept an array of paths
  // (only app.route({ url: [...] }) does) — registered twice instead,
  // same handler, so canonical and legacy-alias truly can't drift.
  const handler: RouteHandlerMethod = async (request, reply) => {
    const parsedBody = RankRequestBody.safeParse(request.body ?? {});
    if (!parsedBody.success) {
      return reply.code(400).send({ error: "invalid_request", details: parsedBody.error.issues });
    }

    const authHeader = request.headers["authorization"];
    if (typeof authHeader !== "string" || !authHeader.startsWith("Bearer ")) {
      return reply.code(401).send({ error: "unauthorized", message: "Missing or malformed Authorization: Bearer <api_key> header." });
    }
    const rawKey = authHeader.slice("Bearer ".length).trim();
    const keyRecord = deps.apiKeyStore.lookupByRawKey(rawKey);
    if (!keyRecord) {
      return reply.code(401).send({ error: "unauthorized", message: "Unknown or revoked API key." });
    }

    // 402 on zero balance, BEFORE scoring — cheap short-circuit for
    // the common "never funded" case. A balance that's merely too low
    // for the actual charge (nonzero but < routePriceUsdc) is still
    // caught below, at the real atomic debit.
    if (deps.creditLedger.getBalance(keyRecord.accountId) <= 0) {
      return reply.code(402).send({ error: "insufficient_credits", message: "Zero balance.", balanceUsd: 0 });
    }

    const result = filterAndScore(parsedBody.data, deps.cache.getStates(), { allowedProviders: deps.bookableProviders });

    if (result.status === "no_inventory" || result.status === "no_match") {
      return reply.code(200).send({
        status: result.status,
        schema_version: SCHEMA_VERSION,
        billing: { billable: false, unit: "successful_rank", price_usd: routePriceUsdc },
      });
    }

    // Real eligible row exists — debit now, atomically, same
    // check-and-deduct guarantee as the existing Bearer rail.
    const requestHash = computeRequestHash(parsedBody.data);
    const charge = deps.creditLedger.charge(keyRecord.accountId, routePriceUsdc, requestHash);
    if (!charge.ok) {
      return reply.code(402).send({ error: "insufficient_credits", message: charge.reason, balanceUsd: charge.balanceUsd });
    }

    const [recommended, ...alternatives] = result.ranked as [RankedCandidate, ...RankedCandidate[]];
    return reply.code(200).send({
      status: "ok",
      schema_version: SCHEMA_VERSION,
      coverage: { vertical: "gpu_compute", providers_live: liveProviders(result.ranked) },
      recommended,
      alternatives,
      limits: NOT_PROVISIONED_LIMITS,
      billing: { billable: true, unit: "successful_rank", price_usd: routePriceUsdc, creditsRemaining: charge.balanceAfterUsd },
    });
  };

  // Timing hooks (admin console telemetry) — attached per-route, not
  // globally; see requestTiming.ts's own doc comment for why.
  const hooks = createRequestTimingHooks("compute_rank", deps.requestLog);
  app.post("/v1/compute/rank", hooks, handler);
  app.post("/v1/route/rank", hooks, handler);
}
