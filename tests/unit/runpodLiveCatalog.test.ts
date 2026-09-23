import { describe, expect, it, vi, afterEach } from "vitest";
import { RunpodLiveCatalogSource, createRunpodAdapter } from "../../src/providers/runpod.js";

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});

describe("RunpodLiveCatalogSource — real v2 catalog shape, mocked (no live network in tests)", () => {
  it("flattens one GPU × one data center × both pricing tiers into 2 raw entries", async () => {
    let capturedUrl: string | undefined;
    let capturedInit: RequestInit | undefined;
    global.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedInit = init;
      return new Response(
        JSON.stringify({
          gpus: [
            {
              id: "NVIDIA H100 80GB HBM3",
              memory: 80,
              maxCount: { community: 1, secure: 8 },
              price: { community: 2.69, secure: 3.49, serverless: 4.79 },
              dataCenters: [{ id: "US-CA-2", availability: "LOW" }],
            },
          ],
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const source = new RunpodLiveCatalogSource("fake_key");
    const entries = (await source.fetchRawEntries()) as Record<string, unknown>[];

    expect(capturedUrl).toBe("https://api.runpod.io/v2/catalog/gpus?include=AVAILABILITY&product=POD");
    expect((capturedInit?.headers as Record<string, string>).Authorization).toBe("Bearer fake_key");

    expect(entries).toHaveLength(2);
    const secure = entries.find((e) => e.cloudType === "SECURE")!;
    const community = entries.find((e) => e.cloudType === "COMMUNITY")!;

    expect(secure).toMatchObject({ gpuTypeId: "NVIDIA H100 80GB HBM3", dataCenter: "US-CA-2", gpuCount: 8, pricePerGpuHr: 3.49, spotPrice: null, gpuMemoryGb: 80, availability: "LOW" });
    expect(community).toMatchObject({ gpuTypeId: "NVIDIA H100 80GB HBM3", dataCenter: "US-CA-2", gpuCount: 1, pricePerGpuHr: null, spotPrice: 2.69, gpuMemoryGb: 80, availability: "LOW" });

    // Honest placeholders, not invented precision — RunPod's catalog
    // doesn't report per-node vcpu/ram/disk/interconnect.
    for (const e of entries) {
      expect(e.vcpuCount).toBe(1);
      expect(e.memoryInGb).toBe(1);
      expect(e.containerDiskInGb).toBe(0);
      expect(e.networkFabric).toBe("unspecified");
    }
  });

  it("skips a GPU with no data centers listed (e.g. availability NONE) rather than producing garbage rows", async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ gpus: [{ id: "AMD Instinct MI300X OAM", memory: 192, maxCount: { secure: 8 }, price: { secure: 2.39 } }] }), { status: 200 })) as unknown as typeof fetch;

    const source = new RunpodLiveCatalogSource("fake_key");
    const entries = await source.fetchRawEntries();
    expect(entries).toHaveLength(0);
  });

  it("only emits the SECURE row when community pricing/maxCount is absent", async () => {
    global.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ gpus: [{ id: "NVIDIA H100 PCIe", memory: 80, maxCount: { secure: 8 }, price: { secure: 2.89 }, dataCenters: [{ id: "US-KS-2", availability: "LOW" }] }] }),
          { status: 200 },
        ),
    ) as unknown as typeof fetch;

    const source = new RunpodLiveCatalogSource("fake_key");
    const entries = (await source.fetchRawEntries()) as Record<string, unknown>[];
    expect(entries).toHaveLength(1);
    expect(entries[0]?.cloudType).toBe("SECURE");
  });

  it("throws on a non-2xx response rather than returning an empty/silent result", async () => {
    global.fetch = vi.fn(async () => new Response("unauthorized", { status: 401 })) as unknown as typeof fetch;
    const source = new RunpodLiveCatalogSource("bad_key");
    await expect(source.fetchRawEntries()).rejects.toThrow(/RunPod catalog fetch failed \(HTTP 401\)/);
  });
});

describe("createRunpodAdapter — live_api factSource + availability_status mapping", () => {
  it("tags facts source:\"live_api\" and maps a recognized availability string to lowercase", async () => {
    global.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ gpus: [{ id: "NVIDIA H100 80GB HBM3", memory: 80, maxCount: { secure: 8 }, price: { secure: 3.49 }, dataCenters: [{ id: "US-CA-2", availability: "LOW" }] }] }),
          { status: 200 },
        ),
    ) as unknown as typeof fetch;

    const adapter = createRunpodAdapter(new RunpodLiveCatalogSource("fake_key"), "live_api");
    const result = await adapter.fetch();
    expect(result.facts).toHaveLength(1);
    expect(result.facts[0]?.source).toBe("live_api");
    expect(result.facts[0]?.availability_status).toBe("low");
  });

  it("maps an unrecognized/missing availability string to null rather than guessing", async () => {
    global.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ gpus: [{ id: "NVIDIA H100 80GB HBM3", memory: 80, maxCount: { secure: 8 }, price: { secure: 3.49 }, dataCenters: [{ id: "US-CA-2", availability: "SOMETHING_NEW" }] }] }),
          { status: 200 },
        ),
    ) as unknown as typeof fetch;

    const adapter = createRunpodAdapter(new RunpodLiveCatalogSource("fake_key"), "live_api");
    const result = await adapter.fetch();
    expect(result.facts[0]?.availability_status).toBeNull();
  });
});
