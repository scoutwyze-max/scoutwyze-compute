import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { IngestionCache } from "../../ingestion/cache.js";
import type { ApiKeyStore } from "../../billing/apiKeyStore.js";
import type { CreditLedger } from "../../billing/creditLedger.js";
import { computeRequestHash, DEFAULT_ROUTE_PRICE_USDC } from "../middleware/x402.js";
import { filterAndScore, type RankedCandidate } from "../../engine/rankedScoring.js";
import type { ProviderId } from "../../types/schema.js";

export interface RankRouteDeps {
  cache: IngestionCache;
  apiKeyStore: ApiKeyStore;
  creditLedger: CreditLedger;
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

/**
 * POST /v1/route/rank — rules-only ranked scoring, new/separate from
 * POST /v1/route/quote by deliberate choice (2026-09-22): the existing
 * route's response is locked to CLAUDE.md's provider_observed/
 * scoutwyze_estimated/metadata provenance split, and its dual-rail
 * x402-or-Bearer auth always charges on successful auth regardless of
 * whether results exist. This route's spec explicitly wants a flatter
 * response and "debit only if a real match exists" — different enough
 * to be its own endpoint rather than a breaking rewrite of the other
 * one (and its ~30 existing tests).
 *
 * Bearer-only, no x402 fallback: an unrecognized/missing key is a
 * real 401 here, not a 402 x402 challenge.
 */
export function registerRankRoute(app: FastifyInstance, deps: RankRouteDeps): void {
  const routePriceUsdc = deps.routePriceUsdc ?? DEFAULT_ROUTE_PRICE_USDC;

  app.post("/v1/route/rank", async (request, reply) => {
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

    if (result.status === "no_inventory") {
      return reply.code(200).send({ status: "no_inventory" });
    }
    if (result.status === "no_match") {
      return reply.code(200).send({ status: "no_match" });
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
      recommended,
      alternatives,
      creditsRemaining: charge.balanceAfterUsd,
    });
  });
}
