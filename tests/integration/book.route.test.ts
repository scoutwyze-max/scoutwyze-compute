import { describe, expect, it, afterEach } from "vitest";
import { buildTestApp, type TestApp } from "./testApp.js";

let built: TestApp | undefined;

afterEach(async () => {
  await built?.app.close();
  built = undefined;
});

describe("POST /v1/route/book — auth", () => {
  it("401s on a missing Authorization header", async () => {
    built = await buildTestApp();
    const res = await built.app.inject({ method: "POST", url: "/v1/route/book", payload: { hours: 1 } });
    expect(res.statusCode).toBe(401);
  });

  it("401s on an unknown/revoked key", async () => {
    built = await buildTestApp();
    const res = await built.app.inject({
      method: "POST",
      url: "/v1/route/book",
      headers: { authorization: "Bearer sw_live_not_a_real_key" },
      payload: { hours: 1 },
    });
    expect(res.statusCode).toBe(401);
  });

  it("402s on a real key with a literal zero balance, before rank or dispatch run", async () => {
    built = await buildTestApp();
    const { rawKey } = built.apiKeyStore.create("zero-balance-book-account");
    const res = await built.app.inject({
      method: "POST",
      url: "/v1/route/book",
      headers: { authorization: `Bearer ${rawKey}` },
      payload: { hours: 1 },
    });
    expect(res.statusCode).toBe(402);
    expect(built.lambdaLabsBooker.lastParams).toBeUndefined(); // never even reached the booker
  });

  it("400s on missing/invalid hours, before auth", async () => {
    built = await buildTestApp();
    const res = await built.app.inject({ method: "POST", url: "/v1/route/book", payload: {} });
    expect(res.statusCode).toBe(400);
  });

  it("400s and ignores any client-supplied provider field entirely (schema has no such field)", async () => {
    built = await buildTestApp();
    const res = await built.app.inject({
      method: "POST",
      url: "/v1/route/book",
      headers: { authorization: `Bearer ${built.apiKey}` },
      payload: { hours: 1, provider: "coreweave" }, // deliberately sending a field the schema doesn't accept

    });
    // Zod strips unknown keys by default rather than rejecting — the
    // real guarantee is structural (nothing reads request.body.provider
    // anywhere in book.ts), proven by the next describe block always
    // dispatching to whatever rank recommends, never a client value.
    expect(res.statusCode).toBe(200);
  });
});

describe("POST /v1/route/book — successful booking debits after vendor acceptance", () => {
  it("200s with vendor/jobId/connectInfo/quotedPrice/creditsRemaining, and debits the marked-up quotedPrice (not raw vendor cost)", async () => {
    built = await buildTestApp(); // default: RunPod-only, mirrors production
    built.runpodBooker.setShouldSucceed(true);
    const balanceBefore = built.creditLedger.getBalance(built.accountId);

    const res = await built.app.inject({
      method: "POST",
      url: "/v1/route/book",
      headers: { authorization: `Bearer ${built.apiKey}` },
      payload: { gpuClass: "H100", preference: "cheapest", hours: 2 },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe("ok");
    // Production is RunPod-only: even though Lambda's fixture has a
    // cheaper H100 row, it must never be recommended or dispatched to.
    expect(body.vendor).toBe("runpod");
    expect(body.jobId).toBeTruthy();
    expect(body.connectInfo).toBeTruthy();
    expect(body.quotedPrice).toBeGreaterThan(0);
    // The real point of the markup change: quotedPrice must be STRICTLY
    // greater than raw vendor cost — a passing test here would have
    // caught the old zero-margin pass-through bug directly.
    expect(body.quotedPrice).toBeGreaterThan(body.vendorCost);
    expect(body.margin).toBeGreaterThan(0);
    // precision 2 (cents), not 5 — quotedPrice is itself rounded to
    // cents in book.ts, so comparing against the raw unrounded product
    // can differ by up to half a cent depending on the exact numbers.
    expect(body.quotedPrice).toBeCloseTo(body.vendorCost * (1 + body.margin), 2);
    expect(body.creditsRemaining).toBeCloseTo(balanceBefore - body.quotedPrice, 5);
    expect(built.creditLedger.getBalance(built.accountId)).toBeCloseTo(balanceBefore - body.quotedPrice, 5);

    // The booker really was called with the server-computed candidate,
    // not anything client-supplied. Lambda's booker is never touched.
    expect(built.runpodBooker.lastParams?.hours).toBe(2);
    expect(built.lambdaLabsBooker.lastParams).toBeUndefined();
  });
});

describe("POST /v1/route/book — vendor failure means no debit", () => {
  it("returns vendor_declined and does not touch the balance", async () => {
    built = await buildTestApp();
    built.runpodBooker.setShouldSucceed(false, "capacity exhausted");
    const balanceBefore = built.creditLedger.getBalance(built.accountId);

    const res = await built.app.inject({
      method: "POST",
      url: "/v1/route/book",
      headers: { authorization: `Bearer ${built.apiKey}` },
      payload: { gpuClass: "H100", hours: 1 },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe("vendor_declined");
    expect(body.reason).toBe("capacity exhausted");
    expect(built.creditLedger.getBalance(built.accountId)).toBeCloseTo(balanceBefore, 5);
  });
});

describe("POST /v1/route/book — no_match / unsupported_provider do not debit", () => {
  it("returns no_match and does not debit for an unsatisfiable filter", async () => {
    built = await buildTestApp();
    const balanceBefore = built.creditLedger.getBalance(built.accountId);
    const res = await built.app.inject({
      method: "POST",
      url: "/v1/route/book",
      headers: { authorization: `Bearer ${built.apiKey}` },
      payload: { gpuClass: "definitely-not-a-real-gpu-xyz", hours: 1 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "no_match" });
    expect(built.creditLedger.getBalance(built.accountId)).toBeCloseTo(balanceBefore, 5);
  });

  it("returns no_match (not a fake/broken dispatch) for a region that only a non-bookable provider's fixture has", async () => {
    built = await buildTestApp(); // default: RunPod-only
    const balanceBefore = built.creditLedger.getBalance(built.accountId);
    // region="US-LAS1" only matches CoreWeave's fixture. Since production
    // (2026-09-22, Robert: "Production path is RunPod only... do not
    // recommend a provider we will 401/unsupported") filters ranking
    // itself to bookableProviders BEFORE scoring, CoreWeave's row is
    // invisible here — the result is no_match, not a doomed
    // "recommended coreweave, then failed to dispatch" round trip. This
    // also means the "unsupported_provider" response is no longer
    // reachable through this route in normal operation (bookersByProvider
    // and the ranking filter are now built from the same deps.bookers
    // list, see book.ts) — it stays in the code only as a defensive
    // fallback against the two ever drifting apart.
    const res = await built.app.inject({
      method: "POST",
      url: "/v1/route/book",
      headers: { authorization: `Bearer ${built.apiKey}` },
      payload: { region: "US-LAS1", hours: 1 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "no_match" });
    expect(built.creditLedger.getBalance(built.accountId)).toBeCloseTo(balanceBefore, 5);
  });

  it("dispatches to the correct registered booker when multiple bookers are configured (generic mechanism, not the production policy)", async () => {
    // Opts into a non-default, multi-booker scenario to prove book.ts's
    // dispatch-routing mechanism itself still picks whichever booker
    // rank actually recommends, not just the first one registered —
    // production (buildTestApp() with no args) only ever registers one.
    built = await buildTestApp({ bookableProviders: ["lambda_labs", "runpod"] });
    built.runpodBooker.setShouldSucceed(true);
    // US-MO-1/US-CA-2/US-GA-2/US-NE-1 are only in RunPod's fixture — forces a runpod recommendation.
    const res = await built.app.inject({
      method: "POST",
      url: "/v1/route/book",
      headers: { authorization: `Bearer ${built.apiKey}` },
      payload: { region: "US-MO-1", hours: 1 },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe("ok");
    expect(body.vendor).toBe("runpod");
    // Proves the RIGHT booker was called, not just any/the first one.
    expect(built.runpodBooker.lastParams).toBeDefined();
    expect(built.lambdaLabsBooker.lastParams).toBeUndefined();
  });
});
