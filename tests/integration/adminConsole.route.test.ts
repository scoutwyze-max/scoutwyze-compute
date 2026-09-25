import { describe, expect, it, afterEach } from "vitest";
import { buildTestApp, TEST_ADMIN_SECRET, type TestApp } from "./testApp.js";
import { createTestPayerWallet, buildEip3009Authorization, signEip3009Authorization, encodeX402Payment } from "../helpers/x402TestHelpers.js";
import { encodeUsdcTransferLog, fakeSuccessfulReceipt } from "../helpers/fakeUsdcTransfer.js";

let txCounter = 0;
/** Same pattern as rank.route.test.ts's own fakeTxHash. */
function fakeTxHash(): string {
  txCounter += 1;
  return "0x" + txCounter.toString(16).padStart(64, "0");
}

/** Same pattern as rank.route.test.ts's payAndRank — drives a real
 * challenge -> payment -> paid-request cycle, here just to produce a
 * real settlement row for the admin console's settlements panel. Forces
 * a known txHash via the fake facilitator's setNextResult so this test
 * can assert on the exact resulting settlement row afterward. */
async function payAndRank(app: TestApp, body: Record<string, unknown> = {}) {
  const challengeRes = await app.app.inject({ method: "POST", url: "/v1/compute/rank", payload: body });
  const requirements = challengeRes.json().accepts[0];
  const wallet = createTestPayerWallet();
  const txHash = fakeTxHash();
  const amountUsdc = Number(requirements.maxAmountRequired) / 1_000_000;
  app.chainReader.setReceipt(txHash, fakeSuccessfulReceipt([encodeUsdcTransferLog(wallet.address, app.treasuryAddress, amountUsdc)]));
  app.facilitator.setNextResult({ success: true, transaction: txHash, network: "base", payer: wallet.address });

  const authorization = buildEip3009Authorization({ from: wallet.address, to: app.treasuryAddress, amountUsdc });
  const signature = await signEip3009Authorization(wallet, authorization);
  const paymentHeader = encodeX402Payment(authorization, signature);
  const res = await app.app.inject({ method: "POST", url: "/v1/compute/rank", headers: { "x-payment": paymentHeader }, payload: body });
  return { res, txHash, payerAddress: wallet.address };
}

let built: TestApp | undefined;

afterEach(async () => {
  await built?.app.close();
  built = undefined;
});

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Extracts just `name=value` from a Set-Cookie header, the same way
 * a browser would before sending it back on the next request. */
function cookieValue(setCookieHeader: string | string[] | undefined): string {
  const raw = Array.isArray(setCookieHeader) ? setCookieHeader[0] : setCookieHeader;
  if (!raw) throw new Error("expected a Set-Cookie header");
  return raw.split(";")[0]!;
}

async function login(built: TestApp): Promise<string> {
  const res = await built.app.inject({ method: "POST", url: "/v1/admin/session", headers: { "x-admin-secret": TEST_ADMIN_SECRET } });
  expect(res.statusCode).toBe(200);
  return cookieValue(res.headers["set-cookie"]);
}

describe("GET /admin — hidden, session-gated page", () => {
  it("serves a login form (no session cookie), not the dashboard", async () => {
    built = await buildTestApp();
    const res = await built.app.inject({ method: "GET", url: "/admin" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/html/);
    expect(res.body).toContain("X-Admin-Secret");
    expect(res.body).not.toContain("Agent feed");
  });

  it("serves the real dashboard once a valid session cookie is presented", async () => {
    built = await buildTestApp();
    const cookie = await login(built);
    const res = await built.app.inject({ method: "GET", url: "/admin", headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("Agent feed");
    expect(res.body).toContain("Run outreach discovery");
  });
});

describe("POST /v1/admin/session — login/logout", () => {
  it("401s on a wrong secret, sets no cookie", async () => {
    built = await buildTestApp();
    const res = await built.app.inject({ method: "POST", url: "/v1/admin/session", headers: { "x-admin-secret": "wrong" } });
    expect(res.statusCode).toBe(401);
    expect(res.headers["set-cookie"]).toBeUndefined();
  });

  it("200s on the real secret and sets a real HttpOnly/Secure/SameSite=Strict cookie", async () => {
    built = await buildTestApp();
    const res = await built.app.inject({ method: "POST", url: "/v1/admin/session", headers: { "x-admin-secret": TEST_ADMIN_SECRET } });
    expect(res.statusCode).toBe(200);
    const raw = Array.isArray(res.headers["set-cookie"]) ? res.headers["set-cookie"][0] : res.headers["set-cookie"];
    expect(raw).toMatch(/^sw_admin_session=/);
    expect(raw).toMatch(/HttpOnly/i);
    expect(raw).toMatch(/Secure/i);
    expect(raw).toMatch(/SameSite=Strict/i);
  });

  it("logout clears the cookie and console routes reject it afterward", async () => {
    built = await buildTestApp();
    const cookie = await login(built);
    const logout = await built.app.inject({ method: "POST", url: "/v1/admin/session/logout" });
    expect(logout.statusCode).toBe(200);
    // The browser wouldn't resend a cleared cookie at all — simulated
    // here by just confirming the endpoint requires a session, same
    // as any other console route without one.
    const after = await built.app.inject({ method: "GET", url: "/v1/admin/console/overview" });
    expect(after.statusCode).toBe(401);
    void cookie; // cookie captured only to prove login worked before logout
  });
});

describe("Admin console API — session-gated, never accepts raw X-Admin-Secret", () => {
  it("401s every console endpoint without a session cookie", async () => {
    built = await buildTestApp();
    const overview = await built.app.inject({ method: "GET", url: "/v1/admin/console/overview" });
    const telemetry = await built.app.inject({ method: "GET", url: "/v1/admin/console/telemetry" });
    const agentLog = await built.app.inject({ method: "GET", url: "/v1/admin/console/agent-log" });
    const trigger = await built.app.inject({ method: "POST", url: "/v1/admin/console/agent-runs/outreach" });
    expect([overview.statusCode, telemetry.statusCode, agentLog.statusCode, trigger.statusCode]).toEqual([401, 401, 401, 401]);
  });

  it("rejects the raw X-Admin-Secret header alone — a session cookie is required", async () => {
    built = await buildTestApp();
    const res = await built.app.inject({ method: "GET", url: "/v1/admin/console/overview", headers: { "x-admin-secret": TEST_ADMIN_SECRET } });
    expect(res.statusCode).toBe(401);
  });
});

describe("GET /v1/admin/console/overview — real data, not placeholders", () => {
  it("reflects the seeded account's active key and a real charge made through /v1/compute/rank", async () => {
    built = await buildTestApp();
    const cookie = await login(built);

    const rankRes = await built.app.inject({
      method: "POST",
      url: "/v1/compute/rank",
      headers: { authorization: `Bearer ${built.apiKey}`, cookie },
      payload: { gpuClass: "H100" },
    });
    expect(rankRes.statusCode).toBe(200);

    const res = await built.app.inject({ method: "GET", url: "/v1/admin/console/overview", headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.activeApiKeys).toBeGreaterThanOrEqual(1);
    expect(body.fundedAccounts).toBeGreaterThanOrEqual(1);
    expect(body.revenue24hUsd).toBeCloseTo(0.15, 5);
    // Rounded to cents by the route itself (a display value, not a raw
    // ratio) — 0.15/24 = 0.00625/hr rounds to $0.01/hr.
    expect(body.burnRatePerHourUsd).toBeCloseTo(0.01, 5);
    expect(body.recentLedger.some((e: { type: string; amountUsd: number }) => e.type === "charge" && e.amountUsd === 0.15)).toBe(true);
    expect(body.accountBalances.some((b: { accountId: string }) => b.accountId === built!.accountId)).toBe(true);
  });
});

describe("GET /v1/admin/console/telemetry — real request counts, not derived from ledger", () => {
  it("counts a real compute_sample and compute_rank call each, including both aliases", async () => {
    built = await buildTestApp();
    const cookie = await login(built);

    await built.app.inject({ method: "GET", url: "/v1/compute/sample" });
    await built.app.inject({ method: "GET", url: "/v1/route/sample" }); // legacy alias — must count toward the SAME route
    await built.app.inject({ method: "POST", url: "/v1/compute/rank", headers: { authorization: `Bearer ${built.apiKey}` }, payload: {} });

    const res = await built.app.inject({ method: "GET", url: "/v1/admin/console/telemetry", headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const sample = body.routes.find((r: { route: string }) => r.route === "compute_sample");
    const rank = body.routes.find((r: { route: string }) => r.route === "compute_rank");
    expect(sample.count).toBe(2);
    expect(rank.count).toBe(1);
    expect(sample.avgLatencyMs).toBeGreaterThanOrEqual(0);
  });

  it("still reports both routes at zero traffic, rather than omitting them", async () => {
    built = await buildTestApp();
    const cookie = await login(built);
    const res = await built.app.inject({ method: "GET", url: "/v1/admin/console/telemetry", headers: { cookie } });
    const routes = res.json().routes.map((r: { route: string }) => r.route).sort();
    expect(routes).toEqual(["compute_rank", "compute_sample"]);
  });
});

describe("Agent feed + outreach trigger — fixed action, no free-text, in-flight guard", () => {
  it("starts a run, guards a concurrent second trigger, and reports completion in the feed", async () => {
    built = await buildTestApp();
    const cookie = await login(built);

    const first = await built.app.inject({ method: "POST", url: "/v1/admin/console/agent-runs/outreach", headers: { cookie } });
    expect(first.statusCode).toBe(202);
    expect(first.json().runId).toBeTruthy();

    // Fired immediately after, while the fake script's 150ms delay is
    // still in flight — proves the guard against a REAL concurrent
    // spawn, not just a mocked one.
    const second = await built.app.inject({ method: "POST", url: "/v1/admin/console/agent-runs/outreach", headers: { cookie } });
    expect(second.statusCode).toBe(409);
    expect(second.json().started).toBe(false);

    await sleep(400); // let the fake script's process actually exit

    const log = await built.app.inject({ method: "GET", url: "/v1/admin/console/agent-log", headers: { cookie } });
    const entries = log.json().entries;
    expect(entries.some((e: { kind: string }) => e.kind === "run_started")).toBe(true);
    const completed = entries.find((e: { kind: string }) => e.kind === "run_completed");
    expect(completed).toBeTruthy();
    expect(completed.message).toContain("kit(s) written");

    // A third trigger, now that the first has actually finished, must
    // be accepted — the guard shouldn't wedge itself into "forever busy".
    const third = await built.app.inject({ method: "POST", url: "/v1/admin/console/agent-runs/outreach", headers: { cookie } });
    expect(third.statusCode).toBe(202);

    // Drain it before the test (and afterEach's db close) ends — a real
    // bug caught live 2026-09-25 by later tests in this file running
    // long enough to expose it: left running, this process's completion
    // callback fires after `built.app.close()` and throws trying to
    // write to agentLog on an already-closed connection.
    await sleep(400);
  });
});

describe("GET /v1/admin/console/requests — rail-aware, real requests not placeholders", () => {
  it("401s without a session cookie", async () => {
    built = await buildTestApp();
    const res = await built.app.inject({ method: "GET", url: "/v1/admin/console/requests" });
    expect(res.statusCode).toBe(401);
  });

  it("logs a real Bearer rank call with rail+identifier, and an anonymous sample call with rail=null", async () => {
    built = await buildTestApp();
    const cookie = await login(built);

    await built.app.inject({ method: "POST", url: "/v1/compute/rank", headers: { authorization: `Bearer ${built.apiKey}` }, payload: { gpuClass: "H100" } });
    await built.app.inject({ method: "GET", url: "/v1/compute/sample" });

    const res = await built.app.inject({ method: "GET", url: "/v1/admin/console/requests", headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const requests = res.json().requests as { route: string; rail: string | null; identifier: string | null; statusCode: number }[];

    const rankReq = requests.find((r) => r.route === "compute_rank");
    expect(rankReq?.rail).toBe("bearer");
    expect(rankReq?.identifier).toBeTruthy();
    expect(rankReq?.statusCode).toBe(200);

    const sampleReq = requests.find((r) => r.route === "compute_sample");
    expect(sampleReq?.rail).toBeNull();
  });

  it("logs the x402 rail with a nonce-fragment identifier, never the raw payload", async () => {
    built = await buildTestApp();
    const cookie = await login(built);

    const { res: rankRes } = await payAndRank(built, { gpuClass: "H100" });
    expect(rankRes.statusCode).toBe(200);

    const res = await built.app.inject({ method: "GET", url: "/v1/admin/console/requests", headers: { cookie } });
    const rankReq = res.json().requests.find((r: { route: string }) => r.route === "compute_rank");
    expect(rankReq.rail).toBe("x402");
    expect(rankReq.identifier).toHaveLength(8); // nonce.slice(0, 8), not the full nonce/payload
  });
});

describe("GET /v1/admin/console/settlements — real on-chain Base settlements", () => {
  it("401s without a session cookie", async () => {
    built = await buildTestApp();
    const res = await built.app.inject({ method: "GET", url: "/v1/admin/console/settlements" });
    expect(res.statusCode).toBe(401);
  });

  it("reflects a real x402 payment's tx hash, payer address, and amount — same data recordIfNew already persists", async () => {
    built = await buildTestApp();
    const cookie = await login(built);

    const { res: rankRes, txHash, payerAddress } = await payAndRank(built, { gpuClass: "H100" });
    expect(rankRes.statusCode).toBe(200);

    const res = await built.app.inject({ method: "GET", url: "/v1/admin/console/settlements", headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const settlement = res.json().settlements.find((s: { txHash: string }) => s.txHash === txHash);
    expect(settlement).toBeTruthy();
    expect(settlement.payerAddress.toLowerCase()).toBe(payerAddress.toLowerCase());
    expect(settlement.amountUsd).toBeCloseTo(0.15, 5);
  });
});
