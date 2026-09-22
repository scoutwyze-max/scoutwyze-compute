import { describe, expect, it, afterEach } from "vitest";
import { buildTestApp, type TestApp } from "./testApp.js";

let built: TestApp | undefined;

afterEach(async () => {
  await built?.app.close();
  built = undefined;
});

describe("GET / — public signup page", () => {
  it("serves HTML that only calls /v1/signup and /v1/checkout-sessions, never admin routes", async () => {
    built = await buildTestApp();
    const res = await built.app.inject({ method: "GET", url: "/" });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/html/);
    expect(res.body).toContain("/v1/signup");
    expect(res.body).toContain("/v1/checkout-sessions");
    // The whole point: a public page must never reference the admin
    // credential space at all, even in a comment or dead code path.
    expect(res.body).not.toContain("Admin-Secret");
    expect(res.body).not.toContain("ADMIN_SECRET");
    expect(res.body).not.toContain("/v1/admin");
  });
});
