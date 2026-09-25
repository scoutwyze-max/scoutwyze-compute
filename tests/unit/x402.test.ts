import { describe, expect, it } from "vitest";
import {
  CHALLENGE_TTL_SECONDS,
  ChallengeStore,
  computeRequestHash,
  RECEIPT_TTL_SECONDS,
  signReceipt,
  verifyReceiptToken,
} from "../../src/api/middleware/x402.js";
import { BASE_USDC_CONTRACT_ADDRESS } from "../../src/payments/baseVerification.js";

const TEST_TREASURY_ADDRESS = "0xc132a315a05541a4b72c272de539eb86de977fb9";

describe("ChallengeStore — real x402 PaymentRequirements, stateless (2026-09-26 rewrite)", () => {
  // No DB, no pre-issued/consumed nonce anymore — real spec replay
  // protection is the EIP-3009 authorization's own nonce, enforced
  // on-chain by the USDC contract itself (see x402.ts's top-of-file
  // comment for the full reasoning behind this architecture change).

  it("issues well-formed, spec-compliant PaymentRequirements", () => {
    const store = new ChallengeStore(TEST_TREASURY_ADDRESS, BASE_USDC_CONTRACT_ADDRESS);
    const requirements = store.issue(0.15, "/v1/route/quote");
    expect(requirements.scheme).toBe("exact");
    expect(requirements.network).toBe("base");
    expect(requirements.payTo).toBe(TEST_TREASURY_ADDRESS);
    expect(requirements.asset).toBe(BASE_USDC_CONTRACT_ADDRESS);
    expect(requirements.maxTimeoutSeconds).toBe(CHALLENGE_TTL_SECONDS);
  });

  it("maxAmountRequired is atomic USDC units (6 decimals), not a human decimal string — real spec-compliance bug caught and fixed 2026-09-26", () => {
    // coinbase/x402's own spec: "Required payment amount in atomic
    // token units", example "10000" = 0.10 USDC. This server
    // previously sent "0.15" here, which no real spec-compliant
    // client would ever parse as atomic units.
    const store = new ChallengeStore(TEST_TREASURY_ADDRESS, BASE_USDC_CONTRACT_ADDRESS);
    const requirements = store.issue(0.15, "/v1/route/quote");
    expect(requirements.maxAmountRequired).toBe("150000");
  });

  it("resource reflects the real caller-supplied path, not a hardcoded one — real bug caught live 2026-09-24", () => {
    const store = new ChallengeStore(TEST_TREASURY_ADDRESS, BASE_USDC_CONTRACT_ADDRESS);
    const rankRequirements = store.issue(0.15, "/v1/compute/rank");
    expect(rankRequirements.resource).toBe("/v1/compute/rank");
    const quoteRequirements = store.issue(0.15, "/v1/route/quote");
    expect(quoteRequirements.resource).toBe("/v1/route/quote");
  });

  it("issuing twice for the same inputs is deterministic — no hidden state, no DB write", () => {
    const store = new ChallengeStore(TEST_TREASURY_ADDRESS, BASE_USDC_CONTRACT_ADDRESS);
    const first = store.issue(0.2, "/v1/compute/rank");
    const second = store.issue(0.2, "/v1/compute/rank");
    expect(first).toEqual(second);
  });
});

describe("computeRequestHash — the anti-scraping binding mechanism", () => {
  it("is stable across key ordering — the same logical request always hashes the same", () => {
    const a = computeRequestHash({ region: "us-east-1", workload_type: "inference" });
    const b = computeRequestHash({ workload_type: "inference", region: "us-east-1" });
    expect(a).toBe(b);
  });

  it("produces a different hash for a genuinely different request", () => {
    const a = computeRequestHash({ region: "us-east-1" });
    const b = computeRequestHash({ region: "us-west-1" });
    expect(a).not.toBe(b);
  });

  it("empty and undefined-ish requests hash consistently", () => {
    expect(computeRequestHash({})).toBe(computeRequestHash({}));
  });
});

describe("signReceipt / verifyReceiptToken", () => {
  it("round-trips a valid, unexpired receipt", () => {
    const now = Date.now();
    const payload = { requestHash: "abc123", nonce: "n1", issuedAtMs: now, expiresAtMs: now + RECEIPT_TTL_SECONDS * 1000 };
    const token = signReceipt(payload);

    const result = verifyReceiptToken(token, now + 5000);
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.payload).toEqual(payload);
  });

  it("rejects a receipt read after its own expiresAtMs", () => {
    const now = Date.now();
    const payload = { requestHash: "abc123", nonce: "n1", issuedAtMs: now, expiresAtMs: now + RECEIPT_TTL_SECONDS * 1000 };
    const token = signReceipt(payload);

    const result = verifyReceiptToken(token, now + (RECEIPT_TTL_SECONDS + 1) * 1000);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toMatch(/expired/);
  });

  it("rejects a tampered payload even if the signature format still looks valid", () => {
    const now = Date.now();
    const token = signReceipt({ requestHash: "abc123", nonce: "n1", issuedAtMs: now, expiresAtMs: now + 60_000 });
    const [body, signature] = token.split(".");
    // Swap in a different (still real) payload without re-signing it —
    // this is exactly what an attacker trying to reuse a receipt for a
    // different request hash would attempt.
    const forgedBody = Buffer.from(JSON.stringify({ requestHash: "FORGED", nonce: "n1", issuedAtMs: now, expiresAtMs: now + 60_000 })).toString("base64url");
    const forged = `${forgedBody}.${signature}`;

    const result = verifyReceiptToken(forged, now);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toMatch(/invalid receipt signature/);
  });

  it("rejects a malformed token that isn't even the right shape", () => {
    expect(verifyReceiptToken("not-a-real-token", Date.now()).valid).toBe(false);
    expect(verifyReceiptToken("too.many.dots.here", Date.now()).valid).toBe(false);
  });
});
