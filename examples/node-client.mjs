#!/usr/bin/env node
// Copy-pasteable Node.js client for ScoutWyze Compute — dual-rail
// (Bearer or x402/USDC-on-Base), targeting the flagship POST
// /v1/compute/rank envelope. Two exported functions, no framework
// dependency beyond `ethers` (only needed for the x402 rail's
// signing/broadcast — the Bearer rail is plain fetch).
//
// npm install ethers
//
// Usage as a CLI:
//   node node-client.mjs bearer <apiKey> [gpuClass]
//   node node-client.mjs x402 <privateKey> [gpuClass]        # signs AND broadcasts a real on-chain USDC transfer
//   node node-client.mjs x402 <privateKey> [gpuClass] --dry-run  # stop after signing, don't broadcast
//
// Usage as a library:
//   import { rankViaBearer, rankViaX402 } from "./node-client.mjs";

import { ethers } from "ethers";

const DEFAULT_BASE_URL = "https://scoutwyze-compute.fly.dev";
const DEFAULT_RPC_URL = "https://mainnet.base.org";

// Real Base USDC contract — Circle-issued, NOT the bridged USDbC token
// at a different address. Must match src/payments/baseVerification.ts's
// BASE_USDC_CONTRACT_ADDRESS exactly, or a real transfer would move
// the wrong token and the server's on-chain check would correctly
// reject it as "no matching USDC Transfer found."
const BASE_USDC_CONTRACT_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const USDC_DECIMALS = 6;
const ERC20_TRANSFER_ABI = ["function transfer(address to, uint256 amount) returns (bool)"];

/** Must match src/payments/baseVerification.ts's
 * buildPaymentAuthorizationMessage on the server EXACTLY — this is the
 * canonical message the server recomputes and checks the signature
 * against. Any drift here means a real signature that recovers to the
 * wrong address, rejected server-side with code
 * invalid_exact_evm_payload_signature. */
function buildPaymentAuthorizationMessage({ nonce, amountUsdc, txHash, network }) {
  return ["ScoutWyze Compute Payment Authorization", `nonce: ${nonce}`, `amount: ${amountUsdc} USDC`, `txHash: ${txHash}`, `network: ${network}`].join(
    "\n",
  );
}

/** Rail 1 — prepaid Bearer key. A human funds the account once
 * (POST /v1/signup + POST /v1/checkout-sessions); from then on this
 * is a single unauthenticated-looking call with zero further human
 * involvement. */
export async function rankViaBearer(baseUrl, apiKey, params = {}) {
  const res = await fetch(`${baseUrl}/v1/compute/rank`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(params),
  });
  return { status: res.status, body: await res.json() };
}

/** Rail 2 — x402/USDC on Base. Zero human involvement, ever: this
 * function gets the real 402 challenge, signs the canonical
 * authorization message, broadcasts a REAL on-chain USDC transfer for
 * the exact required amount, waits for it to be mined, then resubmits
 * with the resulting X-PAYMENT header. `privateKey` funds real gas
 * (ETH) and real USDC on Base — this moves real money.
 *
 * Pass `dryRun: true` to stop after signing (no broadcast, no funds
 * moved) — useful for testing the request/signing path against a
 * wallet that isn't funded yet, mirroring what
 * scripts/pay-x402-quote.mjs already does manually in two steps; this
 * does the whole thing in one call when dryRun is false. */
export async function rankViaX402(baseUrl, privateKey, params = {}, { dryRun = false, rpcUrl = DEFAULT_RPC_URL } = {}) {
  const challengeRes = await fetch(`${baseUrl}/v1/compute/rank`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(params),
  });
  if (challengeRes.status !== 402) {
    // Already paid via a reused receipt, or something else entirely —
    // either way there's no challenge to act on.
    return { status: challengeRes.status, body: await challengeRes.json() };
  }
  const challengeBody = await challengeRes.json();
  const challenge = challengeBody.accepts[0];
  const amountUsdc = Number(challenge.maxAmountRequired);

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const wallet = new ethers.Wallet(privateKey, provider);

  if (dryRun) {
    const messagePreview = buildPaymentAuthorizationMessage({
      nonce: challenge.nonce,
      amountUsdc,
      txHash: "<txHash once you broadcast>",
      network: "base",
    });
    return { status: 402, challenge, dryRun: true, payerAddress: wallet.address, messagePreview };
  }

  // Real, on-chain, real money. amountUsdc.toFixed(USDC_DECIMALS)
  // avoids float-precision drift landing one raw unit off from what
  // the server's own ethers.parseUnits(minAmountUsd.toFixed(6), 6)
  // computes when it verifies this transfer.
  const usdc = new ethers.Contract(BASE_USDC_CONTRACT_ADDRESS, ERC20_TRANSFER_ABI, wallet);
  const amountRaw = ethers.parseUnits(amountUsdc.toFixed(USDC_DECIMALS), USDC_DECIMALS);
  const tx = await usdc.transfer(challenge.payTo, amountRaw);
  const receipt = await tx.wait();
  const txHash = receipt.hash;

  const message = buildPaymentAuthorizationMessage({ nonce: challenge.nonce, amountUsdc, txHash, network: "base" });
  const signature = await wallet.signMessage(message);

  const submission = { scheme: "exact", network: "base", nonce: challenge.nonce, amountUsdc, payerAddress: wallet.address, txHash, signature };
  const paymentHeader = Buffer.from(JSON.stringify(submission)).toString("base64");

  const paidRes = await fetch(`${baseUrl}/v1/compute/rank`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-payment": paymentHeader },
    body: JSON.stringify(params),
  });
  return { status: paidRes.status, body: await paidRes.json(), txHash };
}

// --- CLI entrypoint ---
if (import.meta.url === `file://${process.argv[1]}`) {
  const [rail, credential, gpuClass, flag] = process.argv.slice(2);
  const baseUrl = DEFAULT_BASE_URL;
  const params = gpuClass && gpuClass !== "--dry-run" ? { gpuClass, preference: "cheapest" } : { preference: "cheapest" };

  if (rail === "bearer" && credential) {
    const result = await rankViaBearer(baseUrl, credential, params);
    console.log(JSON.stringify(result, null, 2));
  } else if (rail === "x402" && credential) {
    const dryRun = flag === "--dry-run" || gpuClass === "--dry-run";
    const result = await rankViaX402(baseUrl, credential, params, { dryRun });
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.error("Usage:");
    console.error("  node node-client.mjs bearer <apiKey> [gpuClass]");
    console.error("  node node-client.mjs x402 <privateKey> [gpuClass] [--dry-run]");
    process.exit(1);
  }
}
