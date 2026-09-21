import type { FastifyReply, FastifyRequest } from "fastify";
import type { ApiKeyStore } from "../../billing/apiKeyStore.js";
import type { CreditLedger } from "../../billing/creditLedger.js";
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
  identifier: string; // keyId (bearer) or a receipt/nonce fragment (x402) — never the raw key/payload
}

declare module "fastify" {
  interface FastifyRequest {
    authContext?: AuthContext;
  }
}

export interface AuthMiddlewareDeps {
  apiKeyStore: ApiKeyStore;
  creditLedger: CreditLedger;
  routePriceUsdc?: number;
}

/**
 * CLAUDE.md §4 Dual-Rail — Bearer API keys (real, hashed, prepaid-
 * credit-backed) OR x402/USDC (machine-native), either sufficient.
 *
 * Primary Path (Bearer): looks up the real key via ApiKeyStore (never
 * compares raw key strings — see that module's own header comment),
 * then atomically checks-and-deducts the route's price from that
 * account's CreditLedger balance. A recognized key with insufficient
 * balance gets a SPECIFIC "insufficient_credits" 402 (top up), not the
 * generic x402 challenge — those are different problems with different
 * fixes, and silently redirecting a legitimate prepaid customer into
 * "pay again via crypto" without saying why would be a bad surprise.
 * An unrecognized/revoked key, by contrast, genuinely has no rail
 * engaged yet, so it falls through to offering x402 as a real
 * alternative rather than dead-ending.
 *
 * Secondary Path (x402): unchanged protocol from the prior pass — real
 * challenge/nonce/receipt cycle, see x402.ts for the full writeup.
 *
 * This middleware assumes validateQuoteRequest has ALREADY run (see
 * that module) — request.validatedQuoteRequest exists and nothing here
 * needs to guess at body shape before charging for it.
 */
export function createAuthMiddleware(deps: AuthMiddlewareDeps) {
  const routePriceUsdc = deps.routePriceUsdc ?? DEFAULT_ROUTE_PRICE_USDC;

  return async function authMiddleware(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const now = Date.now();
    // Hash the VALIDATED/defaulted request (set by validateQuoteRequest,
    // which must run before this middleware), not the raw body — two
    // requests differing only by an omitted vs. explicit default value
    // (e.g. workload_type) represent the identical query and must hash
    // identically, or a legitimate receipt-reuse retry would spuriously
    // fail the request-hash binding check.
    const requestHash = computeRequestHash(request.validatedQuoteRequest ?? {});

    const authHeader = request.headers["authorization"];
    if (typeof authHeader === "string" && authHeader.startsWith("Bearer ")) {
      const rawKey = authHeader.slice("Bearer ".length).trim();
      const keyRecord = deps.apiKeyStore.lookupByRawKey(rawKey);
      if (keyRecord) {
        const charge = deps.creditLedger.charge(keyRecord.accountId, routePriceUsdc, requestHash);
        if (charge.ok) {
          request.authContext = { rail: "bearer", identifier: keyRecord.keyId };
          return;
        }
        reply.code(402).send({
          error: "insufficient_credits",
          message: charge.reason,
          balanceUsd: charge.balanceUsd,
          requiredUsd: routePriceUsdc,
        });
        return;
      }
      // Unrecognized/revoked key — fall through to x402 rather than
      // reject outright; it's a genuine alternative rail, not just a
      // fallback for missing credentials.
    }

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
      sendPaymentRequired(reply, routePriceUsdc, now, consumed.reason);
      return;
    }

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
