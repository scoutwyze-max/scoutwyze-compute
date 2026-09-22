import { describe, expect, it, vi, afterEach } from "vitest";
import { LambdaLabsBooker, SimulatedLambdaLabsBooker } from "../../src/engine/vendorBooker.js";

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});

describe("LambdaLabsBooker — real API shape, mocked (no live GPU ever in tests)", () => {
  it("fails closed without ever calling Lambda's API when no SSH key name is configured", async () => {
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy as unknown as typeof fetch;

    const booker = new LambdaLabsBooker("fake_api_key", undefined);
    const result = await booker.book({ sku: "gpu_8x_h100_sxm5", region: "us-east-1", hours: 1, vendorHourly: 27.12 });

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
    const result = await booker.book({ sku: "gpu_8x_h100_sxm5", region: "us-east-1", hours: 2, vendorHourly: 27.12 });

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
    const result = await booker.book({ sku: "gpu_8x_h100_sxm5", region: "us-east-1", hours: 1, vendorHourly: 27.12 });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("Not enough capacity for gpu_8x_h100_sxm5 in us-east-1");
  });

  it("returns ok:false on a network failure rather than throwing", async () => {
    global.fetch = vi.fn(async () => { throw new Error("connection reset"); }) as unknown as typeof fetch;

    const booker = new LambdaLabsBooker("fake_api_key", "my-ssh-key");
    const result = await booker.book({ sku: "gpu_8x_h100_sxm5", region: "us-east-1", hours: 1, vendorHourly: 27.12 });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/connection reset/);
  });

  it("returns ok:false on a 200 response missing instance_ids, rather than a fake jobId", async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ data: {} }), { status: 200 })) as unknown as typeof fetch;

    const booker = new LambdaLabsBooker("fake_api_key", "my-ssh-key");
    const result = await booker.book({ sku: "gpu_8x_h100_sxm5", region: "us-east-1", hours: 1, vendorHourly: 27.12 });

    expect(result.ok).toBe(false);
  });
});

describe("SimulatedLambdaLabsBooker — the dev/no-key fallback, still real behavior", () => {
  it("always succeeds and clearly labels itself as simulated", async () => {
    const booker = new SimulatedLambdaLabsBooker();
    const result = await booker.book({ sku: "gpu_8x_h100_sxm5", region: "us-east-1", hours: 1, vendorHourly: 27.12 });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.connectInfo?.simulated).toBe(true);
  });
});
