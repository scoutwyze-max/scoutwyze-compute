import type { MinimalFacilitatorClient, FacilitatorSettleResult } from "../../src/payments/payAiFacilitator.js";
import type { X402PaymentRequirements, X402PaymentSubmission } from "../../src/api/middleware/x402.js";
import type { FakeChainReader } from "./fakeChainReader.js";
import { fakeSuccessfulReceipt, encodeUsdcTransferLog } from "./fakeUsdcTransfer.js";

let txCounter = 0;
function fakeTxHash(): string {
  txCounter += 1;
  return "0x" + txCounter.toString(16).padStart(64, "0");
}

/** Test double for MinimalFacilitatorClient — no real network call to
 * PayAI, ever. By default, simulates a REAL successful settlement:
 * generates a fake txHash and registers a matching successful receipt
 * on the given FakeChainReader, so the subsequent independent
 * on-chain re-verification (auth.ts's own check, not PayAI's success
 * claim alone) exercises the full real path, not a short-circuited
 * one.
 *
 * Also simulates PayAI's real duplicate_settlement detection: the
 * same (from, nonce) pair submitted twice is rejected the second time
 * — mirroring what the underlying USDC contract's own
 * authorizationState mapping actually enforces on real mainnet. */
export class FakeFacilitatorClient implements MinimalFacilitatorClient {
  private nextResult: FacilitatorSettleResult | null = null;
  private seenAuthorizations = new Set<string>();

  constructor(private readonly chainReader: FakeChainReader) {}

  /** Override the next settle() call's result — for testing failure
   * paths (insufficient_funds, on-chain-reverted settlements, service
   * outages, etc). Cleared after one use. */
  setNextResult(result: FacilitatorSettleResult): void {
    this.nextResult = result;
  }

  async settle(paymentPayload: X402PaymentSubmission, paymentRequirements: X402PaymentRequirements): Promise<FacilitatorSettleResult> {
    if (this.nextResult) {
      const result = this.nextResult;
      this.nextResult = null;
      return result;
    }
    const { authorization } = paymentPayload.payload;
    const key = `${authorization.from.toLowerCase()}:${authorization.nonce.toLowerCase()}`;
    if (this.seenAuthorizations.has(key)) {
      return {
        success: false,
        transaction: "",
        network: paymentRequirements.network,
        errorReason: "duplicate_settlement",
        errorMessage: "this authorization has already been settled",
      };
    }
    this.seenAuthorizations.add(key);

    const txHash = fakeTxHash();
    const amountUsdc = Number(paymentRequirements.maxAmountRequired) / 1_000_000;
    this.chainReader.setReceipt(txHash, fakeSuccessfulReceipt([encodeUsdcTransferLog(authorization.from, authorization.to, amountUsdc)]));
    return { success: true, transaction: txHash, network: "base", payer: authorization.from };
  }
}
