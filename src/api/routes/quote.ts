import type { FastifyInstance } from "fastify";
import { buildRouteQuoteResponse } from "../../engine/router.js";
import type { IngestionCache } from "../../ingestion/cache.js";
import type { ApiKeyStore } from "../../billing/apiKeyStore.js";
import type { CreditLedger } from "../../billing/creditLedger.js";
import type { ProcessedEventStore } from "../../payments/processedEvents.js";
import type { MinimalChainReader } from "../../payments/baseVerification.js";
import type { MinimalFacilitatorClient } from "../../payments/payAiFacilitator.js";
import type { ChallengeStore } from "../middleware/x402.js";
import { createAuthMiddleware } from "../middleware/auth.js";
import { validateQuoteRequest } from "../middleware/validateQuoteRequest.js";

export interface QuoteRouteDeps {
  cache: IngestionCache;
  apiKeyStore: ApiKeyStore;
  creditLedger: CreditLedger;
  challengeStore: ChallengeStore;
  processedEvents: ProcessedEventStore;
  chainReader: MinimalChainReader;
  facilitator: MinimalFacilitatorClient;
  treasuryAddress: string;
  quoteTtlSeconds: number;
  routePriceUsdc?: number;
  // See RankRouteDeps.publicBaseUrl in rank.ts for why this needs to
  // be a real absolute origin, not omitted.
  publicBaseUrl: string;
}

export function registerQuoteRoute(app: FastifyInstance, deps: QuoteRouteDeps): void {
  const authMiddleware = createAuthMiddleware({
    apiKeyStore: deps.apiKeyStore,
    creditLedger: deps.creditLedger,
    challengeStore: deps.challengeStore,
    processedEvents: deps.processedEvents,
    chainReader: deps.chainReader,
    facilitator: deps.facilitator,
    treasuryAddress: deps.treasuryAddress,
    routePriceUsdc: deps.routePriceUsdc,
    publicBaseUrl: deps.publicBaseUrl,
  });

  // Order matters: validate BEFORE auth/billing, so a malformed request
  // is rejected for free on both rails (see validateQuoteRequest.ts's
  // own header comment for the real bug this closes).
  app.post("/v1/route/quote", { preHandler: [validateQuoteRequest, authMiddleware] }, async (request, reply) => {
    // CLAUDE.md §4 — this handler reads deps.cache.getStates() only.
    // There is no adapter import, no fetch call, anywhere in this file.
    const response = buildRouteQuoteResponse(
      request.validatedQuoteRequest!,
      deps.cache.getStates(),
      deps.quoteTtlSeconds,
    );

    return reply.code(200).send(response);
  });
}
