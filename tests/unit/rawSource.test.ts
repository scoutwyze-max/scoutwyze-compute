import { describe, expect, it, vi, afterEach } from "vitest";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FixtureRawEntrySource, HttpRawEntrySource, WebhookRawEntrySource } from "../../src/providers/rawSource.js";

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});

describe("FixtureRawEntrySource", () => {
  it("reads and parses a real JSON file from disk", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rawsource-test-"));
    const filePath = join(dir, "entries.json");
    writeFileSync(filePath, JSON.stringify([{ a: 1 }, { a: 2 }]));

    const source = new FixtureRawEntrySource(filePath);
    const entries = await source.fetchRawEntries();
    expect(entries).toEqual([{ a: 1 }, { a: 2 }]);

    rmSync(dir, { recursive: true, force: true });
  });
});

describe("HttpRawEntrySource — live-polling-ready seam", () => {
  it("GETs the configured URL with the configured headers and returns the top-level array by default", async () => {
    let capturedUrl: string | undefined;
    let capturedInit: RequestInit | undefined;
    global.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedInit = init;
      return new Response(JSON.stringify([{ x: 1 }]), { status: 200 });
    }) as unknown as typeof fetch;

    const source = new HttpRawEntrySource("https://api.example.com/instances", { Authorization: "Bearer real_key" });
    const entries = await source.fetchRawEntries();

    expect(entries).toEqual([{ x: 1 }]);
    expect(capturedUrl).toBe("https://api.example.com/instances");
    expect((capturedInit?.headers as Record<string, string>).Authorization).toBe("Bearer real_key");
  });

  it("uses extractEntries to pull the array out of a nested response envelope", async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ data: { types: [{ y: 1 }, { y: 2 }] } }), { status: 200 })) as unknown as typeof fetch;

    const source = new HttpRawEntrySource("https://api.example.com/instances", {}, (body: any) => body.data.types);
    const entries = await source.fetchRawEntries();
    expect(entries).toEqual([{ y: 1 }, { y: 2 }]);
  });

  it("throws a real error (fail-closed) on a non-2xx response rather than returning an empty array silently", async () => {
    global.fetch = vi.fn(async () => new Response("unauthorized", { status: 401 })) as unknown as typeof fetch;

    const source = new HttpRawEntrySource("https://api.example.com/instances");
    await expect(source.fetchRawEntries()).rejects.toThrow(/HTTP 401/);
  });
});

describe("WebhookRawEntrySource — push-fed seam", () => {
  it("returns whatever the latest known entries are at call time", async () => {
    let latest: unknown[] = [{ v: 1 }];
    const source = new WebhookRawEntrySource(() => latest);

    expect(await source.fetchRawEntries()).toEqual([{ v: 1 }]);

    // Simulates a webhook delivery updating the underlying state between
    // two ingestion cycles — the source reflects it on the next call
    // with no re-construction needed.
    latest = [{ v: 2 }, { v: 3 }];
    expect(await source.fetchRawEntries()).toEqual([{ v: 2 }, { v: 3 }]);
  });
});
