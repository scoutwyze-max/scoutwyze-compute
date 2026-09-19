/**
 * CLAUDE.md §4 Secondary Path — x402 protocol / USDC on Base.
 * V1 SCOPE (per direction): scaffold + mock-test the dual-auth
 * middleware shape; the real on-chain settlement/verification layer is
 * explicitly NOT built yet. This module is the seam where a real
 * facilitator call (verify the X-PAYMENT header's signed payload against
 * Base, confirm USDC settlement) drops in later without changing the
 * auth middleware's contract.
 */

export interface X402PaymentClaim {
  scheme: "exact";
  network: "base";
  payload: string; // opaque in mock mode — a real integration decodes/verifies this
  amountUsdc: number;
}

export interface X402VerificationResult {
  valid: boolean;
  reason?: string;
  claim?: X402PaymentClaim;
}

const MIN_ROUTE_PRICE_USDC = 0.1;
const MAX_ROUTE_PRICE_USDC = 0.25;

/**
 * Mock verifier: accepts a well-formed X-PAYMENT header and checks it
 * declares an amount in the CLAUDE.md-specified $0.10-$0.25+ range for a
 * deep evaluation. Does NOT verify anything against the Base network —
 * that's the real work a facilitator integration replaces this with.
 */
export function verifyX402PaymentMock(headerValue: string | undefined): X402VerificationResult {
  if (!headerValue) return { valid: false, reason: "missing X-PAYMENT header" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(headerValue, "base64").toString("utf-8"));
  } catch {
    return { valid: false, reason: "X-PAYMENT header is not valid base64-encoded JSON" };
  }

  const claim = parsed as Partial<X402PaymentClaim>;
  if (claim.scheme !== "exact" || claim.network !== "base") {
    return { valid: false, reason: "unsupported payment scheme/network" };
  }
  if (typeof claim.amountUsdc !== "number" || claim.amountUsdc < MIN_ROUTE_PRICE_USDC) {
    return { valid: false, reason: `amount below minimum route price ($${MIN_ROUTE_PRICE_USDC})` };
  }
  if (typeof claim.payload !== "string" || claim.payload.length === 0) {
    return { valid: false, reason: "missing settlement payload" };
  }

  return { valid: true, claim: claim as X402PaymentClaim };
}

export { MIN_ROUTE_PRICE_USDC, MAX_ROUTE_PRICE_USDC };
