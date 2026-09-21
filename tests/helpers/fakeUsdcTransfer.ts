import { ethers } from "ethers";
import { BASE_USDC_CONTRACT_ADDRESS } from "../../src/payments/baseVerification.js";

const TRANSFER_EVENT_ABI = ["event Transfer(address indexed from, address indexed to, uint256 value)"];

/** Genuinely ABI-encodes a Transfer event log the same way the real
 * USDC contract would emit one — proves baseVerification.ts's decode
 * path works against real encoding, not a hand-shaped object that
 * happens to have the right property names. */
export function encodeUsdcTransferLog(
  from: string,
  to: string,
  amountUsd: number,
  contractAddress: string = BASE_USDC_CONTRACT_ADDRESS,
): { address: string; topics: string[]; data: string } {
  const iface = new ethers.Interface(TRANSFER_EVENT_ABI);
  const valueRaw = ethers.parseUnits(amountUsd.toFixed(6), 6);
  const encoded = iface.encodeEventLog("Transfer", [from, to, valueRaw]);
  return { address: contractAddress, topics: encoded.topics as string[], data: encoded.data };
}

export function fakeSuccessfulReceipt(logs: { address: string; topics: string[]; data: string }[]) {
  return { status: 1, logs };
}

export function fakeFailedReceipt(logs: { address: string; topics: string[]; data: string }[] = []) {
  return { status: 0, logs };
}
