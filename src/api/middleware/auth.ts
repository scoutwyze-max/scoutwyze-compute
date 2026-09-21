import type { FastifyReply, FastifyRequest } from "fastify";
import {
  challengeStore,
  computeRequestHash,
  decodePaymentHeader,
  DEFAULT_ROUTE_PRICE_USDC,
  RECEIPT_TTL_SECONDS,
  signReceipt,
  verifyReceiptToken,
} from "./x402.js";

export type AuthRail = "bearer" | "x402";

export interface AuthContext {
  rail: AuthRail;
  identifier: string; // API key (bearer) or a receipt/nonce fragment (x402) — never logged raw
}

declare module "fastify" {
  interface FastifyRequest {
    authContext?: AuthContext;
  }
}

/**
 * CLAUDE.md §4 Dual-Rail — Bearer API keys (conventional, prepaid
 * credits) OR x402/USDC (machine-native), either sufficient. For the
 * x402 rail specifically, this now implements the real challenge/
 * response protocol shape (CLAUDE.md: "checks for HTTP 402 challenge
 * requirements... when API keys are absent"), not just a header
 * presence check:
 *
 *   1. No credentials at all -> 402 with a fresh challenge (nonce, price).
 *   2. X-PAYMENT-RECEIPT header, still valid, request hash matches THIS
 *      request -> reuse it, no new payment/charge. Bound to the request
 *      hash so a receipt paid for one query can't be replayed to scrape
 *      a different one for free.
 *   3. X-PAYMENT header (fresh payment attempt) -> verified against the
 *      challenge store (real nonce, unused, unexpired, amount met) ->
 *      on success, a NEW signed receipt is issued (X-PAYMENT-RECEIPT
 *      response header) for reuse within RECEIPT_TTL_SECONDS.
 *   4. Anything invalid at any step (bad Bearer key, expired/reused
 *      nonce, wrong amount, receipt bound to a different request) ->
 *      fails closed: never grants access, always responds 402 with a
 *      FRESH challenge so a legitimate client has a clean path forward
 *      rather than a dead-end error.
 */
export function createAuthMiddleware(validApiKeys: Set<string>, routePriceUsdc = DEFAULT_ROUTE_PRICE_USDC) {
  return async function authMiddleware(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const now = Date.now();

    const authHeader = request.headers["authorization"];
    if (typeof authHeader === "string" && authHeader.startsWith("Bearer ")) {
      const key = authHeader.slice("Bearer ".length).trim();
      if (validApiKeys.has(key)) {
        request.authContext = { rail: "bearer", identifier: key };
        return;
      }
      // Invalid Bearer key deliberately does NOT reject outright — x402
      // is a genuine alternative rail, not just a fallback for missing
      // credentials.
    }

    const requestHash = computeRequestHash(request.body ?? {});

    const receiptHeader = request.headers["x-payment-receipt"];
    if (typeof receiptHeader === "string" && receiptHeader) {
      const verification = verifyReceiptToken(receiptHeader, now);
      if (verification.valid && verification.payload.requestHash === requestHash) {
        request.authContext = { rail: "x402", identifier: verification.payload.nonce.slice(0, 8) };
        return;
      }
      // Invalid, expired, or request-hash-mismatched receipt falls
      // through to a fresh payment attempt rather than failing
      // immediately — the client may still have a valid X-PAYMENT header.
    }

    const paymentHeader = request.headers["x-payment"];
    const submission = decodePaymentHeader(typeof paymentHeader === "string" ? paymentHeader : undefined);

    if (!("error" in submission)) {
      const consumed = challengeStore.consume(submission.nonce, submission.amountUsdc, now);
      if (consumed.ok) {
        const receipt = signReceipt({
          requestHash,
          nonce: submission.nonce,
          issuedAtMs: now,
          expiresAtMs: now + RECEIPT_TTL_SECONDS * 1000,
        });
        reply.header("X-Payment-Receipt", receipt);
        request.authContext = { rail: "x402", identifier: submission.nonce.slice(0, 8) };
        return;
      }
      // Fall through to issuing a fresh challenge — consumed.reason is
      // surfaced in the 402 body below, not swallowed.
      sendPaymentRequired(reply, routePriceUsdc, now, consumed.reason);
      return;
    }

    // No credentials of any kind, or a malformed X-PAYMENT that never
    // even reached the challenge store — same outcome either way: a
    // clean 402 challenge, not a dead-end error.
    sendPaymentRequired(reply, routePriceUsdc, now);
  };
}

function sendPaymentRequired(reply: FastifyReply, priceUsdc: number, now: number, reason?: string): void {
  const challenge = challengeStore.issue(priceUsdc, now);
  reply.code(402).send({
    x402Version: 1,
    error: "payment_required",
    reason: reason ?? "no valid Authorization: Bearer <api_key> or X-PAYMENT header provided",
    accepts: [challenge],
  });
}
