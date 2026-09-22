#!/usr/bin/env node
// x402 paid-quote helper. Two modes — this script never holds a
// private key and never sends funds itself; it only talks to the API.
//
// Mode 1 — get a challenge (no args):
//   node scripts/pay-x402-quote.mjs
//   node scripts/pay-x402-quote.mjs https://scoutwyze-compute.fly.dev
// Prints the nonce, the exact canonical message to sign, and expiresAt.
//
// Mode 2 — after you've independently sent the on-chain USDC transfer
// AND signed the canonical message with the SAME address, submit the
// paid request:
//   node scripts/pay-x402-quote.mjs <baseUrl> <nonce> <amountUsdc> <payerAddress> <txHash> <signature>
// Prints HTTP status + the full quote response body.

const args = process.argv.slice(2);

// Must match src/payments/baseVerification.ts's buildPaymentAuthorizationMessage
// EXACTLY — this is the canonical message the server recomputes and
// checks the signature against. Any drift here = a real signature
// recovering to the wrong address, rejected server-side.
function buildPaymentAuthorizationMessage({ nonce, amountUsdc, txHash, network }) {
  return [
    "ScoutWyze Compute Payment Authorization",
    `nonce: ${nonce}`,
    `amount: ${amountUsdc} USDC`,
    `txHash: ${txHash}`,
    `network: ${network}`,
  ].join("\n");
}

async function getChallenge(baseUrl) {
  const res = await fetch(`${baseUrl}/v1/route/quote`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ workload_type: "inference", region: "US" }),
  });
  if (res.status !== 402) {
    console.error(`Expected 402, got ${res.status}:`);
    console.error(JSON.stringify(await res.json(), null, 2));
    process.exit(1);
  }
  const challenge = (await res.json()).accepts[0];
  const amountUsdc = Number(challenge.maxAmountRequired);

  console.log(`nonce:      ${challenge.nonce}`);
  console.log(`amountUsdc: ${amountUsdc}`);
  console.log(`payTo:      ${challenge.payTo}`);
  console.log(`expiresAt:  ${challenge.expiresAt}  (you have ~2 minutes from now)`);
  console.log("\nSend this exact amount of USDC on Base to payTo, get the txHash, then");
  console.log("sign this EXACT message (multi-line, no changes) with the address that sent it:\n");
  console.log("----------------------------------------");
  console.log(buildPaymentAuthorizationMessage({ nonce: challenge.nonce, amountUsdc, txHash: "<txHash once you have it>", network: "base" }));
  console.log("----------------------------------------");
  console.log("\nThen run:");
  console.log(`  node scripts/pay-x402-quote.mjs ${baseUrl} ${challenge.nonce} ${amountUsdc} <payerAddress> <txHash> <signature>`);
}

async function submitPayment(baseUrl, nonce, amountUsdcStr, payerAddress, txHash, signature) {
  const amountUsdc = Number(amountUsdcStr);
  const submission = { scheme: "exact", network: "base", nonce, amountUsdc, payerAddress, txHash, signature };
  const paymentHeader = Buffer.from(JSON.stringify(submission)).toString("base64");

  const res = await fetch(`${baseUrl}/v1/route/quote`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-payment": paymentHeader },
    body: JSON.stringify({ workload_type: "inference", region: "US" }),
  });
  const body = await res.json();

  console.log(`HTTP ${res.status}`);
  console.log(JSON.stringify(body, null, 2));
  process.exit(res.status === 200 ? 0 : 1);
}

if (args.length <= 1) {
  const baseUrl = args[0] ?? "http://localhost:8787";
  await getChallenge(baseUrl);
} else if (args.length === 6) {
  const [baseUrl, nonce, amountUsdc, payerAddress, txHash, signature] = args;
  await submitPayment(baseUrl, nonce, amountUsdc, payerAddress, txHash, signature);
} else {
  console.error("Usage:");
  console.error("  node scripts/pay-x402-quote.mjs [baseUrl]                                          # get a challenge");
  console.error("  node scripts/pay-x402-quote.mjs <baseUrl> <nonce> <amountUsdc> <payerAddress> <txHash> <signature>  # submit payment");
  process.exit(1);
}
