import { describe, expect, it, afterEach } from "vitest";
import { buildTestApp, type TestApp } from "./testApp.js";
import { CREDIT_PACKS } from "../../src/payments/stripeCheckout.js";

let built: TestApp | undefined;

afterEach(async () => {
  await built?.app.close();
  built = undefined;
});

describe("POST /v1/signup", () => {
  it("issues a brand-new account and a usable API key, unauthenticated", async () => {
    built = await buildTestApp();
    const res = await built.app.inject({ method: "POST", url: "/v1/signup", payload: {} });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.accountId).toBeTruthy();
    expect(body.apiKey).toMatch(/^sw_live_/);
    expect(body.creditPacks).toEqual(CREDIT_PACKS);

    // The returned key must actually work as a real Bearer credential.
    const quoteRes = await built.app.inject({
      method: "POST",
      url: "/v1/route/quote",
      headers: { authorization: `Bearer ${body.apiKey}` },
      payload: {},
    });
    // New account has $0 balance — insufficient credits, not "invalid key".
    expect(quoteRes.statusCode).toBe(402);
    expect(quoteRes.json().error).toBe("insufficient_credits");
  });

  it("two separate signups always produce two distinct accounts, never collide", async () => {
    built = await buildTestApp();
    const first = (await built.app.inject({ method: "POST", url: "/v1/signup", payload: {} })).json();
    const second = (await built.app.inject({ method: "POST", url: "/v1/signup", payload: {} })).json();

    expect(first.accountId).not.toBe(second.accountId);
    expect(first.apiKey).not.toBe(second.apiKey);
  });

  it("ignores any caller-supplied accountId in the body — the server always generates its own", async () => {
    // Real security property: this endpoint is unauthenticated, so a
    // caller-controlled accountId would let anyone mint a live key
    // against an existing (possibly funded) account just by guessing
    // its id.
    built = await buildTestApp();
    const res = await built.app.inject({
      method: "POST",
      url: "/v1/signup",
      payload: { accountId: built.accountId }, // tries to attach to the already-funded test account
    });
    const body = res.json();
    expect(body.accountId).not.toBe(built.accountId);
  });
});

describe("POST /v1/checkout-sessions", () => {
  it("creates a real Checkout Session for a known credit pack, with the accountId bound into metadata", async () => {
    built = await buildTestApp();
    const res = await built.app.inject({
      method: "POST",
      url: "/v1/checkout-sessions",
      payload: { accountId: built.accountId, packId: "starter" },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.checkoutUrl).toBeTruthy();
    expect(body.sessionId).toBeTruthy();
    expect(built.checkoutSessionCreator.lastParams).toMatchObject({
      accountId: built.accountId,
      amountUsd: 10,
      successUrl: "https://example.com/success",
      cancelUrl: "https://example.com/cancel",
    });
  });

  it("rejects an unknown packId", async () => {
    built = await buildTestApp();
    const res = await built.app.inject({
      method: "POST",
      url: "/v1/checkout-sessions",
      payload: { accountId: built.accountId, packId: "not-a-real-pack" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects a request missing accountId or packId", async () => {
    built = await buildTestApp();
    const res = await built.app.inject({ method: "POST", url: "/v1/checkout-sessions", payload: { packId: "starter" } });
    expect(res.statusCode).toBe(400);
  });

  it("returns 502, not a 500 crash or a fake success, when Stripe itself fails", async () => {
    built = await buildTestApp();
    built.checkoutSessionCreator.setShouldFail(true);
    const res = await built.app.inject({
      method: "POST",
      url: "/v1/checkout-sessions",
      payload: { accountId: built.accountId, packId: "starter" },
    });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toBe("checkout_session_failed");
  });

  it("end-to-end: signup -> checkout session -> (simulated) webhook completion actually credits the new account", async () => {
    built = await buildTestApp();
    const signupRes = await built.app.inject({ method: "POST", url: "/v1/signup", payload: {} });
    const { accountId, apiKey } = signupRes.json();

    const checkoutRes = await built.app.inject({
      method: "POST",
      url: "/v1/checkout-sessions",
      payload: { accountId, packId: "growth" },
    });
    expect(checkoutRes.statusCode).toBe(201);
    expect(built.checkoutSessionCreator.lastParams?.accountId).toBe(accountId);
    expect(built.checkoutSessionCreator.lastParams?.amountUsd).toBe(50);

    // Simulate Stripe actually completing that exact session (the real
    // webhook path, already covered end-to-end in stripeWebhook.test.ts
    // — this just confirms the two routes' accountId contract lines up).
    built.creditLedger.topUp(accountId, 50);

    const quoteRes = await built.app.inject({
      method: "POST",
      url: "/v1/route/quote",
      headers: { authorization: `Bearer ${apiKey}` },
      payload: {},
    });
    expect(quoteRes.statusCode).toBe(200);
  });
});
