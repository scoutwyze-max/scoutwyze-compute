import type { FastifyInstance, RouteHandlerMethod } from "fastify";
import { z } from "zod";
import type { IngestionCache } from "../../ingestion/cache.js";
import type { ApiKeyStore } from "../../billing/apiKeyStore.js";
import type { CreditLedger } from "../../billing/creditLedger.js";
import type { ProcessedEventStore } from "../../payments/processedEvents.js";
import type { MinimalChainReader } from "../../payments/baseVerification.js";
import type { MinimalFacilitatorClient } from "../../payments/payAiFacilitator.js";
import type { ChallengeStore } from "../middleware/x402.js";
import { computeRequestHash, DEFAULT_ROUTE_PRICE_USDC, buildBazaarBodyExtension } from "../middleware/x402.js";
import { verifyX402Payment } from "../middleware/auth.js";
import { filterAndScore, type RankedCandidate } from "../../engine/rankedScoring.js";
import type { ProviderId } from "../../types/schema.js";
import type { RequestLogStore } from "../../admin/requestLog.js";
import { createRequestTimingHooks } from "../middleware/requestTiming.js";

export interface RankRouteDeps {
  cache: IngestionCache;
  apiKeyStore: ApiKeyStore;
  creditLedger: CreditLedger;
  requestLog: RequestLogStore;
  // x402 rail (2026-09-24) — same real deps quote.ts already wires,
  // reused here via auth.ts's verifyX402Payment rather than duplicated.
  challengeStore: ChallengeStore;
  processedEvents: ProcessedEventStore;
  chainReader: MinimalChainReader;
  facilitator: MinimalFacilitatorClient;
  treasuryAddress: string;
  routePriceUsdc?: number;
  // Absolute origin (e.g. "https://scoutwyze-compute.fly.dev") used to
  // build the x402 `resource` field as a real fetchable URL, not just
  // a path — PayAI's Bazaar catalog documents `resource` as "URL of
  // the payable resource" and its real entries are all absolute URLs
  // (confirmed live 2026-09-26 against GET /discovery/resources); a
  // bare path gives its indexer nothing to crawl back to read our own
  // `extensions.bazaar` declaration from.
  publicBaseUrl: string;
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

// x402 Bazaar discovery declaration (2026-09-24) — attached to this
// route's 402 responses so a facilitator that implements the Bazaar
// extension can catalog it once a real payment settles (see
// x402.ts's buildBazaarBodyExtension for the schema source/reasoning).
// inputJsonSchema hand-mirrors RankRequestBody above field-for-field —
// no zod-to-JSON-Schema dependency added for five static properties.
const RANK_BAZAAR_EXTENSION = buildBazaarBodyExtension({
  method: "POST",
  inputExample: { gpuClass: "H100", preference: "cheapest" },
  inputJsonSchema: {
    type: "object",
    properties: {
      gpuClass: { type: "string", description: "Filter by GPU model substring, e.g. H100 (case-insensitive)" },
      minVramGb: { type: "number", minimum: 0, description: "Minimum GPU memory in GB" },
      region: { type: "string", description: "Filter by region prefix (case-insensitive)" },
      maxPricePerHour: { type: "number", exclusiveMinimum: 0, description: "Maximum vendor hourly price in USD" },
      preference: { type: "string", enum: ["cheapest", "fastest", "balanced"], description: "Ranking strategy - defaults to cheapest" },
    },
  },
  // Real production shape, trimmed to one alternative — matches what
  // this route actually returns, not a hypothetical.
  outputExample: {
    status: "ok",
    schema_version: "1.0",
    coverage: { vertical: "gpu_compute", providers_live: ["runpod"] },
    recommended: {
      provider: "runpod",
      sku: "NVIDIA H100 80GB HBM3",
      region: "US-CA-2",
      vendorHourly: 2.69,
      vramGb: 80,
      gpuCount: 1,
      observed_at: "2026-09-24T00:00:00.000Z",
      freshness_seconds: 12,
      source: "live_api",
      availability_status: "low",
      classification: "provider_reported",
      score: 0.94,
      scoreBreakdown: { priceScore: 0.93, freshnessScore: 0.99, weights: { price: 0.8, freshness: 0.2 }, ageMinutes: 0.2 },
      reason: "Cheapest match on runpod: $2.69/hr (price score 0.93), updated just now.",
    },
    alternatives: [],
    limits: { not_reserved: true, not_provisioned: true, can_provision: false },
    billing: { billable: true, unit: "successful_rank", price_usd: 0.15, rail: "x402" },
  },
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
 * provenance split. That separation still holds.
 *
 * Also registered at /v1/route/rank — legacy alias (2026-09-23
 * namespace cleanup).
 *
 * Dual-rail as of 2026-09-24 (extends x402 cleanly onto this route,
 * reusing auth.ts's verifyX402Payment — see that function's own doc
 * comment for the full reasoning). The two rails settle differently,
 * documented here rather than hidden:
 *   - Bearer: debit deferred until AFTER scoring — a no_match/
 *     no_inventory result is never charged. Unchanged from before.
 *   - x402: settles on successful payment verification, BEFORE
 *     scoring — real USDC has already moved on-chain by the time this
 *     handler knows whether there's a match, and there is no refund
 *     path for a no-match result. Same behavior quote.ts already has;
 *     now also true here. Every response's billing.rail field tells
 *     the caller which guarantee applied to that specific request.
 * A Bearer header with an unrecognized/revoked key, or no
 * Authorization header at all, falls through to attempt x402 — same
 * "genuine alternative rail, not a fallback for missing credentials"
 * behavior quote.ts already has. A recognized Bearer key with zero
 * balance still hard-402s without attempting x402 (matches quote's
 * own precedent: a known-but-broke Bearer key never falls through).
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
    const requestHash = computeRequestHash(parsedBody.data);

    let rail: "bearer" | "x402";
    let accountId: string | null = null; // only set on the Bearer rail — x402 has no ledger account to charge

    const authHeader = request.headers["authorization"];
    const bearerAttempted = typeof authHeader === "string" && authHeader.startsWith("Bearer ");
    const keyRecord = bearerAttempted ? deps.apiKeyStore.lookupByRawKey(authHeader.slice("Bearer ".length).trim()) : null;

    if (keyRecord) {
      // Recognized key — zero-balance hard-402s WITHOUT attempting
      // x402, matching quote.ts's own precedent (a known-but-broke
      // Bearer key never falls through there either).
      if (deps.creditLedger.getBalance(keyRecord.accountId) <= 0) {
        return reply.code(402).send({ error: "insufficient_credits", message: "Zero balance.", balanceUsd: 0 });
      }
      rail = "bearer";
      accountId = keyRecord.accountId;
      // Admin console request log (2026-09-25) — mirrors what
      // createAuthMiddleware already sets for quote.ts; rank.ts does
      // its own dual-rail handling inline so it has to set this too.
      request.authContext = { rail, identifier: keyRecord.keyId };
    } else {
      // No Authorization header, malformed, or an unrecognized/revoked
      // key — all fall through to x402 as a genuine alternative rail.
      const x402Result = await verifyX402Payment(request, reply, requestHash, {
        challengeStore: deps.challengeStore,
        processedEvents: deps.processedEvents,
        chainReader: deps.chainReader,
        facilitator: deps.facilitator,
        treasuryAddress: deps.treasuryAddress,
        routePriceUsdc,
        resource: `${deps.publicBaseUrl}/v1/compute/rank`,
        bazaarExtension: RANK_BAZAAR_EXTENSION,
      });
      if (!x402Result.ok) return; // verifyX402Payment already sent the 402 challenge
      rail = "x402";
      request.authContext = { rail, identifier: x402Result.nonce.slice(0, 8) };
    }

    const result = filterAndScore(parsedBody.data, deps.cache.getStates(), { allowedProviders: deps.bookableProviders });

    if (result.status === "no_inventory" || result.status === "no_match") {
      return reply.code(200).send({
        status: result.status,
        schema_version: SCHEMA_VERSION,
        billing:
          rail === "bearer"
            ? { billable: false, unit: "successful_rank", price_usd: routePriceUsdc, rail }
            : {
                // x402 already settled before scoring ran — see this
                // route's own doc comment. Billable is true here
                // because it WAS billed, not because this response is
                // being charged now.
                billable: true,
                unit: "successful_rank",
                price_usd: routePriceUsdc,
                rail,
                note: "Payment settled on-chain before scoring ran. x402 has no refund path for a no-match result — unlike the Bearer rail, which never charges when there's no match.",
              },
      });
    }

    const [recommended, ...alternatives] = result.ranked as [RankedCandidate, ...RankedCandidate[]];

    if (rail === "bearer") {
      // Real eligible row exists — debit now, atomically, same
      // check-and-deduct guarantee as before.
      const charge = deps.creditLedger.charge(accountId!, routePriceUsdc, requestHash);
      if (!charge.ok) {
        return reply.code(402).send({ error: "insufficient_credits", message: charge.reason, balanceUsd: charge.balanceUsd });
      }
      return reply.code(200).send({
        status: "ok",
        schema_version: SCHEMA_VERSION,
        coverage: { vertical: "gpu_compute", providers_live: liveProviders(result.ranked) },
        recommended,
        alternatives,
        limits: NOT_PROVISIONED_LIMITS,
        billing: { billable: true, unit: "successful_rank", price_usd: routePriceUsdc, rail, creditsRemaining: charge.balanceAfterUsd },
      });
    }

    // x402 — already settled before scoring; no ledger, no creditsRemaining.
    return reply.code(200).send({
      status: "ok",
      schema_version: SCHEMA_VERSION,
      coverage: { vertical: "gpu_compute", providers_live: liveProviders(result.ranked) },
      recommended,
      alternatives,
      limits: NOT_PROVISIONED_LIMITS,
      billing: { billable: true, unit: "successful_rank", price_usd: routePriceUsdc, rail },
    });
  };

  // Timing hooks (admin console telemetry) — attached per-route, not
  // globally; see requestTiming.ts's own doc comment for why.
  const hooks = createRequestTimingHooks("compute_rank", deps.requestLog);
  app.post("/v1/compute/rank", hooks, handler);
  app.post("/v1/route/rank", hooks, handler);
}
