import type { MinimalChainReader } from "../../src/payments/baseVerification.js";

type Receipt = Awaited<ReturnType<MinimalChainReader["getTransactionReceipt"]>>;

/** Test double for MinimalChainReader — no network, no real RPC. Tests
 * configure exactly the receipt a given txHash should "return", so the
 * verification logic in baseVerification.ts runs for real against
 * realistic-shaped data (see fakeUsdcTransfer.ts for genuinely
 * ABI-encoded logs, not just hand-waved objects). */
export class FakeChainReader implements MinimalChainReader {
  private receipts = new Map<string, Receipt>();
  private errors = new Map<string, Error>();

  setReceipt(txHash: string, receipt: Receipt): void {
    this.receipts.set(txHash, receipt);
  }

  setError(txHash: string, error: Error): void {
    this.errors.set(txHash, error);
  }

  async getTransactionReceipt(txHash: string): Promise<Receipt> {
    const err = this.errors.get(txHash);
    if (err) throw err;
    return this.receipts.get(txHash) ?? null;
  }
}
