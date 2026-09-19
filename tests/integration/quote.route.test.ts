import { describe, expect, it, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildTestApp } from "./testApp.js";

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("POST /v1/route/quote", () => {
  it("returns ranked quotes from all 3 providers for the default (inference) request", async () => {
    const built = await buildTestApp();
    app = built.app;

    const res = await app.inject({
      method: "POST",
      url: "/v1/route/quote",
      headers: { authorization: `Bearer ${built.apiKey}` },
      payload: {},
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.quotes.length).toBeGreaterThan(0);

    const providers = new Set(body.quotes.map((q: any) => q.provider_observed.provider));
    // All 3 fixture providers have at least one 8x H100 US listing.
    expect(providers.has("lambda_labs")).toBe(true);
    expect(providers.has("runpod")).toBe(true);
    expect(providers.has("coreweave")).toBe(true);

    // Cheapest-first ranking, per router.ts's documented rule.
    const costs = body.quotes.map((q: any) => q.scoutwyze_estimated.effective_hourly_cost_usd);
    const sorted = [...costs].sort((a, b) => a - b);
    expect(costs).toEqual(sorted);
  });

  it("narrows to a single region when requested", async () => {
    const built = await buildTestApp();
    app = built.app;

    const res = await app.inject({
      method: "POST",
      url: "/v1/route/quote",
      headers: { authorization: `Bearer ${built.apiKey}` },
      payload: { region: "us-east-1" },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.quotes.length).toBeGreaterThan(0);
    // Region matching is case-insensitive by design (constraintFilter.ts) —
    // CoreWeave's raw region is "US-EAST-1", Lambda's is "us-east-1", same
    // region. Assert on that, not exact string casing.
    expect(body.quotes.every((q: any) => q.provider_observed.region.toLowerCase() === "us-east-1")).toBe(true);
    // Confirms this test is actually exercising cross-provider matching,
    // not just coincidentally passing with one provider.
    const providers = new Set(body.quotes.map((q: any) => q.provider_observed.provider));
    expect(providers.size).toBeGreaterThan(1);
  });

  it("excludes quotes above a caller-specified max effective cost", async () => {
    const built = await buildTestApp();
    app = built.app;

    const unfiltered = await app.inject({
      method: "POST",
      url: "/v1/route/quote",
      headers: { authorization: `Bearer ${built.apiKey}` },
      payload: {},
    });
    const cheapest = Math.min(
      ...unfiltered.json().quotes.map((q: any) => q.scoutwyze_estimated.effective_hourly_cost_usd),
    );

    const res = await app.inject({
      method: "POST",
      url: "/v1/route/quote",
      headers: { authorization: `Bearer ${built.apiKey}` },
      payload: { max_hourly_cost_usd: cheapest }, // only room for the cheapest one (or none, if it lands exactly at the boundary due to rounding)
    });

    const body = res.json();
    expect(
      body.quotes.every((q: any) => q.scoutwyze_estimated.effective_hourly_cost_usd <= cheapest),
    ).toBe(true);
  });

  it("rejects a malformed request body", async () => {
    const built = await buildTestApp();
    app = built.app;

    const res = await app.inject({
      method: "POST",
      url: "/v1/route/quote",
      headers: { authorization: `Bearer ${built.apiKey}` },
      payload: { workload_type: "not_a_real_workload" },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_request");
  });
});
