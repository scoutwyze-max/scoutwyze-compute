import type { FastifyReply, FastifyRequest } from "fastify";
import { RouteQuoteRequest, type RouteQuoteRequest as RouteQuoteRequestType } from "../../types/schema.js";

declare module "fastify" {
  interface FastifyRequest {
    validatedQuoteRequest?: RouteQuoteRequestType;
  }
}

/**
 * Real fix, found while building the credit ledger: this MUST run
 * before auth/billing, not after. Previously, schema validation
 * happened inside the route handler, after the auth preHandler had
 * already consumed an x402 nonce (or, with credits, would have already
 * deducted a balance) — meaning a malformed request could burn a real
 * payment/charge and still come back a 400. Splitting validation into
 * its own, earlier preHandler means a bad request is rejected for free,
 * on BOTH auth rails, before any money changes hands.
 */
export async function validateQuoteRequest(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const parsed = RouteQuoteRequest.safeParse(request.body ?? {});
  if (!parsed.success) {
    reply.code(400).send({
      error: "invalid_request",
      message: "Request body does not match RouteQuoteRequest schema.",
      details: parsed.error.issues,
    });
    return;
  }
  request.validatedQuoteRequest = parsed.data;
}
