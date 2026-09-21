/**
 * Real Stripe Checkout Session creation — direct REST call against
 * Stripe's API (same "hand-roll it, no SDK dependency" call already
 * made for webhook signature verification in stripeWebhook.ts; Session
 * creation is one POST with a form-encoded body, not worth a
 * dependency for). The session's metadata.accountId is the exact
 * contract stripeWebhook.ts's parseCheckoutCompletedEvent() reads back
 * out once payment completes — this is the one place that contract is
 * actually produced.
 */
export interface CreditPack {
  id: string;
  label: string;
  amountUsd: number;
}

// Initial packs — placeholder amounts against CLAUDE.md's $0.10-0.25/
// quote pricing (starter = 40-100 quotes). Robert's to tune, not a
// locked business decision.
export const CREDIT_PACKS: readonly CreditPack[] = [
  { id: "starter", label: "ScoutWyze Compute — Starter Credit Pack", amountUsd: 10 },
  { id: "growth", label: "ScoutWyze Compute — Growth Credit Pack", amountUsd: 50 },
  { id: "scale", label: "ScoutWyze Compute — Scale Credit Pack", amountUsd: 200 },
];

export interface CheckoutSessionResult {
  id: string;
  url: string;
}

/** Narrow interface (mirrors MinimalChainReader's reasoning in
 * baseVerification.ts) so tests can inject a fake without a real
 * Stripe secret key or network call. */
export interface CheckoutSessionCreator {
  createCheckoutSession(params: {
    accountId: string;
    amountUsd: number;
    packLabel: string;
    successUrl: string;
    cancelUrl: string;
  }): Promise<CheckoutSessionResult>;
}

export class StripeCheckoutSessionCreator implements CheckoutSessionCreator {
  constructor(private readonly secretKey: string) {}

  async createCheckoutSession(params: {
    accountId: string;
    amountUsd: number;
    packLabel: string;
    successUrl: string;
    cancelUrl: string;
  }): Promise<CheckoutSessionResult> {
    const body = new URLSearchParams();
    body.set("mode", "payment");
    body.set("success_url", params.successUrl);
    body.set("cancel_url", params.cancelUrl);
    body.set("line_items[0][quantity]", "1");
    body.set("line_items[0][price_data][currency]", "usd");
    body.set("line_items[0][price_data][unit_amount]", String(Math.round(params.amountUsd * 100)));
    body.set("line_items[0][price_data][product_data][name]", params.packLabel);
    // The exact field parseCheckoutCompletedEvent() reads back once the
    // webhook fires — see stripeWebhook.ts's own metadata-contract note.
    body.set("metadata[accountId]", params.accountId);

    const res = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.secretKey}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    });

    if (!res.ok) {
      const errBody = await res.text();
      throw new Error(`Stripe checkout session creation failed (HTTP ${res.status}): ${errBody}`);
    }

    const data = (await res.json()) as { id: string; url: string };
    return { id: data.id, url: data.url };
  }
}
