import { describe, expect, it, vi, afterEach } from "vitest";
import { StripeCheckoutSessionCreator, CREDIT_PACKS } from "../../src/payments/stripeCheckout.js";

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
});

describe("StripeCheckoutSessionCreator", () => {
  it("POSTs to Stripe's real Checkout Sessions endpoint with the secret key and metadata.accountId", async () => {
    let capturedUrl: string | undefined;
    let capturedInit: RequestInit | undefined;
    global.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedInit = init;
      return new Response(JSON.stringify({ id: "cs_test_123", url: "https://checkout.stripe.com/pay/cs_test_123" }), { status: 200 });
    }) as unknown as typeof fetch;

    const creator = new StripeCheckoutSessionCreator("sk_test_abc");
    const result = await creator.createCheckoutSession({
      accountId: "acct_1",
      amountUsd: 10,
      packLabel: "Starter Pack",
      successUrl: "https://example.com/success",
      cancelUrl: "https://example.com/cancel",
    });

    expect(result).toEqual({ id: "cs_test_123", url: "https://checkout.stripe.com/pay/cs_test_123" });
    expect(capturedUrl).toBe("https://api.stripe.com/v1/checkout/sessions");
    expect((capturedInit?.headers as Record<string, string>).Authorization).toBe("Bearer sk_test_abc");

    const body = (capturedInit?.body as URLSearchParams).toString();
    expect(body).toContain("metadata%5BaccountId%5D=acct_1");
    expect(body).toContain("line_items%5B0%5D%5Bprice_data%5D%5Bunit_amount%5D=1000"); // $10 -> 1000 cents
    expect(body).toContain("mode=payment");
  });

  it("throws a real error (not a silent empty result) when Stripe returns a non-2xx response", async () => {
    global.fetch = vi.fn(async () => new Response("bad request: no such price", { status: 400 })) as unknown as typeof fetch;

    const creator = new StripeCheckoutSessionCreator("sk_test_bad");
    await expect(
      creator.createCheckoutSession({
        accountId: "acct_1",
        amountUsd: 10,
        packLabel: "Starter Pack",
        successUrl: "https://example.com/success",
        cancelUrl: "https://example.com/cancel",
      }),
    ).rejects.toThrow(/HTTP 400/);
  });
});

describe("CREDIT_PACKS", () => {
  it("every pack has a unique id and a positive amount", () => {
    const ids = CREDIT_PACKS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const pack of CREDIT_PACKS) {
      expect(pack.amountUsd).toBeGreaterThan(0);
      expect(pack.label.length).toBeGreaterThan(0);
    }
  });
});
