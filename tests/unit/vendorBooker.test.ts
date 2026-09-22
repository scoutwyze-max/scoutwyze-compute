import { describe, expect, it, vi, afterEach } from "vitest";
import { LambdaLabsBooker, SimulatedLambdaLabsBooker, RunPodBooker } from "../../src/engine/vendorBooker.js";

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});

describe("LambdaLabsBooker — real API shape, mocked (no live GPU ever in tests)", () => {
  it("fails closed without ever calling Lambda's API when no SSH key name is configured", async () => {
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy as unknown as typeof fetch;

    const booker = new LambdaLabsBooker("fake_api_key", undefined);
    const result = await booker.book({ sku: "gpu_8x_h100_sxm5", region: "us-east-1", hours: 1, vendorHourly: 27.12, gpuCount: 8 });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/LAMBDA_SSH_KEY_NAME not configured/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("POSTs the real Lambda launch shape with Basic auth, and returns ok on a real-shaped success response", async () => {
    let capturedUrl: string | undefined;
    let capturedInit: RequestInit | undefined;
    global.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedInit = init;
      return new Response(JSON.stringify({ data: { instance_ids: ["i-abc123"] } }), { status: 200 });
    }) as unknown as typeof fetch;

    const booker = new LambdaLabsBooker("fake_api_key", "my-ssh-key");
    const result = await booker.book({ sku: "gpu_8x_h100_sxm5", region: "us-east-1", hours: 2, vendorHourly: 27.12, gpuCount: 8 });

    expect(result).toEqual({
      ok: true,
      jobId: "i-abc123",
      connectInfo: { instanceId: "i-abc123", region: "us-east-1", instanceType: "gpu_8x_h100_sxm5" },
    });
    expect(capturedUrl).toBe("https://cloud.lambdalabs.com/api/v1/instance-operations/launch");
    const auth = (capturedInit?.headers as Record<string, string>).Authorization;
    expect(auth).toBe("Basic " + Buffer.from("fake_api_key:").toString("base64"));
    const body = JSON.parse(capturedInit?.body as string);
    expect(body).toEqual({ region_name: "us-east-1", instance_type_name: "gpu_8x_h100_sxm5", ssh_key_names: ["my-ssh-key"], quantity: 1 });
  });

  it("returns ok:false with Lambda's real error message on a non-2xx response (e.g. capacity)", async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ error: { message: "Not enough capacity for gpu_8x_h100_sxm5 in us-east-1" } }), { status: 400 })) as unknown as typeof fetch;

    const booker = new LambdaLabsBooker("fake_api_key", "my-ssh-key");
    const result = await booker.book({ sku: "gpu_8x_h100_sxm5", region: "us-east-1", hours: 1, vendorHourly: 27.12, gpuCount: 8 });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("Not enough capacity for gpu_8x_h100_sxm5 in us-east-1");
  });

  it("returns ok:false on a network failure rather than throwing", async () => {
    global.fetch = vi.fn(async () => { throw new Error("connection reset"); }) as unknown as typeof fetch;

    const booker = new LambdaLabsBooker("fake_api_key", "my-ssh-key");
    const result = await booker.book({ sku: "gpu_8x_h100_sxm5", region: "us-east-1", hours: 1, vendorHourly: 27.12, gpuCount: 8 });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/connection reset/);
  });

  it("returns ok:false on a 200 response missing instance_ids, rather than a fake jobId", async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ data: {} }), { status: 200 })) as unknown as typeof fetch;

    const booker = new LambdaLabsBooker("fake_api_key", "my-ssh-key");
    const result = await booker.book({ sku: "gpu_8x_h100_sxm5", region: "us-east-1", hours: 1, vendorHourly: 27.12, gpuCount: 8 });

    expect(result.ok).toBe(false);
  });
});

describe("RunPodBooker — real v2 API shape, mocked (no live GPU ever in tests)", () => {
  it("POSTs the real RunPod v2 launch shape with Bearer auth, and returns ok on a real-shaped success response", async () => {
    let capturedUrl: string | undefined;
    let capturedInit: RequestInit | undefined;
    global.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedInit = init;
      return new Response(JSON.stringify({ id: "pod-abc123", status: "PROVISIONING" }), { status: 201 });
    }) as unknown as typeof fetch;

    const booker = new RunPodBooker("fake_api_key", "runpod/pytorch:2.1.0-py3.10-cuda11.8.0-devel", 50);
    const result = await booker.book({ sku: "H100_80GB_SXM", region: "US-TX-1", hours: 1, vendorHourly: 22.32, gpuCount: 8 });

    expect(result).toEqual({
      ok: true,
      jobId: "pod-abc123",
      connectInfo: { podId: "pod-abc123", status: "PROVISIONING", region: "US-TX-1", gpu: "H100_80GB_SXM", gpuCount: 8 },
    });
    expect(capturedUrl).toBe("https://api.runpod.io/v2/pods");
    const auth = (capturedInit?.headers as Record<string, string>).Authorization;
    expect(auth).toBe("Bearer fake_api_key");
    const body = JSON.parse(capturedInit?.body as string);
    expect(body).toEqual({
      name: expect.stringContaining("scoutwyze-"),
      gpu: { id: "H100_80GB_SXM", count: 8 },
      image: "runpod/pytorch:2.1.0-py3.10-cuda11.8.0-devel",
      dataCenterIds: ["US-TX-1"],
      disk: 50,
    });
  });

  it("returns ok:false with RunPod's real error message on a non-2xx response", async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ error: "No capacity available for H100_80GB_SXM in US-TX-1" }), { status: 400 })) as unknown as typeof fetch;

    const booker = new RunPodBooker("fake_api_key", "some-image", 50);
    const result = await booker.book({ sku: "H100_80GB_SXM", region: "US-TX-1", hours: 1, vendorHourly: 22.32, gpuCount: 8 });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("No capacity available for H100_80GB_SXM in US-TX-1");
  });

  it("returns ok:false on a network failure rather than throwing", async () => {
    global.fetch = vi.fn(async () => { throw new Error("connection reset"); }) as unknown as typeof fetch;

    const booker = new RunPodBooker("fake_api_key", "some-image", 50);
    const result = await booker.book({ sku: "H100_80GB_SXM", region: "US-TX-1", hours: 1, vendorHourly: 22.32, gpuCount: 8 });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/connection reset/);
  });

  it("returns ok:false on a 201 response missing an id, rather than a fake jobId", async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ status: "PROVISIONING" }), { status: 201 })) as unknown as typeof fetch;

    const booker = new RunPodBooker("fake_api_key", "some-image", 50);
    const result = await booker.book({ sku: "H100_80GB_SXM", region: "US-TX-1", hours: 1, vendorHourly: 22.32, gpuCount: 8 });

    expect(result.ok).toBe(false);
  });
});

describe("SimulatedLambdaLabsBooker — the dev/no-key fallback, still real behavior", () => {
  it("always succeeds and clearly labels itself as simulated", async () => {
    const booker = new SimulatedLambdaLabsBooker();
    const result = await booker.book({ sku: "gpu_8x_h100_sxm5", region: "us-east-1", hours: 1, vendorHourly: 27.12, gpuCount: 8 });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.connectInfo?.simulated).toBe(true);
  });
});
