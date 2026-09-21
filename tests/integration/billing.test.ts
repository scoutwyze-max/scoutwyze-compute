import { describe, expect, it, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildTestApp } from "./testApp.js";

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("Primary Path — API key + prepaid credit ledger, end to end", () => {
  it("a freshly admin-issued key with zero balance is rejected with a specific insufficient_credits error, not a generic auth failure", async () => {
    const built = await buildTestApp();
    app = built.app;

    const created = await app.inject({
      method: "POST",
      url: "/v1/admin/api-keys",
      headers: { "x-admin-secret": built.adminSecret },
      payload: { accountId: "broke-account" },
    });
    expect(created.statusCode).toBe(201);
    const { apiKey } = created.json();

    const res = await app.inject({
      method: "POST",
      url: "/v1/route/quote",
      headers: { authorization: `Bearer ${apiKey}` },
      payload: {},
    });
    expect(res.statusCode).toBe(402);
    const body = res.json();
    expect(body.error).toBe("insufficient_credits");
    expect(body.balanceUsd).toBe(0);
  });

  it("topping up via the admin route makes a previously-broke key work immediately, and the balance actually decrements", async () => {
    const built = await buildTestApp();
    app = built.app;

    const created = await app.inject({
      method: "POST",
      url: "/v1/admin/api-keys",
      headers: { "x-admin-secret": built.adminSecret },
      payload: { accountId: "funded-account" },
    });
    const { apiKey } = created.json();

    await app.inject({
      method: "POST",
      url: "/v1/admin/accounts/funded-account/credits",
      headers: { "x-admin-secret": built.adminSecret },
      payload: { amountUsd: 1 },
    });

    const res = await app.inject({
      method: "POST",
      url: "/v1/route/quote",
      headers: { authorization: `Bearer ${apiKey}` },
      payload: {},
    });
    expect(res.statusCode).toBe(200);

    const ledgerRes = await app.inject({
      method: "GET",
      url: "/v1/admin/accounts/funded-account/ledger",
      headers: { "x-admin-secret": built.adminSecret },
    });
    const ledger = ledgerRes.json();
    expect(ledger.balanceUsd).toBeCloseTo(0.85, 2); // $1.00 topped up - $0.15 default route price
    expect(ledger.entries.map((e: any) => e.type)).toEqual(["topup", "charge"]);
  });

  it("draining a balance to exactly zero across several requests, then the next one fails closed with the right reason", async () => {
    const built = await buildTestApp();
    app = built.app;

    const created = await app.inject({
      method: "POST",
      url: "/v1/admin/api-keys",
      headers: { "x-admin-secret": built.adminSecret },
      payload: { accountId: "draining-account" },
    });
    const { apiKey } = created.json();
    await app.inject({
      method: "POST",
      url: "/v1/admin/accounts/draining-account/credits",
      headers: { "x-admin-secret": built.adminSecret },
      payload: { amountUsd: 0.3 }, // exactly 2 requests at the $0.15 default price
    });

    const first = await app.inject({ method: "POST", url: "/v1/route/quote", headers: { authorization: `Bearer ${apiKey}` }, payload: {} });
    const second = await app.inject({ method: "POST", url: "/v1/route/quote", headers: { authorization: `Bearer ${apiKey}` }, payload: {} });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);

    const third = await app.inject({ method: "POST", url: "/v1/route/quote", headers: { authorization: `Bearer ${apiKey}` }, payload: {} });
    expect(third.statusCode).toBe(402);
    expect(third.json().balanceUsd).toBe(0);
  });

  it("ATOMICITY UNDER REAL CONCURRENCY — 10 genuinely simultaneous requests against a balance that covers exactly 4 of them never double-spend", async () => {
    const built = await buildTestApp();
    app = built.app;

    const created = await app.inject({
      method: "POST",
      url: "/v1/admin/api-keys",
      headers: { "x-admin-secret": built.adminSecret },
      payload: { accountId: "concurrency-account" },
    });
    const { apiKey } = created.json();
    await app.inject({
      method: "POST",
      url: "/v1/admin/accounts/concurrency-account/credits",
      headers: { "x-admin-secret": built.adminSecret },
      payload: { amountUsd: 0.6 }, // exactly 4 requests at the $0.15 default price
    });

    // Fired together, not awaited one at a time — this is what actually
    // exercises CreditLedger.charge()'s transaction, unlike the
    // sequential draining test above.
    const responses = await Promise.all(
      Array.from({ length: 10 }, () =>
        app!.inject({ method: "POST", url: "/v1/route/quote", headers: { authorization: `Bearer ${apiKey}` }, payload: {} }),
      ),
    );

    const succeeded = responses.filter((r) => r.statusCode === 200);
    const rejected = responses.filter((r) => r.statusCode === 402);
    expect(succeeded).toHaveLength(4); // exactly what the balance covers, never more
    expect(rejected).toHaveLength(6);
    expect(built.creditLedger.getBalance("concurrency-account")).toBe(0); // never negative, never left over
    expect(built.creditLedger.getLedger("concurrency-account").filter((e) => e.type === "charge")).toHaveLength(4);
  });

  it("VALIDATE-BEFORE-BILL — a malformed request with a funded key is rejected for free, balance is untouched", async () => {
    const built = await buildTestApp();
    app = built.app;
    const balanceBefore = built.creditLedger.getBalance(built.accountId);

    const res = await app.inject({
      method: "POST",
      url: "/v1/route/quote",
      headers: { authorization: `Bearer ${built.apiKey}` },
      payload: { workload_type: "not_a_real_workload" },
    });
    expect(res.statusCode).toBe(400);
    expect(built.creditLedger.getBalance(built.accountId)).toBe(balanceBefore); // no charge happened
  });

  it("a revoked key falls through to the x402 challenge rather than being treated as a hard auth failure", async () => {
    const built = await buildTestApp();
    app = built.app;

    const created = await app.inject({
      method: "POST",
      url: "/v1/admin/api-keys",
      headers: { "x-admin-secret": built.adminSecret },
      payload: { accountId: "soon-revoked" },
    });
    const { apiKey, keyId } = created.json();
    await app.inject({
      method: "POST",
      url: `/v1/admin/api-keys/${keyId}/revoke`,
      headers: { "x-admin-secret": built.adminSecret },
    });

    const res = await app.inject({
      method: "POST",
      url: "/v1/route/quote",
      headers: { authorization: `Bearer ${apiKey}` },
      payload: {},
    });
    expect(res.statusCode).toBe(402);
    expect(res.json().x402Version).toBe(1); // the real x402 challenge shape, not insufficient_credits
  });
});

describe("Admin routes — auth and validation", () => {
  it("rejects admin requests with a missing X-Admin-Secret", async () => {
    const built = await buildTestApp();
    app = built.app;
    const res = await app.inject({ method: "POST", url: "/v1/admin/api-keys", payload: { accountId: "x" } });
    expect(res.statusCode).toBe(401);
  });

  it("rejects admin requests with the wrong X-Admin-Secret", async () => {
    const built = await buildTestApp();
    app = built.app;
    const res = await app.inject({
      method: "POST",
      url: "/v1/admin/api-keys",
      headers: { "x-admin-secret": "wrong-secret" },
      payload: { accountId: "x" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("a customer API key does NOT work as an admin secret — separate credential spaces", async () => {
    const built = await buildTestApp();
    app = built.app;
    const res = await app.inject({
      method: "POST",
      url: "/v1/admin/api-keys",
      headers: { "x-admin-secret": built.apiKey },
      payload: { accountId: "x" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("rejects a key-creation request with no accountId", async () => {
    const built = await buildTestApp();
    app = built.app;
    const res = await app.inject({
      method: "POST",
      url: "/v1/admin/api-keys",
      headers: { "x-admin-secret": built.adminSecret },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it("revoking an unknown keyId returns 404, not a silent success", async () => {
    const built = await buildTestApp();
    app = built.app;
    const res = await app.inject({
      method: "POST",
      url: "/v1/admin/api-keys/not-a-real-id/revoke",
      headers: { "x-admin-secret": built.adminSecret },
    });
    expect(res.statusCode).toBe(404);
  });
});
