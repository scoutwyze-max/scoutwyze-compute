import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { verifyStripeSignature, parseCheckoutCompletedEvent } from "../../src/payments/stripeWebhook.js";

const SECRET = "whsec_test_secret";

function sign(rawBody: string, timestampSeconds: number, secret = SECRET): string {
  const signedPayload = `${timestampSeconds}.${rawBody}`;
  const signature = createHmac("sha256", secret).update(signedPayload).digest("hex");
  return `t=${timestampSeconds},v1=${signature}`;
}

describe("verifyStripeSignature", () => {
  it("accepts a correctly signed, fresh payload", () => {
    const body = JSON.stringify({ id: "evt_1" });
    const now = Date.now();
    const header = sign(body, Math.floor(now / 1000));
    expect(verifyStripeSignature(body, header, SECRET, now)).toEqual({ valid: true });
  });

  it("rejects when no signature header is present", () => {
    const result = verifyStripeSignature("{}", undefined, SECRET, Date.now());
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toMatch(/missing Stripe-Signature/);
  });

  it("rejects a malformed header (no t= or v1=)", () => {
    const result = verifyStripeSignature("{}", "garbage-header", SECRET, Date.now());
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toMatch(/malformed/);
  });

  it("rejects a signature computed with the wrong secret — proves it isn't just checking shape", () => {
    const body = JSON.stringify({ id: "evt_1" });
    const now = Date.now();
    const header = sign(body, Math.floor(now / 1000), "whsec_wrong_secret");
    const result = verifyStripeSignature(body, header, SECRET, now);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toMatch(/does not match/);
  });

  it("rejects a tampered body even with an otherwise well-formed signature header", () => {
    const originalBody = JSON.stringify({ id: "evt_1", amount: 100 });
    const now = Date.now();
    const header = sign(originalBody, Math.floor(now / 1000));
    const tamperedBody = JSON.stringify({ id: "evt_1", amount: 999999 });
    const result = verifyStripeSignature(tamperedBody, header, SECRET, now);
    expect(result.valid).toBe(false);
  });

  it("rejects a stale timestamp beyond the tolerance window — replay defense", () => {
    const body = JSON.stringify({ id: "evt_1" });
    const now = Date.now();
    const staleTimestamp = Math.floor(now / 1000) - 301; // just past the default 300s tolerance
    const header = sign(body, staleTimestamp);
    const result = verifyStripeSignature(body, header, SECRET, now);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toMatch(/too old/);
  });

  it("accepts a timestamp right at the tolerance boundary", () => {
    const body = JSON.stringify({ id: "evt_1" });
    // Exact-second `now` (no ms fraction) so ageSeconds lands on exactly
    // 300, not 300-point-something from a truncated timestamp — this is
    // genuinely testing the boundary, not "just past it by a few ms".
    const nowSeconds = Math.floor(Date.now() / 1000);
    const now = nowSeconds * 1000;
    const boundaryTimestamp = nowSeconds - 300;
    const header = sign(body, boundaryTimestamp);
    expect(verifyStripeSignature(body, header, SECRET, now)).toEqual({ valid: true });
  });

  it("accepts when ANY of multiple v1 values matches (secret rotation support)", () => {
    const body = JSON.stringify({ id: "evt_1" });
    const now = Date.now();
    const timestamp = Math.floor(now / 1000);
    const correctSig = sign(body, timestamp).split("v1=")[1];
    const wrongSig = "0".repeat(64);
    const header = `t=${timestamp},v1=${wrongSig},v1=${correctSig}`;
    expect(verifyStripeSignature(body, header, SECRET, now)).toEqual({ valid: true });
  });

  it("does not throw on a v1 value of the wrong length (would crash a naive timingSafeEqual call)", () => {
    const body = JSON.stringify({ id: "evt_1" });
    const now = Date.now();
    const header = `t=${Math.floor(now / 1000)},v1=deadbeef`; // way shorter than a real 64-hex-char HMAC
    expect(() => verifyStripeSignature(body, header, SECRET, now)).not.toThrow();
    expect(verifyStripeSignature(body, header, SECRET, now).valid).toBe(false);
  });
});

describe("parseCheckoutCompletedEvent", () => {
  it("parses a valid checkout.session.completed event", () => {
    const body = JSON.stringify({
      id: "evt_123",
      type: "checkout.session.completed",
      data: { object: { metadata: { accountId: "acct_1" }, amount_total: 2000 } },
    });
    const result = parseCheckoutCompletedEvent(body);
    expect(result).toEqual({ eventId: "evt_123", accountId: "acct_1", amountUsd: 20 });
  });

  it("rejects non-JSON bodies", () => {
    const result = parseCheckoutCompletedEvent("not json");
    expect("error" in result).toBe(true);
  });

  it("ignores (does not error-throw on) an event of a different type", () => {
    const body = JSON.stringify({ id: "evt_1", type: "payment_intent.created" });
    const result = parseCheckoutCompletedEvent(body);
    expect("error" in result).toBe(true);
    if ("error" in result) expect(result.error).toMatch(/unhandled event type/);
  });

  it("rejects a checkout session missing metadata.accountId", () => {
    const body = JSON.stringify({
      id: "evt_123",
      type: "checkout.session.completed",
      data: { object: { metadata: {}, amount_total: 2000 } },
    });
    const result = parseCheckoutCompletedEvent(body);
    expect("error" in result).toBe(true);
    if ("error" in result) expect(result.error).toMatch(/metadata.accountId/);
  });

  it("rejects a checkout session with a missing or zero amount_total", () => {
    const body = JSON.stringify({
      id: "evt_123",
      type: "checkout.session.completed",
      data: { object: { metadata: { accountId: "acct_1" }, amount_total: 0 } },
    });
    const result = parseCheckoutCompletedEvent(body);
    expect("error" in result).toBe(true);
    if ("error" in result) expect(result.error).toMatch(/amount_total/);
  });

  it("rejects an event with no id", () => {
    const body = JSON.stringify({ type: "checkout.session.completed" });
    const result = parseCheckoutCompletedEvent(body);
    expect("error" in result).toBe(true);
  });
});
