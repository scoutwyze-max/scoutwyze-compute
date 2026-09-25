import { ethers } from "ethers";
import type { Eip3009Authorization, X402ErrorCode } from "../api/middleware/x402.js";

/**
 * Real cryptographic verification for the x402/Base rail. Two
 * genuinely separate checks, both real:
 *
 * 1. EIP-712/EIP-3009 signature recovery (pure math, no network) —
 *    proves whoever submitted this payment controls the private key
 *    for `authorization.from` and explicitly authorized this exact
 *    transfer (to/value/validAfter/validBefore/nonce), not just any
 *    payment. Domain and typehash independently verified 2026-09-26
 *    against real on-chain calls to the USDC contract itself (see
 *    EIP3009_DOMAIN's own comment) — not assumed from the EIP text.
 * 2. On-chain transfer confirmation (a real RPC read) — proves actual
 *    USDC actually moved on Base, to our real treasury address, for
 *    at least the required amount. Signature alone only proves
 *    intent to authorize; this proves settlement actually happened.
 *    Kept even though PayAI's /settle call also reports success —
 *    this server verifies for itself rather than trusting a
 *    facilitator's claim alone (payments/payAiFacilitator.ts only
 *    handles the broadcast, which requires a funded relayer wallet
 *    this server deliberately doesn't run).
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

/**
 * EIP-712 domain for Base USDC's EIP-3009 TransferWithAuthorization —
 * name/version verified 2026-09-26 by calling the real contract's
 * name()/version() getters on Base mainnet, then independently
 * re-deriving the domain separator hash from these values and
 * confirming it byte-for-byte matches the contract's own
 * DOMAIN_SEPARATOR() return value. The type structure itself
 * (TransferWithAuthorization(address from,address to,uint256
 * value,uint256 validAfter,uint256 validBefore,bytes32 nonce)) was
 * separately confirmed the same way against the contract's own
 * TRANSFER_WITH_AUTHORIZATION_TYPEHASH() getter — not copied from the
 * EIP text on faith. Both checks passed exactly; nothing here is
 * guessed.
 */
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

export function recoverEip3009Signer(
  authorization: Eip3009Authorization,
  signature: string,
): { valid: true; address: string } | { valid: false; reason: string; code: X402ErrorCode } {
  try {
    const value = {
      from: authorization.from,
      to: authorization.to,
      value: BigInt(authorization.value),
      validAfter: BigInt(authorization.validAfter),
      validBefore: BigInt(authorization.validBefore),
      nonce: authorization.nonce,
    };
    const address = ethers.verifyTypedData(EIP3009_DOMAIN, EIP3009_TYPES, value, signature);
    return { valid: true, address };
  } catch (err) {
    return {
      valid: false,
      reason: `EIP-3009 signature recovery failed: ${err instanceof Error ? err.message : String(err)}`,
      code: "invalid_exact_evm_payload_signature",
    };
  }
}

/** Pure business-rule checks on an EIP-3009 authorization — no
 * network, no signature math, just: does this authorize the right
 * recipient, for enough USDC, within a currently-valid time window.
 * Deliberately separate from signature recovery so a caller can
 * order checks (cheapest/most-informative-first) however it wants. */
export function checkEip3009AuthorizationBounds(
  authorization: Eip3009Authorization,
  expectedToAddress: string,
  minAmountUsd: number,
  nowSeconds: number,
): { valid: true } | { valid: false; reason: string; code: X402ErrorCode } {
  let to: string;
  let expectedTo: string;
  try {
    to = ethers.getAddress(authorization.to);
    expectedTo = ethers.getAddress(expectedToAddress);
  } catch {
    return { valid: false, reason: "malformed address in authorization", code: "invalid_payload" };
  }
  if (to.toLowerCase() !== expectedTo.toLowerCase()) {
    return { valid: false, reason: `authorization.to (${to}) does not match our treasury address`, code: "invalid_exact_evm_payload_recipient_mismatch" };
  }

  const minAmountRaw = ethers.parseUnits(minAmountUsd.toFixed(USDC_DECIMALS), USDC_DECIMALS);
  let value: bigint;
  try {
    value = BigInt(authorization.value);
  } catch {
    return { valid: false, reason: "authorization.value is not a valid integer string", code: "invalid_payload" };
  }
  if (value < minAmountRaw) {
    return {
      valid: false,
      reason: `authorization.value (${authorization.value}) below the required ${minAmountRaw.toString()} atomic units`,
      code: "invalid_exact_evm_payload_authorization_value_mismatch",
    };
  }

  const now = BigInt(nowSeconds);
  let validAfter: bigint;
  let validBefore: bigint;
  try {
    validAfter = BigInt(authorization.validAfter);
    validBefore = BigInt(authorization.validBefore);
  } catch {
    return { valid: false, reason: "validAfter/validBefore are not valid integer strings", code: "invalid_payload" };
  }
  if (now < validAfter) {
    return { valid: false, reason: "authorization is not valid yet (validAfter is in the future)", code: "invalid_exact_evm_payload_authorization_valid_after" };
  }
  if (now >= validBefore) {
    return { valid: false, reason: "authorization has expired (validBefore has passed)", code: "invalid_exact_evm_payload_authorization_valid_before" };
  }

  return { valid: true };
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
): Promise<{ valid: true } | { valid: false; reason: string; code: X402ErrorCode }> {
  let receipt;
  try {
    receipt = await provider.getTransactionReceipt(txHash);
  } catch (err) {
    // Fail closed on RPC errors — a network blip or bad hash must
    // never be treated as "verification passed." unexpected_verify_error,
    // not invalid_transaction_state — this is OUR infra failing to
    // check, not proof the client's tx is actually bad; a retry might
    // succeed once the RPC is healthy again.
    return {
      valid: false,
      reason: `RPC error fetching transaction receipt: ${err instanceof Error ? err.message : String(err)}`,
      code: "unexpected_verify_error",
    };
  }
  if (!receipt) return { valid: false, reason: "transaction not found — not yet mined, or an invalid hash", code: "invalid_transaction_state" };
  if (receipt.status !== 1) return { valid: false, reason: "transaction failed/reverted on-chain", code: "invalid_transaction_state" };

  let expectedFrom: string;
  let expectedTo: string;
  try {
    expectedFrom = ethers.getAddress(expectedFromAddress);
    expectedTo = ethers.getAddress(expectedToAddress);
  } catch {
    // Our own config would have to be broken for this branch to fire
    // (expectedToAddress is our own treasury address) — an internal
    // fault, not a claim about the client's payload.
    return { valid: false, reason: "malformed expected address", code: "unexpected_verify_error" };
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

  return {
    valid: false,
    reason: "no matching USDC Transfer found in this transaction (wrong token, wrong from/to address, or amount below required)",
    code: "invalid_payload",
  };
}
