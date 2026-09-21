import { describe, expect, it, afterEach } from "vitest";
import { createHmac } from "node:crypto";
import { buildTestApp, type TestApp, TEST_STRIPE_WEBHOOK_SECRET } from "./testApp.js";

let built: TestApp | undefined;

afterEach(async () => {
  await built?.app.close();
  built = undefined;
});

function checkoutCompletedBody(accountId: string, amountUsd: number, eventId = "evt_test_1"): string {
  return JSON.stringify({
    id: eventId,
    type: "checkout.session.completed",
    data: { object: { metadata: { accountId }, amount_total: Math.round(amountUsd * 100) } },
  });
}

function signHeader(rawBody: string, timestampSeconds: number, secret = TEST_STRIPE_WEBHOOK_SECRET): string {
  const signature = createHmac("sha256", secret).update(`${timestampSeconds}.${rawBody}`).digest("hex");
  return `t=${timestampSeconds},v1=${signature}`;
}

describe("POST /v1/webhooks/stripe", () => {
  it("a validly signed checkout.session.completed event credits the account's real ledger balance", async () => {
    built = await buildTestApp();
    const balanceBefore = built.creditLedger.getBalance(built.accountId);
    const body = checkoutCompletedBody(built.accountId, 25);
    const timestamp = Math.floor(Date.now() / 1000);

    const res = await built.app.inject({
      method: "POST",
      url: "/v1/webhooks/stripe",
      headers: { "content-type": "application/json", "stripe-signature": signHeader(body, timestamp) },
      payload: body,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ received: true, action: "credited" });
    expect(built.creditLedger.getBalance(built.accountId)).toBeCloseTo(balanceBefore + 25, 2);
  });

  it("rejects a request with an invalid/forged signature — never touches the ledger", async () => {
    built = await buildTestApp();
    const balanceBefore = built.creditLedger.getBalance(built.accountId);
    const body = checkoutCompletedBody(built.accountId, 25);

    const res = await built.app.inject({
      method: "POST",
      url: "/v1/webhooks/stripe",
      headers: { "content-type": "application/json", "stripe-signature": "t=1,v1=" + "0".repeat(64) },
      payload: body,
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_signature");
    expect(built.creditLedger.getBalance(built.accountId)).toBeCloseTo(balanceBefore, 2);
  });

  it("rejects a request with no Stripe-Signature header at all", async () => {
    built = await buildTestApp();
    const body = checkoutCompletedBody(built.accountId, 25);

    const res = await built.app.inject({
      method: "POST",
      url: "/v1/webhooks/stripe",
      headers: { "content-type": "application/json" },
      payload: body,
    });

    expect(res.statusCode).toBe(400);
  });

  it("IDEMPOTENCY — a redelivered event (Stripe's at-least-once retry) does not double-credit", async () => {
    built = await buildTestApp();
    const balanceBefore = built.creditLedger.getBalance(built.accountId);
    const body = checkoutCompletedBody(built.accountId, 25, "evt_retry_test");

    const send = () =>
      built!.app.inject({
        method: "POST",
        url: "/v1/webhooks/stripe",
        headers: { "content-type": "application/json", "stripe-signature": signHeader(body, Math.floor(Date.now() / 1000)) },
        payload: body,
      });

    const first = await send();
    expect(first.statusCode).toBe(200);
    expect(first.json().action).toBe("credited");

    const retry = await send();
    expect(retry.statusCode).toBe(200);
    expect(retry.json().action).toBe("duplicate_ignored");

    // Credited exactly once despite two deliveries.
    expect(built.creditLedger.getBalance(built.accountId)).toBeCloseTo(balanceBefore + 25, 2);
  });

  it("a validly signed event of a type we don't act on is acknowledged 200 but never credited (Stripe should stop retrying it)", async () => {
    built = await buildTestApp();
    const balanceBefore = built.creditLedger.getBalance(built.accountId);
    const body = JSON.stringify({ id: "evt_other", type: "payment_intent.created" });

    const res = await built.app.inject({
      method: "POST",
      url: "/v1/webhooks/stripe",
      headers: { "content-type": "application/json", "stripe-signature": signHeader(body, Math.floor(Date.now() / 1000)) },
      payload: body,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ received: true, action: "ignored" });
    expect(built.creditLedger.getBalance(built.accountId)).toBeCloseTo(balanceBefore, 2);
  });

  it("a validly signed checkout session missing metadata.accountId is acknowledged but not credited to anyone", async () => {
    built = await buildTestApp();
    const body = JSON.stringify({
      id: "evt_no_account",
      type: "checkout.session.completed",
      data: { object: { metadata: {}, amount_total: 2000 } },
    });

    const res = await built.app.inject({
      method: "POST",
      url: "/v1/webhooks/stripe",
      headers: { "content-type": "application/json", "stripe-signature": signHeader(body, Math.floor(Date.now() / 1000)) },
      payload: body,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().action).toBe("ignored");
  });
});
