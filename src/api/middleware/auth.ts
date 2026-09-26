import type { FastifyReply, FastifyRequest } from "fastify";
import type { ApiKeyStore } from "../../billing/apiKeyStore.js";
import type { CreditLedger } from "../../billing/creditLedger.js";
import type { ProcessedEventStore } from "../../payments/processedEvents.js";
import {
  checkEip3009AuthorizationBounds,
  recoverEip3009Signer,
  verifyOnChainUsdcTransfer,
  type MinimalChainReader,
} from "../../payments/baseVerification.js";
import type { MinimalFacilitatorClient } from "../../payments/payAiFacilitator.js";
import {
  ChallengeStore,
  computeRequestHash,
  decodePaymentHeader,
  DEFAULT_ROUTE_PRICE_USDC,
  RECEIPT_TTL_SECONDS,
  signReceipt,
  verifyReceiptToken,
  type X402ErrorCode,
  type X402PaymentSubmission,
} from "./x402.js";

export type AuthRail = "bearer" | "x402";

export interface AuthContext {
  rail: AuthRail;
  identifier: string; // keyId (bearer) or a nonce fragment (x402) — never the raw key/payload
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
  facilitator: MinimalFacilitatorClient;
  treasuryAddress: string;
  routePriceUsdc?: number;
  // Absolute origin used to build the x402 `resource` field as a real
  // fetchable URL — see RankRouteDeps.publicBaseUrl in rank.ts for the
  // full reasoning (same fix, same root cause).
  publicBaseUrl: string;
}

export interface X402VerifyDeps {
  challengeStore: ChallengeStore;
  processedEvents: ProcessedEventStore;
  chainReader: MinimalChainReader;
  facilitator: MinimalFacilitatorClient;
  treasuryAddress: string;
  routePriceUsdc: number;
  // The real path this challenge is FOR — every caller must say what
  // it's actually issuing payment requirements for.
  resource: string;
  // Optional Bazaar discovery extension (x402.ts's buildBazaarBodyExtension)
  // — attached at the top level of the 402 response as extensions.bazaar
  // when present.
  bazaarExtension?: Record<string, unknown>;
}

/**
 * Real x402 "exact" EVM scheme verification — EIP-3009
 * transferWithAuthorization, not the self-invented broadcast-then-
 * prove flow this file used before 2026-09-26 (see x402.ts's
 * top-of-file comment for the full story on why that was a real,
 * live spec-compliance bug, not a style choice).
 *
 * Six checks, in order, cheapest/most-locally-verifiable first:
 *   1. Decode the payload — real x402 v1 PaymentPayload shape
 *      (signature + authorization: from/to/value/validAfter/
 *      validBefore/nonce).
 *   2. Signature recovers to the claimed `authorization.from` (pure
 *      math, no network) — proves the claimed payer actually signed
 *      THIS exact transfer, not just any payment.
 *   3. Bounds check (no network) — `to` matches our treasury, `value`
 *      meets the required amount, current time is within
 *      [validAfter, validBefore).
 *   4. Verify via PayAI's facilitator's /verify, carrying
 *      serverExtensions.bazaar when present — fails fast on a bad
 *      payload before attempting settlement, and is the remaining
 *      untested candidate mechanism for real Bazaar discovery listing
 *      (SOT.md §6 — neither a bare successful /settle nor a bare
 *      /verify-with-extensions alone was found to trigger listing).
 *   5. Settle via PayAI's facilitator (payments/payAiFacilitator.ts)
 *      — this is the one step requiring a funded relayer wallet,
 *      which this server deliberately doesn't run itself; PayAI
 *      broadcasts transferWithAuthorization and reports the result.
 *   6. Independently re-verify the settled transaction on-chain
 *      ourselves (verifyOnChainUsdcTransfer, unchanged from before) —
 *      this server doesn't just trust PayAI's success claim, matching
 *      the trust-minimized posture everywhere else in this codebase.
 *
 * On success: sets the X-Payment-Receipt response header (same reuse
 * window as before) and returns {ok:true}. On failure: sends the 402
 * response itself and returns {ok:false} — callers must return
 * immediately without sending anything else.
 */
export async function verifyX402Payment(
  request: FastifyRequest,
  reply: FastifyReply,
  requestHash: string,
  deps: X402VerifyDeps,
): Promise<{ ok: true; nonce: string } | { ok: false }> {
  const now = Date.now();
  const nowSeconds = Math.floor(now / 1000);

  const receiptHeader = request.headers["x-payment-receipt"];
  if (typeof receiptHeader === "string" && receiptHeader) {
    const verification = verifyReceiptToken(receiptHeader, now);
    if (verification.valid && verification.payload.requestHash === requestHash) {
      return { ok: true, nonce: verification.payload.nonce };
    }
    // Invalid, expired, or request-hash-mismatched receipt falls
    // through to a fresh payment attempt rather than failing
    // immediately — the client may still have a valid X-PAYMENT header.
  }

  const paymentHeader = request.headers["x-payment"];
  const submission = decodePaymentHeader(typeof paymentHeader === "string" ? paymentHeader : undefined);

  if ("error" in submission) {
    sendPaymentRequired(reply, deps, submission.error, submission.code);
    return { ok: false };
  }

  const { authorization, signature } = submission.payload;

  // Check 1: signature proves control of authorization.from over this
  // EXACT to/value/validAfter/validBefore/nonce.
  const recovered = recoverEip3009Signer(authorization, signature);
  if (!recovered.valid) {
    sendPaymentRequired(reply, deps, recovered.reason, recovered.code);
    return { ok: false };
  }
  if (recovered.address.toLowerCase() !== authorization.from.toLowerCase()) {
    sendPaymentRequired(reply, deps, "signature does not match authorization.from", "invalid_exact_evm_payload_signature");
    return { ok: false };
  }

  // Check 2: to/value/time bounds — no network needed.
  const bounds = checkEip3009AuthorizationBounds(authorization, deps.treasuryAddress, deps.routePriceUsdc, nowSeconds);
  if (!bounds.valid) {
    sendPaymentRequired(reply, deps, bounds.reason, bounds.code);
    return { ok: false };
  }

  // Check 3: verify via PayAI before ever attempting settlement — cheap
  // fail-fast (avoids a wasted settlement attempt on an obviously bad
  // payload) and, per serverExtensions.bazaar, this is also PayAI's
  // real hook for Bazaar discovery listing (see payAiFacilitator.ts's
  // top-of-file comment; confirmed live 2026-09-26 that neither a bare
  // successful /settle nor a bare /verify with serverExtensions alone
  // triggers listing — this full verify-then-settle sequence is the
  // remaining untested combination).
  const paymentRequirements = deps.challengeStore.issue(deps.routePriceUsdc, deps.resource);
  const verifyResult = await deps.facilitator.verify(
    submission,
    paymentRequirements,
    deps.bazaarExtension ? { bazaar: deps.bazaarExtension } : undefined,
  );
  if (!verifyResult.isValid) {
    const code: X402ErrorCode = isKnownX402ErrorCode(verifyResult.invalidReason) ? verifyResult.invalidReason : "unexpected_verify_error";
    sendPaymentRequired(reply, deps, verifyResult.invalidMessage ?? verifyResult.invalidReason ?? "payment verification failed", code);
    return { ok: false };
  }

  // Check 4: settle via PayAI — broadcasts transferWithAuthorization.
  // Their own duplicate_settlement detection (backed by the USDC
  // contract's on-chain authorizationState mapping) is what actually
  // prevents this exact authorization being spent twice; we don't
  // duplicate that check ourselves.
  const settleResult = await deps.facilitator.settle(submission, paymentRequirements);
  if (!settleResult.success) {
    const code: X402ErrorCode = isKnownX402ErrorCode(settleResult.errorReason) ? settleResult.errorReason : "unexpected_verify_error";
    sendPaymentRequired(reply, deps, settleResult.errorMessage ?? "settlement failed", code);
    return { ok: false };
  }

  // Check 5: this exact settled transaction hasn't already been used
  // to grant a DIFFERENT request on our side (defense in depth beyond
  // what PayAI/the chain already guarantee).
  if (deps.processedEvents.isProcessed(settleResult.transaction)) {
    sendPaymentRequired(reply, deps, "this transaction has already been used to authorize a different payment", "duplicate_settlement");
    return { ok: false };
  }

  // Check 6: independently confirm the transfer on-chain ourselves —
  // don't just trust PayAI's success claim.
  const onChain = await verifyOnChainUsdcTransfer(deps.chainReader, settleResult.transaction, authorization.from, deps.treasuryAddress, deps.routePriceUsdc);
  if (!onChain.valid) {
    sendPaymentRequired(reply, deps, onChain.reason, onChain.code);
    return { ok: false };
  }

  deps.processedEvents.recordIfNew(settleResult.transaction, "base_onchain", authorization.from, deps.routePriceUsdc);

  const receipt = signReceipt({
    requestHash,
    nonce: authorization.nonce,
    issuedAtMs: now,
    expiresAtMs: now + RECEIPT_TTL_SECONDS * 1000,
  });
  reply.header("X-Payment-Receipt", receipt);
  return { ok: true, nonce: authorization.nonce };
}

const KNOWN_X402_ERROR_CODES = new Set<X402ErrorCode>([
  "invalid_payload",
  "invalid_exact_evm_payload_signature",
  "invalid_exact_evm_payload_authorization_value_mismatch",
  "invalid_exact_evm_payload_authorization_valid_after",
  "invalid_exact_evm_payload_authorization_valid_before",
  "invalid_exact_evm_payload_recipient_mismatch",
  "invalid_transaction_state",
  "unexpected_verify_error",
  "invalid_payment_requirements",
  "invalid_network",
  "invalid_scheme",
  "insufficient_funds",
  "insufficient_balance",
  "invalid_exact_evm_missing_eip712_domain",
  "invalid_exact_evm_insufficient_balance",
  "missing_fee_payer",
  "missing_facilitator_address",
  "fee_payer_not_managed_by_facilitator",
  "facilitator_address_not_managed_by_facilitator",
  "internal_server_error",
  "settlement_pending",
  "duplicate_settlement",
  "upto_channel_capacity_exhausted",
  "service_unavailable",
]);

// PayAI's errorReason is a free-form string per their own schema ("Handle
// unknown values"), not a closed enum — this guards against a future
// undocumented code leaking through as if it were one of ours.
function isKnownX402ErrorCode(value: string | undefined): value is X402ErrorCode {
  return typeof value === "string" && KNOWN_X402_ERROR_CODES.has(value as X402ErrorCode);
}

/**
 * CLAUDE.md §4 Dual-Rail — Bearer API keys (real, hashed, prepaid-
 * credit-backed) OR x402/USDC (machine-native), either sufficient.
 * Primary Path (Bearer) unchanged. Secondary Path (x402) delegates to
 * verifyX402Payment above.
 */
export function createAuthMiddleware(deps: AuthMiddlewareDeps) {
  const routePriceUsdc = deps.routePriceUsdc ?? DEFAULT_ROUTE_PRICE_USDC;

  return async function authMiddleware(request: FastifyRequest, reply: FastifyReply): Promise<void> {
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

    const result = await verifyX402Payment(request, reply, requestHash, {
      challengeStore: deps.challengeStore,
      processedEvents: deps.processedEvents,
      chainReader: deps.chainReader,
      facilitator: deps.facilitator,
      treasuryAddress: deps.treasuryAddress,
      routePriceUsdc,
      resource: `${deps.publicBaseUrl}/v1/route/quote`,
    });
    if (result.ok) {
      request.authContext = { rail: "x402", identifier: result.nonce.slice(0, 10) };
    }
    // On failure, verifyX402Payment already sent the 402 response.
  };
}

function sendPaymentRequired(reply: FastifyReply, deps: X402VerifyDeps, reason?: string, code?: X402ErrorCode): void {
  const requirements = deps.challengeStore.issue(deps.routePriceUsdc, deps.resource);
  reply.code(402).send({
    x402Version: 1,
    error: "payment_required",
    reason: reason ?? "no valid Authorization: Bearer <api_key> or X-PAYMENT header provided",
    // Machine-parseable companion to `reason` — omitted (not null) on
    // the very first, no-header-at-all challenge, since that's an
    // initial offer, not a rejected attempt.
    ...(code ? { code } : {}),
    accepts: [requirements],
    // Sibling of accepts, not nested inside it - verified against the
    // real x402-foundation PaymentRequired type.
    ...(deps.bazaarExtension ? { extensions: { bazaar: deps.bazaarExtension } } : {}),
  });
}

export type { X402PaymentSubmission };
