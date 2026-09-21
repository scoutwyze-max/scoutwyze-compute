import type { FastifyReply, FastifyRequest } from "fastify";
import type { ApiKeyStore } from "../../billing/apiKeyStore.js";
import type { CreditLedger } from "../../billing/creditLedger.js";
import type { ProcessedEventStore } from "../../payments/processedEvents.js";
import {
  buildPaymentAuthorizationMessage,
  recoverPayerAddress,
  verifyOnChainUsdcTransfer,
  type MinimalChainReader,
} from "../../payments/baseVerification.js";
import {
  ChallengeStore,
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
  challengeStore: ChallengeStore;
  processedEvents: ProcessedEventStore;
  chainReader: MinimalChainReader;
  treasuryAddress: string;
  routePriceUsdc?: number;
}

/**
 * CLAUDE.md §4 Dual-Rail — Bearer API keys (real, hashed, prepaid-
 * credit-backed) OR x402/USDC (machine-native), either sufficient.
 *
 * Primary Path (Bearer): unchanged from the credit-ledger pass — see
 * that commit for the full writeup.
 *
 * Secondary Path (x402): now REAL settlement verification, not mocked.
 * Three independent checks, all must pass:
 *   1. Nonce is real, unused, unexpired (ChallengeStore, unchanged).
 *   2. The submitted signature recovers to the claimed payerAddress
 *      over a canonical message binding nonce+amount+txHash+network —
 *      proves the claimed payer actually authorized THIS payment, not
 *      just any payment (baseVerification.ts, real ECDSA recovery).
 *   3. That exact txHash is a real, successful, on-chain USDC Transfer
 *      on Base from payerAddress to OUR treasury address for at least
 *      the required amount (a real RPC read) — AND that txHash hasn't
 *      already been used to authorize a different request (real
 *      transfers can be reused against multiple nonces otherwise,
 *      since the nonce alone only protects the challenge, not the
 *      underlying payment proof).
 * Order matters: nonce is consumed FIRST (existing atomic pattern) —
 * if the later, async checks fail, that nonce is burned and the client
 * must request a fresh challenge. Acceptable V1 tradeoff: it keeps the
 * single-use property enforced by one atomic DB transaction rather
 * than needing a check-then-async-then-consume dance that would open
 * its own race window.
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
      const consumed = deps.challengeStore.consume(submission.nonce, submission.amountUsdc, now);
      if (!consumed.ok) {
        sendPaymentRequired(reply, deps.challengeStore, routePriceUsdc, now, consumed.reason);
        return;
      }

      // Check 2: signature proves payerAddress authorized this exact
      // nonce/amount/txHash.
      const message = buildPaymentAuthorizationMessage({
        nonce: submission.nonce,
        amountUsdc: submission.amountUsdc,
        txHash: submission.txHash,
        network: "base",
      });
      const recovered = recoverPayerAddress(message, submission.signature);
      if (!recovered.valid || recovered.address.toLowerCase() !== submission.payerAddress.toLowerCase()) {
        sendPaymentRequired(
          reply,
          deps.challengeStore,
          routePriceUsdc,
          now,
          !recovered.valid ? recovered.reason : "signature does not match claimed payerAddress",
        );
        return;
      }

      // Check 2.5: this exact on-chain payment hasn't already been
      // used to authorize a DIFFERENT request — the nonce alone
      // doesn't prevent reusing one real transfer against many nonces.
      const txAlreadyUsed = deps.processedEvents.isProcessed(submission.txHash);
      if (txAlreadyUsed) {
        sendPaymentRequired(reply, deps.challengeStore, routePriceUsdc, now, "this transaction has already been used to authorize a different payment");
        return;
      }

      // Check 3: the transfer actually happened on-chain, to us, for
      // enough USDC.
      const onChain = await verifyOnChainUsdcTransfer(
        deps.chainReader,
        submission.txHash,
        submission.payerAddress,
        deps.treasuryAddress,
        submission.amountUsdc,
      );
      if (!onChain.valid) {
        sendPaymentRequired(reply, deps.challengeStore, routePriceUsdc, now, onChain.reason);
        return;
      }

      deps.processedEvents.recordIfNew(submission.txHash, "base_onchain", submission.payerAddress, submission.amountUsdc);

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

    sendPaymentRequired(reply, deps.challengeStore, routePriceUsdc, now);
  };
}

function sendPaymentRequired(reply: FastifyReply, challengeStore: ChallengeStore, priceUsdc: number, now: number, reason?: string): void {
  const challenge = challengeStore.issue(priceUsdc, now);
  reply.code(402).send({
    x402Version: 1,
    error: "payment_required",
    reason: reason ?? "no valid Authorization: Bearer <api_key> or X-PAYMENT header provided",
    accepts: [challenge],
  });
}
