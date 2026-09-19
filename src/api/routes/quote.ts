import type { FastifyInstance } from "fastify";
import { RouteQuoteRequest } from "../../types/schema.js";
import { buildRouteQuoteResponse } from "../../engine/router.js";
import type { IngestionCache } from "../../ingestion/cache.js";
import { createAuthMiddleware } from "../middleware/auth.js";

export interface QuoteRouteDeps {
  cache: IngestionCache;
  validApiKeys: Set<string>;
  quoteTtlSeconds: number;
}

export function registerQuoteRoute(app: FastifyInstance, deps: QuoteRouteDeps): void {
  const authMiddleware = createAuthMiddleware(deps.validApiKeys);

  app.post("/v1/route/quote", { preHandler: authMiddleware }, async (request, reply) => {
    const parsedBody = RouteQuoteRequest.safeParse(request.body ?? {});
    if (!parsedBody.success) {
      return reply.code(400).send({
        error: "invalid_request",
        message: "Request body does not match RouteQuoteRequest schema.",
        details: parsedBody.error.issues,
      });
    }

    // CLAUDE.md §4 — this handler reads deps.cache.getStates() only.
    // There is no adapter import, no fetch call, anywhere in this file.
    const response = buildRouteQuoteResponse(
      parsedBody.data,
      deps.cache.getStates(),
      deps.quoteTtlSeconds,
    );

    return reply.code(200).send(response);
  });
}
