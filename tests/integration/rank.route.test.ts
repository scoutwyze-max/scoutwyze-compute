import { describe, expect, it, afterEach } from "vitest";
import { buildTestApp, type TestApp } from "./testApp.js";
import { createTestPayerWallet, signPaymentAuthorization, encodeX402Payment } from "../helpers/x402TestHelpers.js";
import { encodeUsdcTransferLog, fakeSuccessfulReceipt } from "../helpers/fakeUsdcTransfer.js";

let txCounter = 0;
/** Same pattern as auth.middleware.test.ts's own fakeTxHash — real
 * hash FORMAT, not a real on-chain transaction; FakeChainReader is
 * what decides what it "returns". */
function fakeTxHash(): string {
  txCounter += 1;
  return "0x" + txCounter.toString(16).padStart(64, "0");
}

/** Drives a real challenge -> payment -> paid-request cycle against
 * /v1/route/rank for a given body — mirrors auth.middleware.test.ts's
 * payAndQuote, adapted to rank's own envelope instead of quote's. */
async function payAndRank(app: TestApp, body: Record<string, unknown> = {}) {
  const challengeRes = await app.app.inject({ method: "POST", url: "/v1/route/rank", payload: body });
  expect(challengeRes.statusCode).toBe(402);
  const challenge = challengeRes.json().accepts[0];
  // Real bug caught live 2026-09-24: resource used to be hardcoded to
  // "/v1/route/quote" on every challenge regardless of which route
  // issued it. Asserted on every payAndRank call, not just once, so it
  // can't quietly regress in one code path and not another.
  expect(challenge.resource).toBe("/v1/compute/rank");

  const wallet = createTestPayerWallet();
  const txHash = fakeTxHash();
  const amountUsdc = Number(challenge.maxAmountRequired);
  app.chainReader.setReceipt(txHash, fakeSuccessfulReceipt([encodeUsdcTransferLog(wallet.address, app.treasuryAddress, amountUsdc)]));
  const signature = await signPaymentAuthorization(wallet, { nonce: challenge.nonce, amountUsdc, txHash });
  const paymentHeader = encodeX402Payment({ nonce: challenge.nonce, amountUsdc, payerAddress: wallet.address, txHash, signature });

  return app.app.inject({ method: "POST", url: "/v1/route/rank", headers: { "x-payment": paymentHeader }, payload: body });
}

let built: TestApp | undefined;

afterEach(async () => {
  await built?.app.close();
  built = undefined;
});

describe("POST /v1/route/rank — auth (2026-09-24: dual-rail, x402 extended onto this route)", () => {
  it("falls through to a real x402 challenge on a missing Authorization header — not a bare 401", async () => {
    built = await buildTestApp();
    const res = await built.app.inject({ method: "POST", url: "/v1/route/rank", payload: {} });
    expect(res.statusCode).toBe(402);
    const body = res.json();
    expect(body.x402Version).toBe(1);
    expect(body.accepts?.[0]?.nonce).toBeTruthy();
  });

  it("includes a real Bazaar discovery extension, sibling of accepts — not nested inside it", async () => {
    // 2026-09-24: schema verified against the real x402-foundation
    // source (buildBazaarBodyExtension's own doc comment has the
    // citation), not assumed. This asserts the actual output shape,
    // not just that some "extensions" key exists.
    built = await buildTestApp();
    const res = await built.app.inject({ method: "POST", url: "/v1/route/rank", payload: {} });
    expect(res.statusCode).toBe(402);
    const body = res.json();

    expect(body.accepts).toBeTruthy(); // sibling, not replaced
    expect(body.extensions).toBeTruthy();
    expect(body.extensions.accepts).toBeUndefined(); // never nested inside accepts

    const bazaar = body.extensions.bazaar;
    expect(bazaar.info.input.type).toBe("http");
    expect(bazaar.info.input.method).toBe("POST");
    expect(bazaar.info.input.bodyType).toBe("json");
    expect(bazaar.info.input.body).toEqual({ gpuClass: "H100", preference: "cheapest" });
    expect(bazaar.info.output.example.status).toBe("ok");
    expect(bazaar.schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(bazaar.schema.properties.input.required).toEqual(["type", "method", "bodyType", "body"]);
    expect(bazaar.schema.properties.input.properties.body.properties.gpuClass.type).toBe("string");
  });

  it("falls through to a real x402 challenge on an unknown/revoked key — not a bare 401", async () => {
    built = await buildTestApp();
    const res = await built.app.inject({
      method: "POST",
      url: "/v1/route/rank",
      headers: { authorization: "Bearer sw_live_not_a_real_key" },
      payload: {},
    });
    expect(res.statusCode).toBe(402);
    expect(res.json().x402Version).toBe(1);
  });

  it("a recognized key with zero balance hard-402s WITHOUT attempting x402 — matches quote.ts's own precedent", async () => {
    built = await buildTestApp();
    const { rawKey } = built.apiKeyStore.create("zero-balance-fallthrough-account");
    const res = await built.app.inject({
      method: "POST",
      url: "/v1/route/rank",
      headers: { authorization: `Bearer ${rawKey}` },
      payload: {},
    });
    expect(res.statusCode).toBe(402);
    const body = res.json();
    expect(body.error).toBe("insufficient_credits");
    expect(body.x402Version).toBeUndefined(); // real insufficient_credits, not a payment challenge
  });

  it("402s on a real key with a literal zero balance, before any scoring happens", async () => {
    built = await buildTestApp();
    const { rawKey } = built.apiKeyStore.create("zero-balance-account"); // no topUp — genuinely $0
    const res = await built.app.inject({
      method: "POST",
      url: "/v1/route/rank",
      headers: { authorization: `Bearer ${rawKey}` },
      payload: {},
    });
    expect(res.statusCode).toBe(402);
  });
});

describe("POST /v1/route/rank — no_match does not debit", () => {
  // buildTestApp() always ingests the real fixture-backed adapters, so
  // there's no easy way to exercise no_inventory (zero facts across
  // ALL providers) through this shared harness without a dedicated
  // empty-cache test app — filterAndScore's own unit tests
  // (rankedScoring.test.ts) already cover that status directly. This
  // proves the same "no real match -> no charge" code path via
  // no_match instead, which IS reachable here.
  it("returns no_match for an unsatisfiable filter, and does not charge", async () => {
    built = await buildTestApp();
    const balanceBefore = built.creditLedger.getBalance(built.accountId);
    const res = await built.app.inject({
      method: "POST",
      url: "/v1/route/rank",
      headers: { authorization: `Bearer ${built.apiKey}` },
      payload: { gpuClass: "definitely-not-a-real-gpu-xyz" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      status: "no_match",
      schema_version: "1.0",
      billing: { billable: false, unit: "successful_rank", price_usd: 0.15, rail: "bearer" },
    });
    expect(built.creditLedger.getBalance(built.accountId)).toBeCloseTo(balanceBefore, 5);
  });
});

describe("POST /v1/route/rank — x402 rail (2026-09-24)", () => {
  it("real end-to-end x402 payment succeeds and settles BEFORE scoring, even on no_match", async () => {
    built = await buildTestApp();
    const res = await payAndRank(built, { gpuClass: "definitely-not-a-real-gpu-xyz" }); // deliberately unsatisfiable

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe("no_match");
    // The documented asymmetry: x402 already paid, even though there's
    // no match and nothing to show for it — unlike the Bearer rail
    // above, which never charges in this exact situation.
    expect(body.billing).toEqual({
      billable: true,
      unit: "successful_rank",
      price_usd: 0.15,
      rail: "x402",
      note: expect.stringContaining("no refund path"),
    });
  });

  it("a real x402 payment with a real match returns the full envelope, no creditsRemaining (no ledger on this rail)", async () => {
    built = await buildTestApp();
    const res = await payAndRank(built, { gpuClass: "H100" });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe("ok");
    expect(body.recommended.provider).toBeTruthy();
    expect(body.billing).toEqual({ billable: true, unit: "successful_rank", price_usd: 0.15, rail: "x402" });
    expect(body.billing.creditsRemaining).toBeUndefined();
  });
});

describe("POST /v1/compute/rank — canonical path (2026-09-23 namespace cleanup)", () => {
  it("works identically to the /v1/route/rank legacy alias", async () => {
    built = await buildTestApp();
    const res = await built.app.inject({
      method: "POST",
      url: "/v1/compute/rank",
      headers: { authorization: `Bearer ${built.apiKey}` },
      payload: { gpuClass: "H100", preference: "cheapest" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("ok");
  });
});

describe("POST /v1/route/rank — real match debits exactly once and returns the documented shape", () => {
  it("200s with recommended/alternatives/creditsRemaining, and debits routePriceUsdc", async () => {
    built = await buildTestApp();
    const balanceBefore = built.creditLedger.getBalance(built.accountId);

    const res = await built.app.inject({
      method: "POST",
      url: "/v1/route/rank",
      headers: { authorization: `Bearer ${built.apiKey}` },
      payload: { gpuClass: "H100", preference: "cheapest" },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe("ok");
    expect(body.recommended.provider).toBeTruthy();
    expect(body.recommended.vendorHourly).toBeGreaterThan(0);
    expect(body.recommended.reason).toMatch(/\$[\d.]+\/hr/);
    expect(body.recommended.scoreBreakdown.weights).toEqual({ price: 0.8, freshness: 0.2 });
    expect(Array.isArray(body.alternatives)).toBe(true);
    expect(body.billing.creditsRemaining).toBeCloseTo(balanceBefore - 0.15, 5);

    expect(built.creditLedger.getBalance(built.accountId)).toBeCloseTo(balanceBefore - 0.15, 5);

    // Frozen envelope fields (2026-09-23 pivot: stable shape agent-side
    // parsers cache against).
    expect(body.schema_version).toBe("1.0");
    expect(body.coverage).toEqual({ vertical: "gpu_compute", providers_live: expect.any(Array) });
    expect(body.limits).toEqual({ not_reserved: true, not_provisioned: true, can_provision: false });
    expect(body.billing).toMatchObject({ billable: true, unit: "successful_rank", price_usd: 0.15, rail: "bearer" });

    // Provenance fields (2026-09-23: "live" isn't allowed in copy until
    // callers can SEE which rows are actually live) — must be present
    // on every offer, not just a claim in a README.
    expect(body.recommended.observed_at).toBeTruthy();
    expect(typeof body.recommended.freshness_seconds).toBe("number");
    expect(["live_api", "fixture"]).toContain(body.recommended.source);
    expect(body.recommended.classification).toBe("provider_reported");
    expect(body.recommended.fetchedAt).toBeUndefined(); // renamed, not duplicated
  });

  it("400s on an invalid preference value, before auth or billing", async () => {
    built = await buildTestApp();
    const res = await built.app.inject({
      method: "POST",
      url: "/v1/route/rank",
      // deliberately no Authorization header either — proves validation
      // runs first, same VALIDATE-BEFORE-BILL principle as the other route
      payload: { preference: "not_a_real_preference" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("defaults preference to cheapest when omitted", async () => {
    built = await buildTestApp();
    const res = await built.app.inject({
      method: "POST",
      url: "/v1/route/rank",
      headers: { authorization: `Bearer ${built.apiKey}` },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("ok");
  });
});

describe("POST /v1/route/rank — production is RunPod-only (Robert, 2026-09-22)", () => {
  it("never recommends Lambda even though Lambda's fixture has a cheaper H100 row than RunPod's", async () => {
    built = await buildTestApp(); // default: RunPod-only, mirrors production
    const res = await built.app.inject({
      method: "POST",
      url: "/v1/route/rank",
      headers: { authorization: `Bearer ${built.apiKey}` },
      payload: { gpuClass: "H100", preference: "cheapest" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe("ok");
    expect(body.recommended.provider).toBe("runpod");
    // Not just "recommended" — a provider we can't book should never
    // appear anywhere in the response, including as a mere alternative.
    for (const candidate of body.alternatives) {
      expect(candidate.provider).toBe("runpod");
    }
  });
});
