import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { IngestionCache } from "../../ingestion/cache.js";
import type { ApiKeyStore } from "../../billing/apiKeyStore.js";
import type { CreditLedger } from "../../billing/creditLedger.js";
import { computeRequestHash } from "../middleware/x402.js";
import { filterAndScore } from "../../engine/rankedScoring.js";
import type { VendorBooker } from "../../engine/vendorBooker.js";
import type { ProviderId } from "../../types/schema.js";

export interface BookRouteDeps {
  cache: IngestionCache;
  apiKeyStore: ApiKeyStore;
  creditLedger: CreditLedger;
  bookers: VendorBooker[];
  bookingMargin?: number;
}

// Real gap closed, 2026-09-22: booking previously charged
// hours * vendorHourly with ZERO margin — a real pass-through, not a
// business. 0.15 (15%) is a documented DEFAULT, not a considered
// pricing decision — override via bookingMargin when a real number
// exists.
export const DEFAULT_BOOKING_MARGIN = 0.15;

// Deliberately NO provider field — "the server MUST re-run rank; do
// not trust a client-supplied provider" is enforced structurally here,
// not just by convention: there's nothing in this schema a client
// could even pass to influence which provider gets dispatched to.
const BookRequestBody = z.object({
  gpuClass: z.string().optional(),
  minVramGb: z.number().nonnegative().optional(),
  region: z.string().optional(),
  maxPricePerHour: z.number().positive().optional(),
  preference: z.enum(["cheapest", "fastest", "balanced"]).default("cheapest"),
  hours: z.number().positive().max(720), // 30 days — a sane safety bound, not a real business requirement
});

/**
 * POST /v1/route/book — re-runs the exact same server-side ranking as
 * POST /v1/route/rank, restricted to exactly the providers in
 * deps.bookers (the ranking pass can never recommend, and therefore
 * can never try to dispatch to, a provider with no registered
 * booker) — then dispatches to whichever provider that restricted
 * ranking recommends.
 *
 * Production is RunPod-only by deliberate choice (Robert, 2026-09-22):
 * index.ts registers only RunPodBooker in deps.bookers. LambdaLabsBooker
 * / SimulatedLambdaLabsBooker still exist in vendorBooker.ts but are
 * never instantiated or registered there — left in the repo, unused
 * and uncalled, not deleted, in case Lambda's account-side auth issue
 * (see docs/SOT or prior handoff — never resolved, not worth more time
 * per Robert) gets fixed later. The "unsupported_provider" response
 * below is now effectively unreachable in normal operation (ranking
 * and dispatch draw from the same deps.bookers list by construction)
 * but stays as a defensive fallback, not dead code removed outright —
 * cheap insurance against deps.bookers/ranking ever drifting apart.
 *
 * Debit-after-success, not before: the vendor booker is called FIRST;
 * CreditLedger.charge() only runs once it returns ok:true. A vendor
 * decline costs nothing. The one real edge case this ordering can't
 * fully close without a vendor-side cancel API (which doesn't exist):
 * if the vendor accepts but the account's balance is then insufficient
 * for the actual quoted price (nonzero but too low — the same gap the
 * literal "zero balance" pre-check on /v1/route/rank has), the
 * dispatch has already happened. Surfaced explicitly in that response
 * rather than silently swallowed.
 */
export function registerBookRoute(app: FastifyInstance, deps: BookRouteDeps): void {
  const bookersByProvider = new Map<ProviderId, VendorBooker>(deps.bookers.map((b) => [b.providerId, b]));
  const bookableProviders = deps.bookers.map((b) => b.providerId);
  const margin = deps.bookingMargin ?? DEFAULT_BOOKING_MARGIN;

  app.post("/v1/route/book", async (request, reply) => {
    const parsedBody = BookRequestBody.safeParse(request.body ?? {});
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

    if (deps.creditLedger.getBalance(keyRecord.accountId) <= 0) {
      return reply.code(402).send({ error: "insufficient_credits", message: "Zero balance.", balanceUsd: 0 });
    }

    const { hours, ...rankRequest } = parsedBody.data;
    const result = filterAndScore(rankRequest, deps.cache.getStates(), { allowedProviders: bookableProviders });

    if (result.status === "no_inventory") return reply.code(200).send({ status: "no_inventory" });
    if (result.status === "no_match") return reply.code(200).send({ status: "no_match" });

    const recommended = result.ranked[0]!;
    const booker = bookersByProvider.get(recommended.provider);
    if (!booker) {
      return reply.code(200).send({ status: "unsupported_provider", provider: recommended.provider, recommended });
    }

    const bookingResult = await booker.book({
      sku: recommended.sku,
      region: recommended.region,
      hours,
      vendorHourly: recommended.vendorHourly,
      gpuCount: recommended.gpuCount,
    });

    if (!bookingResult.ok) {
      // Vendor declined — no debit. The whole point of debit-after-success.
      return reply.code(200).send({ status: "vendor_declined", reason: bookingResult.reason, recommended });
    }

    const vendorCost = Math.round(hours * recommended.vendorHourly * 100) / 100;
    const quotedPrice = Math.round(vendorCost * (1 + margin) * 100) / 100;
    const requestHash = computeRequestHash(parsedBody.data);
    const charge = deps.creditLedger.charge(keyRecord.accountId, quotedPrice, requestHash);
    if (!charge.ok) {
      // Real edge case, see header comment: vendor already accepted,
      // balance turned out insufficient for the real amount. Surfaced
      // honestly, not silently dropped.
      return reply.code(402).send({
        error: "insufficient_credits",
        message: charge.reason,
        balanceUsd: charge.balanceUsd,
        warning: "Vendor already accepted this job before the balance check failed — no cancellation API exists to undo it.",
        vendor: recommended.provider,
        jobId: bookingResult.jobId,
      });
    }

    return reply.code(200).send({
      status: "ok",
      vendor: recommended.provider,
      jobId: bookingResult.jobId,
      connectInfo: bookingResult.connectInfo,
      quotedPrice,
      vendorCost,
      margin,
      creditsRemaining: charge.balanceAfterUsd,
    });
  });
}
