import { describe, expect, it, beforeEach } from "vitest";
import type Database from "better-sqlite3";
import { createDatabase } from "../../src/db/connection.js";
import {
  CHALLENGE_TTL_SECONDS,
  ChallengeStore,
  computeRequestHash,
  RECEIPT_TTL_SECONDS,
  signReceipt,
  verifyReceiptToken,
} from "../../src/api/middleware/x402.js";

const TEST_TREASURY_ADDRESS = "0xc132a315a05541a4b72c272de539eb86de977fb9";

describe("ChallengeStore — single-use nonce enforcement", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = createDatabase(":memory:");
  });

  it("issues a well-formed challenge with a real nonce", () => {
    const store = new ChallengeStore(db, TEST_TREASURY_ADDRESS);
    const challenge = store.issue(0.15, Date.now());
    expect(challenge.nonce).toBeTruthy();
    expect(challenge.scheme).toBe("exact");
    expect(challenge.network).toBe("base");
    expect(challenge.maxAmountRequired).toBe("0.15");
    expect(challenge.payTo).toBe(TEST_TREASURY_ADDRESS);
  });

  it("consumes a fresh, valid nonce exactly once", () => {
    const store = new ChallengeStore(db, TEST_TREASURY_ADDRESS);
    const now = Date.now();
    const { nonce } = store.issue(0.15, now);

    expect(store.consume(nonce, 0.15, now)).toEqual({ ok: true });
    expect(store.consume(nonce, 0.15, now)).toEqual({
      ok: false,
      reason: "nonce already used — replay attempt rejected",
    });
  });

  it("rejects a nonce that was never issued", () => {
    const store = new ChallengeStore(db, TEST_TREASURY_ADDRESS);
    const result = store.consume("never-issued", 0.15, Date.now());
    expect(result).toEqual({ ok: false, reason: "unknown or already-expired challenge nonce" });
  });

  it("rejects an amount below what the challenge required", () => {
    const store = new ChallengeStore(db, TEST_TREASURY_ADDRESS);
    const now = Date.now();
    const { nonce } = store.issue(0.2, now);
    const result = store.consume(nonce, 0.1, now);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/below the required \$0\.2/);
  });

  it("CLAUDE.md §3 'times out' — a nonce submitted after CHALLENGE_TTL_SECONDS is rejected, not silently honored", () => {
    const store = new ChallengeStore(db, TEST_TREASURY_ADDRESS);
    const issuedAt = Date.now();
    const { nonce } = store.issue(0.15, issuedAt);

    const justBeforeTimeout = issuedAt + (CHALLENGE_TTL_SECONDS - 1) * 1000;
    const justAfterTimeout = issuedAt + (CHALLENGE_TTL_SECONDS + 1) * 1000;

    // Confirm it's genuinely still valid right up to the boundary —
    // otherwise the "timed out" assertion below wouldn't prove the TTL
    // is what triggered the rejection.
    const freshStore = new ChallengeStore(db, TEST_TREASURY_ADDRESS);
    const fresh = freshStore.issue(0.15, issuedAt);
    expect(freshStore.consume(fresh.nonce, 0.15, justBeforeTimeout)).toEqual({ ok: true });

    const result = store.consume(nonce, 0.15, justAfterTimeout);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/timed out/);
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
