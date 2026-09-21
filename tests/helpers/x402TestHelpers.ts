import { ethers } from "ethers";
import { buildPaymentAuthorizationMessage } from "../../src/payments/baseVerification.js";

export function createTestPayerWallet(): ethers.HDNodeWallet {
  return ethers.Wallet.createRandom();
}

/** Real EIP-191 signing via a genuine (test) private key — proves
 * auth.ts's signature-recovery check works against actual ECDSA
 * signatures, not a stubbed "always valid" verifier. */
export async function signPaymentAuthorization(
  wallet: ethers.HDNodeWallet | ethers.Wallet,
  params: { nonce: string; amountUsdc: number; txHash: string },
): Promise<string> {
  const message = buildPaymentAuthorizationMessage({ ...params, network: "base" });
  return wallet.signMessage(message);
}

export function encodeX402Payment(params: {
  nonce: string;
  amountUsdc: number;
  payerAddress: string;
  txHash: string;
  signature: string;
}): string {
  const submission = { scheme: "exact", network: "base", ...params };
  return Buffer.from(JSON.stringify(submission)).toString("base64");
}
