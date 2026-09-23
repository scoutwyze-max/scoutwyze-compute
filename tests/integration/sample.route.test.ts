import { describe, expect, it, afterEach } from "vitest";
import { buildTestApp, type TestApp } from "./testApp.js";

let built: TestApp | undefined;

afterEach(async () => {
  await built?.app.close();
  built = undefined;
});

describe("GET /v1/route/sample", () => {
  it("200s with no Authorization header at all — anonymous by design", async () => {
    built = await buildTestApp();
    const res = await built.app.inject({ method: "GET", url: "/v1/route/sample" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe("ok");
    expect(body.recommended.provider).toBe("runpod"); // default test app: RunPod-only, mirrors production
    expect(Array.isArray(body.alternatives)).toBe(true);
    expect(body.note).toBeTruthy();
  });

  it("never touches the credit ledger — it's not billed", async () => {
    built = await buildTestApp();
    const balanceBefore = built.creditLedger.getBalance(built.accountId);
    await built.app.inject({ method: "GET", url: "/v1/route/sample" });
    expect(built.creditLedger.getBalance(built.accountId)).toBe(balanceBefore);
  });

  it("never dispatches to a booker — read-only preview only", async () => {
    built = await buildTestApp();
    await built.app.inject({ method: "GET", url: "/v1/route/sample" });
    expect(built.runpodBooker.lastParams).toBeUndefined();
  });

  it("429s once the per-IP rate limit is exceeded", async () => {
    built = await buildTestApp();
    let lastStatus = 200;
    // SAMPLE_RATE_LIMIT_MAX_REQUESTS is 20 — 25 requests from the same
    // injected IP guarantees crossing it.
    for (let i = 0; i < 25; i++) {
      const res = await built.app.inject({ method: "GET", url: "/v1/route/sample" });
      lastStatus = res.statusCode;
    }
    expect(lastStatus).toBe(429);
  });
});
