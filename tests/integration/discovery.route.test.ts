import { describe, expect, it, afterEach } from "vitest";
import { buildTestApp, type TestApp } from "./testApp.js";

let built: TestApp | undefined;

afterEach(async () => {
  await built?.app.close();
  built = undefined;
});

describe("GET /llms.txt", () => {
  it("200s with plain text, no auth required, mentioning rank/sample and the RunPod-only policy", async () => {
    built = await buildTestApp();
    const res = await built.app.inject({ method: "GET", url: "/llms.txt" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/plain/);
    expect(res.body).toContain("/v1/route/sample");
    expect(res.body).toContain("/v1/route/rank");
    expect(res.body).toMatch(/multi-cloud aggregator/i);
  });

  it("omits /v1/route/book from the endpoint list when bookIsPublished is false (the default)", async () => {
    built = await buildTestApp();
    const res = await built.app.inject({ method: "GET", url: "/llms.txt" });
    expect(res.body).not.toContain("POST /v1/route/book —");
  });

  it("documents /v1/route/book once bookIsPublished is true", async () => {
    built = await buildTestApp({ bookIsPublished: true });
    const res = await built.app.inject({ method: "GET", url: "/llms.txt" });
    expect(res.body).toContain("POST /v1/route/book —");
  });
});

describe("GET /openapi.json", () => {
  it("200s with a valid-shaped OpenAPI document covering signup/checkout/sample/rank", async () => {
    built = await buildTestApp();
    const res = await built.app.inject({ method: "GET", url: "/openapi.json" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.openapi).toBe("3.0.3");
    expect(body.paths["/v1/route/sample"]).toBeTruthy();
    expect(body.paths["/v1/route/rank"]).toBeTruthy();
    expect(body.paths["/v1/signup"]).toBeTruthy();
  });

  it("omits the /v1/route/book path entirely when bookIsPublished is false", async () => {
    built = await buildTestApp();
    const res = await built.app.inject({ method: "GET", url: "/openapi.json" });
    expect(res.json().paths["/v1/route/book"]).toBeUndefined();
  });

  it("includes the /v1/route/book path once bookIsPublished is true", async () => {
    built = await buildTestApp({ bookIsPublished: true });
    const res = await built.app.inject({ method: "GET", url: "/openapi.json" });
    expect(res.json().paths["/v1/route/book"]).toBeTruthy();
  });
});
