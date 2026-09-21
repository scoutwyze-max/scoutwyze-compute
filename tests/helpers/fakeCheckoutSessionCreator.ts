import type { CheckoutSessionCreator, CheckoutSessionResult } from "../../src/payments/stripeCheckout.js";

/** Test double for CheckoutSessionCreator — no real Stripe secret key
 * or network call, same DI reasoning as FakeChainReader. */
export class FakeCheckoutSessionCreator implements CheckoutSessionCreator {
  public lastParams: Parameters<CheckoutSessionCreator["createCheckoutSession"]>[0] | undefined;
  private shouldFail = false;

  setShouldFail(fail: boolean): void {
    this.shouldFail = fail;
  }

  async createCheckoutSession(
    params: Parameters<CheckoutSessionCreator["createCheckoutSession"]>[0],
  ): Promise<CheckoutSessionResult> {
    this.lastParams = params;
    if (this.shouldFail) throw new Error("simulated Stripe API failure");
    return { id: `cs_test_${params.accountId}`, url: `https://checkout.stripe.com/test/${params.accountId}` };
  }
}
