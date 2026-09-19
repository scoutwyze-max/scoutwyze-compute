import { describe, expect, it, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildTestApp } from "./testApp.js";

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

function mockX402Header(overrides: Partial<{ scheme: string; network: string; payload: string; amountUsdc: number }> = {}) {
  const claim = {
    scheme: "exact",
    network: "base",
    payload: "0xmocksettlementpayload",
    amountUsdc: 0.15,
    ...overrides,
  };
  return Buffer.from(JSON.stringify(claim)).toString("base64");
}

describe("dual-rail auth — CLAUDE.md §4", () => {
  it("rejects requests with no auth at all", async () => {
    const built = await buildTestApp();
    app = built.app;

    const res = await app.inject({ method: "POST", url: "/v1/route/quote", payload: {} });
    expect(res.statusCode).toBe(401);
  });

  it("Primary Path — accepts a valid Bearer API key", async () => {
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

  it("rejects an unrecognized Bearer key with no fallback x402 header", async () => {
    const built = await buildTestApp();
    app = built.app;

    const res = await app.inject({
      method: "POST",
      url: "/v1/route/quote",
      headers: { authorization: "Bearer not_a_real_key" },
      payload: {},
    });
    expect(res.statusCode).toBe(401);
  });

  it("Secondary Path — accepts a well-formed mock X-PAYMENT header with no Bearer key at all", async () => {
    const built = await buildTestApp();
    app = built.app;

    const res = await app.inject({
      method: "POST",
      url: "/v1/route/quote",
      headers: { "x-payment": mockX402Header() },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
  });

  it("rejects an x402 claim priced below CLAUDE.md's stated $0.10 minimum", async () => {
    const built = await buildTestApp();
    app = built.app;

    const res = await app.inject({
      method: "POST",
      url: "/v1/route/quote",
      headers: { "x-payment": mockX402Header({ amountUsdc: 0.01 }) },
      payload: {},
    });
    expect(res.statusCode).toBe(401);
  });

  it("rejects an x402 claim on the wrong network", async () => {
    const built = await buildTestApp();
    app = built.app;

    const res = await app.inject({
      method: "POST",
      url: "/v1/route/quote",
      headers: { "x-payment": mockX402Header({ network: "ethereum" }) },
      payload: {},
    });
    expect(res.statusCode).toBe(401);
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
    expect(res.statusCode).toBe(401);
  });
});
