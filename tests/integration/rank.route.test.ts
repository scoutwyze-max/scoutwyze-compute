import { describe, expect, it, afterEach } from "vitest";
import { buildTestApp, type TestApp } from "./testApp.js";

let built: TestApp | undefined;

afterEach(async () => {
  await built?.app.close();
  built = undefined;
});

describe("POST /v1/route/rank — auth", () => {
  it("401s on a missing Authorization header — not a 402 x402 challenge", async () => {
    built = await buildTestApp();
    const res = await built.app.inject({ method: "POST", url: "/v1/route/rank", payload: {} });
    expect(res.statusCode).toBe(401);
  });

  it("401s on an unknown/revoked key", async () => {
    built = await buildTestApp();
    const res = await built.app.inject({
      method: "POST",
      url: "/v1/route/rank",
      headers: { authorization: "Bearer sw_live_not_a_real_key" },
      payload: {},
    });
    expect(res.statusCode).toBe(401);
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
    expect(res.json()).toEqual({ status: "no_match" });
    expect(built.creditLedger.getBalance(built.accountId)).toBeCloseTo(balanceBefore, 5);
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
    expect(body.creditsRemaining).toBeCloseTo(balanceBefore - 0.15, 5);

    expect(built.creditLedger.getBalance(built.accountId)).toBeCloseTo(balanceBefore - 0.15, 5);

    // Provenance fields (2026-09-23: "live" isn't allowed in copy until
    // callers can SEE which rows are actually live) — must be present
    // on every offer, not just a claim in a README.
    expect(body.recommended.observed_at).toBeTruthy();
    expect(typeof body.recommended.freshness_seconds).toBe("number");
    expect(["live_api", "fixture"]).toContain(body.recommended.source);
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
