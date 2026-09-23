import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { IngestionCache } from "../../src/ingestion/cache.js";
import { IngestionWorker } from "../../src/ingestion/worker.js";
import type { ProviderAdapter } from "../../src/providers/types.js";
import type { ProviderObservedFacts } from "../../src/types/schema.js";

const mockFacts: ProviderObservedFacts = {
  provider: "runpod",
  instance_type: "H100_80GB_SXM",
  region: "US-TX-1",
  base_hourly_rate_usd: 22.3,
  specs: { gpu_model: "H100_80GB_SXM", gpu_count: 8, gpu_memory_gb: 80, interconnect: "InfiniBand", vcpus: 192, ram_gb: 1500, local_storage_gb: 4000 },
  capacity_type: "on_demand",
  source: "fixture",
  availability_status: null,
  observed_at: new Date().toISOString(),
};

const INTERVAL_SECONDS = 30;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("IngestionWorker — background polling loop (CLAUDE.md §4, Phase 1)", () => {
  it("start() runs one ingestion cycle immediately, before any timer tick", async () => {
    const fetchSpy = vi.fn(async () => ({ provider: "runpod" as const, facts: [mockFacts], rejected: [], fetchedAt: new Date().toISOString() }));
    const adapter: ProviderAdapter = { id: "runpod", fetch: fetchSpy };
    const cache = new IngestionCache([adapter], 300);
    const worker = new IngestionWorker(cache, INTERVAL_SECONDS);

    await worker.start();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(worker.isRunning()).toBe(true);
    expect(worker.completedCycles).toBe(1);
    worker.stop();
  });

  it("re-fetches on the configured interval, not before and not skipped", async () => {
    const fetchSpy = vi.fn(async () => ({ provider: "runpod" as const, facts: [mockFacts], rejected: [], fetchedAt: new Date().toISOString() }));
    const adapter: ProviderAdapter = { id: "runpod", fetch: fetchSpy };
    const cache = new IngestionCache([adapter], 300);
    const worker = new IngestionWorker(cache, INTERVAL_SECONDS);

    await worker.start();
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(INTERVAL_SECONDS * 1000);
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(INTERVAL_SECONDS * 1000);
    expect(fetchSpy).toHaveBeenCalledTimes(3);

    worker.stop();
  });

  it("stop() actually halts the loop — no further fetches after stopping", async () => {
    const fetchSpy = vi.fn(async () => ({ provider: "runpod" as const, facts: [mockFacts], rejected: [], fetchedAt: new Date().toISOString() }));
    const adapter: ProviderAdapter = { id: "runpod", fetch: fetchSpy };
    const cache = new IngestionCache([adapter], 300);
    const worker = new IngestionWorker(cache, INTERVAL_SECONDS);

    await worker.start();
    worker.stop();
    expect(worker.isRunning()).toBe(false);

    await vi.advanceTimersByTimeAsync(INTERVAL_SECONDS * 5000);
    expect(fetchSpy).toHaveBeenCalledTimes(1); // only the initial start() cycle
  });

  it("start() is idempotent — calling it again while already running doesn't create a second timer", async () => {
    const fetchSpy = vi.fn(async () => ({ provider: "runpod" as const, facts: [mockFacts], rejected: [], fetchedAt: new Date().toISOString() }));
    const adapter: ProviderAdapter = { id: "runpod", fetch: fetchSpy };
    const cache = new IngestionCache([adapter], 300);
    const worker = new IngestionWorker(cache, INTERVAL_SECONDS);

    await worker.start();
    await worker.start(); // should be a no-op
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(INTERVAL_SECONDS * 1000);
    // If start() had wired a second interval, this would be 3, not 2.
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    worker.stop();
  });

  it("overlap protection — a slow-in-flight cycle is not joined by a second concurrent one on the next tick", async () => {
    const gate: { release: (() => void) | null } = { release: null };
    let callCount = 0;
    const fetchSpy = vi.fn(async () => {
      callCount += 1;
      if (callCount === 2) {
        // Cycle #2 hangs until the test explicitly releases it.
        await new Promise<void>((resolve) => { gate.release = resolve; });
      }
      return { provider: "runpod" as const, facts: [mockFacts], rejected: [], fetchedAt: new Date().toISOString() };
    });
    const adapter: ProviderAdapter = { id: "runpod", fetch: fetchSpy };
    const cache = new IngestionCache([adapter], 300);
    const worker = new IngestionWorker(cache, INTERVAL_SECONDS);

    await worker.start(); // cycle #1 — resolves immediately
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // Fire the tick that starts cycle #2 (which will hang).
    await vi.advanceTimersByTimeAsync(INTERVAL_SECONDS * 1000);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(worker.completedCycles).toBe(1); // cycle #2 hasn't completed yet

    // Fire the tick for what WOULD be cycle #3 — but #2 is still in
    // flight, so this must be skipped, not started concurrently.
    await vi.advanceTimersByTimeAsync(INTERVAL_SECONDS * 1000);
    expect(fetchSpy).toHaveBeenCalledTimes(2); // still 2, not 3 — the real assertion

    // Release cycle #2, let it finish.
    gate.release?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(worker.completedCycles).toBe(2);

    // Confirm the guard isn't a permanent lock — the next real tick works.
    await vi.advanceTimersByTimeAsync(INTERVAL_SECONDS * 1000);
    expect(fetchSpy).toHaveBeenCalledTimes(3);

    worker.stop();
  });
});
