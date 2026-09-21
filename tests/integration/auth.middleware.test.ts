import { describe, expect, it, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildTestApp } from "./testApp.js";

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

function encodePayment(overrides: Partial<{ scheme: string; network: string; nonce: string; amountUsdc: number; payload: string }> = {}) {
  const submission = {
    scheme: "exact",
    network: "base",
    nonce: "not-a-real-nonce",
    amountUsdc: 0.15,
    payload: "0xmocksettlementpayload",
    ...overrides,
  };
  return Buffer.from(JSON.stringify(submission)).toString("base64");
}

/** Drives the real challenge -> payment -> receipt cycle for a given
 * request body, returning the successful response + issued receipt. */
async function payAndQuote(app: FastifyInstance, body: Record<string, unknown> = {}) {
  const challengeRes = await app.inject({ method: "POST", url: "/v1/route/quote", payload: body });
  expect(challengeRes.statusCode).toBe(402);
  const challenge = challengeRes.json().accepts[0];

  const paidRes = await app.inject({
    method: "POST",
    url: "/v1/route/quote",
    headers: { "x-payment": encodePayment({ nonce: challenge.nonce, amountUsdc: Number(challenge.maxAmountRequired) }) },
    payload: body,
  });
  return { paidRes, receipt: paidRes.headers["x-payment-receipt"] as string | undefined };
}

describe("dual-rail auth — Primary Path (Bearer)", () => {
  it("rejects requests with no auth at all", async () => {
    const built = await buildTestApp();
    app = built.app;
    const res = await app.inject({ method: "POST", url: "/v1/route/quote", payload: {} });
    expect(res.statusCode).toBe(402);
  });

  it("accepts a valid Bearer API key", async () => {
    const built = await buildTestApp();
    app = built.app;
    const res = await app.inject({
      method: "POST",
      url: "/v1/route/quote",
      headers: { authorization: `Bearer ${built.apiKey}` },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
  });

  it("an unrecognized Bearer key falls through to the x402 challenge, not a dead-end 401", async () => {
    const built = await buildTestApp();
    app = built.app;
    const res = await app.inject({
      method: "POST",
      url: "/v1/route/quote",
      headers: { authorization: "Bearer not_a_real_key" },
      payload: {},
    });
    expect(res.statusCode).toBe(402);
    expect(res.json().accepts[0].nonce).toBeTruthy();
  });
});

describe("dual-rail auth — Secondary Path (x402), CLAUDE.md §4", () => {
  it("no credentials at all returns a real 402 challenge with a usable nonce and price in CLAUDE.md's $0.10-$0.25+ range", async () => {
    const built = await buildTestApp();
    app = built.app;
    const res = await app.inject({ method: "POST", url: "/v1/route/quote", payload: {} });

    expect(res.statusCode).toBe(402);
    const body = res.json();
    expect(body.x402Version).toBe(1);
    const challenge = body.accepts[0];
    expect(challenge.scheme).toBe("exact");
    expect(challenge.network).toBe("base");
    expect(challenge.nonce).toBeTruthy();
    expect(Number(challenge.maxAmountRequired)).toBeGreaterThanOrEqual(0.1);
  });

  it("a payment correctly referencing a real issued nonce succeeds and returns a signed receipt header", async () => {
    const built = await buildTestApp();
    app = built.app;
    const { paidRes, receipt } = await payAndQuote(app, {});
    expect(paidRes.statusCode).toBe(200);
    expect(receipt).toBeTruthy();
    expect(receipt).toMatch(/^[\w-]+\.[0-9a-f]{64}$/); // base64url payload . hex hmac
  });

  it("a payment with a made-up nonce (never issued by this server) is rejected, not silently accepted", async () => {
    const built = await buildTestApp();
    app = built.app;
    const res = await app.inject({
      method: "POST",
      url: "/v1/route/quote",
      headers: { "x-payment": encodePayment({ nonce: "totally-made-up-nonce" }) },
      payload: {},
    });
    expect(res.statusCode).toBe(402);
    expect(res.json().reason).toMatch(/unknown or already-expired/);
  });

  it("REPLAY PROTECTION — reusing the same nonce for a second payment is rejected", async () => {
    const built = await buildTestApp();
    app = built.app;

    const challengeRes = await app.inject({ method: "POST", url: "/v1/route/quote", payload: {} });
    const { nonce, maxAmountRequired } = challengeRes.json().accepts[0];

    const first = await app.inject({
      method: "POST",
      url: "/v1/route/quote",
      headers: { "x-payment": encodePayment({ nonce, amountUsdc: Number(maxAmountRequired) }) },
      payload: {},
    });
    expect(first.statusCode).toBe(200);

    const replay = await app.inject({
      method: "POST",
      url: "/v1/route/quote",
      headers: { "x-payment": encodePayment({ nonce, amountUsdc: Number(maxAmountRequired) }) },
      payload: {},
    });
    expect(replay.statusCode).toBe(402);
    expect(replay.json().reason).toMatch(/already used.*replay/i);
  });

  it("rejects a payment amount below the challenge's required minimum", async () => {
    const built = await buildTestApp();
    app = built.app;
    const challengeRes = await app.inject({ method: "POST", url: "/v1/route/quote", payload: {} });
    const { nonce } = challengeRes.json().accepts[0];

    const res = await app.inject({
      method: "POST",
      url: "/v1/route/quote",
      headers: { "x-payment": encodePayment({ nonce, amountUsdc: 0.01 }) },
      payload: {},
    });
    expect(res.statusCode).toBe(402);
    expect(res.json().reason).toMatch(/below the required/);
  });

  it("rejects a payment on the wrong network", async () => {
    const built = await buildTestApp();
    app = built.app;
    const res = await app.inject({
      method: "POST",
      url: "/v1/route/quote",
      headers: { "x-payment": encodePayment({ network: "ethereum" }) },
      payload: {},
    });
    expect(res.statusCode).toBe(402);
  });

  it("rejects a garbled (non-base64/non-JSON) X-PAYMENT header", async () => {
    const built = await buildTestApp();
    app = built.app;
    const res = await app.inject({
      method: "POST",
      url: "/v1/route/quote",
      headers: { "x-payment": "not-valid-base64-json" },
      payload: {},
    });
    expect(res.statusCode).toBe(402);
  });

  it("RECEIPT REUSE — the same receipt authorizes a second identical request within its TTL, no new payment required", async () => {
    const built = await buildTestApp();
    app = built.app;
    const body = { region: "us-east-1" };
    const { paidRes, receipt } = await payAndQuote(app, body);
    expect(paidRes.statusCode).toBe(200);

    const secondRes = await app.inject({
      method: "POST",
      url: "/v1/route/quote",
      headers: { "x-payment-receipt": receipt! },
      payload: body, // identical request body
    });
    expect(secondRes.statusCode).toBe(200);
  });

  it("ANTI-SCRAPING — the same receipt does NOT authorize a request with different parameters", async () => {
    const built = await buildTestApp();
    app = built.app;
    const { paidRes, receipt } = await payAndQuote(app, { region: "us-east-1" });
    expect(paidRes.statusCode).toBe(200);

    const differentQueryRes = await app.inject({
      method: "POST",
      url: "/v1/route/quote",
      headers: { "x-payment-receipt": receipt! },
      payload: { region: "us-west-1" }, // DIFFERENT request — must not ride the same payment
    });
    expect(differentQueryRes.statusCode).toBe(402); // falls through to a fresh challenge, not a free pass
  });

  it("a corrupted/tampered receipt is rejected, not trusted", async () => {
    const built = await buildTestApp();
    app = built.app;
    const { receipt } = await payAndQuote(app, {});
    const tampered = receipt!.slice(0, -4) + "beef"; // flip the trailing signature bytes

    const res = await app.inject({
      method: "POST",
      url: "/v1/route/quote",
      headers: { "x-payment-receipt": tampered },
      payload: {},
    });
    expect(res.statusCode).toBe(402); // falls through to needing fresh payment
  });
});
