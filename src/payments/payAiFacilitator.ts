import type { X402PaymentRequirements, X402PaymentSubmission } from "../api/middleware/x402.js";

/**
 * PayAI facilitator client — the piece that actually broadcasts a
 * verified EIP-3009 transferWithAuthorization call. This server
 * verifies the signature and bounds itself first (see
 * baseVerification.ts's recoverEip3009Signer/checkEip3009AuthorizationBounds)
 * and independently re-checks the resulting on-chain transfer after
 * settlement (verifyOnChainUsdcTransfer) — PayAI is used only for the
 * one thing this server deliberately doesn't do itself: running a
 * funded relayer wallet to submit the transaction.
 *
 * Request/response shapes verified 2026-09-26 directly against
 * PayAI's own live OpenAPI description (payai.network/openapi.json,
 * SettleRequest/SettleResponse schemas) — real fields, not guessed:
 * `{x402Version, paymentPayload, paymentRequirements}` in, `{success,
 * transaction, network, payer?, errorReason?, errorMessage?}` out.
 * "Ordinary exact payments can use the available free tier without
 * merchant credentials" per PayAI's own docs — no API key wired here,
 * deliberately, matching that.
 */
export interface FacilitatorSettleResult {
  success: boolean;
  transaction: string;
  network: string;
  payer?: string;
  errorReason?: string;
  errorMessage?: string;
}

// The only surface this codebase needs from a facilitator — narrow
// and swappable, same reasoning as MinimalChainReader in
// baseVerification.ts: tests inject a fake, no real network call.
export interface MinimalFacilitatorClient {
  settle(paymentPayload: X402PaymentSubmission, paymentRequirements: X402PaymentRequirements): Promise<FacilitatorSettleResult>;
}

const DEFAULT_FACILITATOR_BASE_URL = "https://facilitator.payai.network";

export class PayAiFacilitatorClient implements MinimalFacilitatorClient {
  constructor(private readonly baseUrl: string = DEFAULT_FACILITATOR_BASE_URL) {}

  async settle(paymentPayload: X402PaymentSubmission, paymentRequirements: X402PaymentRequirements): Promise<FacilitatorSettleResult> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/settle`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ x402Version: 1, paymentPayload, paymentRequirements }),
      });
    } catch (err) {
      // Network failure reaching PayAI itself — fail closed, this is
      // not a claim the payment is bad, it's our infra/their infra
      // being unreachable.
      return {
        success: false,
        transaction: "",
        network: paymentRequirements.network,
        errorReason: "service_unavailable",
        errorMessage: `Failed to reach PayAI facilitator: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return {
        success: false,
        transaction: "",
        network: paymentRequirements.network,
        errorReason: "service_unavailable",
        errorMessage: `PayAI returned HTTP ${res.status} with a non-JSON body`,
      };
    }

    // PayAI's own doc warning, taken seriously: "Edge failures,
    // timeouts and lost responses may not contain this JSON shape" —
    // validate rather than trust the shape blindly.
    const b = body as Partial<FacilitatorSettleResult>;
    if (typeof b.success !== "boolean" || typeof b.transaction !== "string" || typeof b.network !== "string") {
      return {
        success: false,
        transaction: "",
        network: paymentRequirements.network,
        errorReason: "service_unavailable",
        errorMessage: `PayAI response did not match the expected SettleResponse shape (HTTP ${res.status})`,
      };
    }
    return {
      success: b.success,
      transaction: b.transaction,
      network: b.network,
      payer: b.payer,
      errorReason: b.errorReason,
      errorMessage: b.errorMessage,
    };
  }
}
