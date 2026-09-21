import { ethers } from "ethers";

/**
 * Real cryptographic verification for the x402/Base rail — the piece
 * that was mocked from the start (CLAUDE.md: "the actual on-chain
 * settlement verification is NOT built yet"). Two genuinely separate
 * checks, both real:
 *
 * 1. Signature recovery (pure math, no network) — proves whoever
 *    submitted this payment controls a specific private key and
 *    explicitly authorized THIS nonce/amount/txHash, not just any
 *    payment.
 * 2. On-chain transfer confirmation (a real RPC read) — proves actual
 *    USDC actually moved on Base, from the address the signature
 *    claims, to our real treasury address, for at least the required
 *    amount. Signature alone only proves intent; this proves
 *    settlement.
 *
 * Real Base USDC contract, verified directly against Circle's own
 * docs + BaseScan (2026-09), NOT from memory: the bridged variant
 * (USDbC) is a DIFFERENT, non-Circle-issued contract at a different
 * address — checking the wrong one would mean "verifying" transfers of
 * a token nobody is actually required to pay in.
 */
export const BASE_USDC_CONTRACT_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const USDC_DECIMALS = 6;
const TRANSFER_EVENT_ABI = ["event Transfer(address indexed from, address indexed to, uint256 value)"];

export function buildPaymentAuthorizationMessage(params: {
  nonce: string;
  amountUsdc: number;
  txHash: string;
  network: "base";
}): string {
  return [
    "ScoutWyze Compute Payment Authorization",
    `nonce: ${params.nonce}`,
    `amount: ${params.amountUsdc} USDC`,
    `txHash: ${params.txHash}`,
    `network: ${params.network}`,
  ].join("\n");
}

export function recoverPayerAddress(
  message: string,
  signature: string,
): { valid: true; address: string } | { valid: false; reason: string } {
  try {
    const address = ethers.verifyMessage(message, signature);
    return { valid: true, address };
  } catch (err) {
    return { valid: false, reason: `signature recovery failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

// The only surface this module actually needs from an ethers Provider
// — deliberately narrow so tests can inject a fake without needing a
// real ethers.JsonRpcProvider (or a live network) at all.
export interface MinimalChainReader {
  getTransactionReceipt(txHash: string): Promise<{
    status: number | null;
    logs: readonly { address: string; topics: readonly string[]; data: string }[];
  } | null>;
}

export async function verifyOnChainUsdcTransfer(
  provider: MinimalChainReader,
  txHash: string,
  expectedFromAddress: string,
  expectedToAddress: string,
  minAmountUsd: number,
): Promise<{ valid: true } | { valid: false; reason: string }> {
  let receipt;
  try {
    receipt = await provider.getTransactionReceipt(txHash);
  } catch (err) {
    // Fail closed on RPC errors — a network blip or bad hash must
    // never be treated as "verification passed."
    return { valid: false, reason: `RPC error fetching transaction receipt: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!receipt) return { valid: false, reason: "transaction not found — not yet mined, or an invalid hash" };
  if (receipt.status !== 1) return { valid: false, reason: "transaction failed/reverted on-chain" };

  let expectedFrom: string;
  let expectedTo: string;
  try {
    expectedFrom = ethers.getAddress(expectedFromAddress);
    expectedTo = ethers.getAddress(expectedToAddress);
  } catch {
    return { valid: false, reason: "malformed expected address" };
  }

  const minAmountRaw = ethers.parseUnits(minAmountUsd.toFixed(USDC_DECIMALS), USDC_DECIMALS);
  const iface = new ethers.Interface(TRANSFER_EVENT_ABI);

  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== BASE_USDC_CONTRACT_ADDRESS.toLowerCase()) continue;
    let parsed;
    try {
      parsed = iface.parseLog(log);
    } catch {
      continue; // a log on the USDC contract that isn't a Transfer — not our concern
    }
    if (!parsed || parsed.name !== "Transfer") continue;

    const from = parsed.args.from as string;
    const to = parsed.args.to as string;
    const value = parsed.args.value as bigint;

    if (from.toLowerCase() === expectedFrom.toLowerCase() && to.toLowerCase() === expectedTo.toLowerCase() && value >= minAmountRaw) {
      return { valid: true };
    }
  }

  return { valid: false, reason: "no matching USDC Transfer found in this transaction (wrong token, wrong from/to address, or amount below required)" };
}
