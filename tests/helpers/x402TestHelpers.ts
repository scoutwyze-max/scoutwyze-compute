import { ethers } from "ethers";
import { BASE_USDC_CONTRACT_ADDRESS } from "../../src/payments/baseVerification.js";
import type { Eip3009Authorization } from "../../src/api/middleware/x402.js";

// Same domain/types as baseVerification.ts's EIP3009_DOMAIN/EIP3009_TYPES
// — deliberately duplicated here (not imported) so a test that gets
// this wrong would produce a signature the REAL verification code
// rejects, the same way a real external client's mistake would.
const EIP3009_DOMAIN = {
  name: "USD Coin",
  version: "2",
  chainId: 8453,
  verifyingContract: BASE_USDC_CONTRACT_ADDRESS,
};
const EIP3009_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
};

export function createTestPayerWallet(): ethers.HDNodeWallet {
  return ethers.Wallet.createRandom();
}

export function buildEip3009Authorization(params: {
  from: string;
  to: string;
  amountUsdc: number;
  nowSeconds?: number;
  validAfterOffsetSeconds?: number;
  validBeforeOffsetSeconds?: number;
}): Eip3009Authorization {
  const now = params.nowSeconds ?? Math.floor(Date.now() / 1000);
  return {
    from: params.from,
    to: params.to,
    value: Math.round(params.amountUsdc * 1_000_000).toString(),
    validAfter: (now + (params.validAfterOffsetSeconds ?? -60)).toString(),
    validBefore: (now + (params.validBeforeOffsetSeconds ?? 120)).toString(),
    nonce: ethers.hexlify(ethers.randomBytes(32)),
  };
}

/** Real EIP-712 signing via a genuine (test) private key — proves
 * baseVerification.ts's recoverEip3009Signer works against actual
 * typed-data signatures, not a stubbed "always valid" verifier. */
export async function signEip3009Authorization(
  wallet: ethers.HDNodeWallet | ethers.Wallet,
  authorization: Eip3009Authorization,
): Promise<string> {
  const value = {
    from: authorization.from,
    to: authorization.to,
    value: BigInt(authorization.value),
    validAfter: BigInt(authorization.validAfter),
    validBefore: BigInt(authorization.validBefore),
    nonce: authorization.nonce,
  };
  return wallet.signTypedData(EIP3009_DOMAIN, EIP3009_TYPES, value);
}

export function encodeX402Payment(authorization: Eip3009Authorization, signature: string): string {
  const submission = { x402Version: 1, scheme: "exact", network: "base", payload: { signature, authorization } };
  return Buffer.from(JSON.stringify(submission)).toString("base64");
}
