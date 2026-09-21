import { describe, expect, it } from "vitest";
import {
  buildPaymentAuthorizationMessage,
  recoverPayerAddress,
  verifyOnChainUsdcTransfer,
  BASE_USDC_CONTRACT_ADDRESS,
} from "../../src/payments/baseVerification.js";
import { createTestPayerWallet, signPaymentAuthorization } from "../helpers/x402TestHelpers.js";
import { encodeUsdcTransferLog, fakeSuccessfulReceipt, fakeFailedReceipt } from "../helpers/fakeUsdcTransfer.js";
import { FakeChainReader } from "../helpers/fakeChainReader.js";

const TREASURY = "0xc132a315a05541a4b72c272de539eb86de977fb9";

describe("recoverPayerAddress — real EIP-191 signature recovery", () => {
  it("recovers the exact address that signed the message", async () => {
    const wallet = createTestPayerWallet();
    const message = buildPaymentAuthorizationMessage({ nonce: "n1", amountUsdc: 0.15, txHash: "0xabc", network: "base" });
    const signature = await wallet.signMessage(message);

    const result = recoverPayerAddress(message, signature);
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.address.toLowerCase()).toBe(wallet.address.toLowerCase());
  });

  it("a signature from a DIFFERENT wallet does not recover to the expected address", async () => {
    const signer = createTestPayerWallet();
    const impersonated = createTestPayerWallet();
    const message = buildPaymentAuthorizationMessage({ nonce: "n1", amountUsdc: 0.15, txHash: "0xabc", network: "base" });
    const signature = await signer.signMessage(message);

    const result = recoverPayerAddress(message, signature);
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.address.toLowerCase()).not.toBe(impersonated.address.toLowerCase());
  });

  it("a signature over a DIFFERENT message (e.g. wrong amount) does not recover to the signer for the original message", async () => {
    const wallet = createTestPayerWallet();
    const signedMessage = buildPaymentAuthorizationMessage({ nonce: "n1", amountUsdc: 0.15, txHash: "0xabc", network: "base" });
    const signature = await wallet.signMessage(signedMessage);

    const tamperedMessage = buildPaymentAuthorizationMessage({ nonce: "n1", amountUsdc: 999, txHash: "0xabc", network: "base" });
    const result = recoverPayerAddress(tamperedMessage, signature);
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.address.toLowerCase()).not.toBe(wallet.address.toLowerCase());
  });

  it("rejects a malformed signature rather than throwing", () => {
    const result = recoverPayerAddress("some message", "not-a-real-signature");
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toMatch(/signature recovery failed/);
  });
});

describe("verifyOnChainUsdcTransfer — real RPC-shaped receipt verification", () => {
  it("accepts a genuine USDC Transfer log matching from/to/amount", async () => {
    const reader = new FakeChainReader();
    const from = createTestPayerWallet().address;
    reader.setReceipt("0xtx1", fakeSuccessfulReceipt([encodeUsdcTransferLog(from, TREASURY, 0.15)]));

    const result = await verifyOnChainUsdcTransfer(reader, "0xtx1", from, TREASURY, 0.15);
    expect(result).toEqual({ valid: true });
  });

  it("accepts a transfer for MORE than the minimum required (overpayment is fine)", async () => {
    const reader = new FakeChainReader();
    const from = createTestPayerWallet().address;
    reader.setReceipt("0xtx1", fakeSuccessfulReceipt([encodeUsdcTransferLog(from, TREASURY, 1.0)]));

    const result = await verifyOnChainUsdcTransfer(reader, "0xtx1", from, TREASURY, 0.15);
    expect(result.valid).toBe(true);
  });

  it("rejects a transfer for LESS than the required amount", async () => {
    const reader = new FakeChainReader();
    const from = createTestPayerWallet().address;
    reader.setReceipt("0xtx1", fakeSuccessfulReceipt([encodeUsdcTransferLog(from, TREASURY, 0.05)]));

    const result = await verifyOnChainUsdcTransfer(reader, "0xtx1", from, TREASURY, 0.15);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toMatch(/no matching USDC Transfer/);
  });

  it("rejects a transaction that was never mined / unknown hash", async () => {
    const reader = new FakeChainReader(); // no receipt configured
    const result = await verifyOnChainUsdcTransfer(reader, "0xneverexisted", "0x0000000000000000000000000000000000dEaD", TREASURY, 0.15);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toMatch(/not found/);
  });

  it("rejects a failed/reverted transaction even if it contains a matching-looking log", async () => {
    const reader = new FakeChainReader();
    const from = createTestPayerWallet().address;
    reader.setReceipt("0xtx1", fakeFailedReceipt([encodeUsdcTransferLog(from, TREASURY, 0.15)]));

    const result = await verifyOnChainUsdcTransfer(reader, "0xtx1", from, TREASURY, 0.15);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toMatch(/failed\/reverted/);
  });

  it("rejects a transfer sent to the WRONG recipient (not our treasury)", async () => {
    const reader = new FakeChainReader();
    const from = createTestPayerWallet().address;
    const someoneElse = createTestPayerWallet().address;
    reader.setReceipt("0xtx1", fakeSuccessfulReceipt([encodeUsdcTransferLog(from, someoneElse, 0.15)]));

    const result = await verifyOnChainUsdcTransfer(reader, "0xtx1", from, TREASURY, 0.15);
    expect(result.valid).toBe(false);
  });

  it("rejects a transfer sent FROM a different address than claimed", async () => {
    const reader = new FakeChainReader();
    const actualSender = createTestPayerWallet().address;
    const claimedSender = createTestPayerWallet().address;
    reader.setReceipt("0xtx1", fakeSuccessfulReceipt([encodeUsdcTransferLog(actualSender, TREASURY, 0.15)]));

    const result = await verifyOnChainUsdcTransfer(reader, "0xtx1", claimedSender, TREASURY, 0.15);
    expect(result.valid).toBe(false);
  });

  it("rejects a genuine transfer of the WRONG token (not real USDC) — a log on some other contract must not count", async () => {
    const reader = new FakeChainReader();
    const from = createTestPayerWallet().address;
    const notUsdc = "0x1111111111111111111111111111111111aaaa";
    reader.setReceipt("0xtx1", fakeSuccessfulReceipt([encodeUsdcTransferLog(from, TREASURY, 0.15, notUsdc)]));

    const result = await verifyOnChainUsdcTransfer(reader, "0xtx1", from, TREASURY, 0.15);
    expect(result.valid).toBe(false);
  });

  it("fails closed on an RPC error rather than treating it as verified", async () => {
    const reader = new FakeChainReader();
    reader.setError("0xtx1", new Error("connection reset"));

    const result = await verifyOnChainUsdcTransfer(reader, "0xtx1", "0x0000000000000000000000000000000000dEaD", TREASURY, 0.15);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toMatch(/RPC error/);
  });

  it("real Base USDC contract address is checksummed and matches Circle's published address, not the bridged USDbC token", () => {
    // Locks the exact address this module verifies against — a typo'd
    // or bridged-token address here would mean "verifying" transfers
    // of a token nobody is actually required to pay in.
    expect(BASE_USDC_CONTRACT_ADDRESS).toBe("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
  });
});

describe("buildPaymentAuthorizationMessage + signPaymentAuthorization helper — end-to-end sanity", () => {
  it("the same params always produce the same canonical message", () => {
    const a = buildPaymentAuthorizationMessage({ nonce: "n1", amountUsdc: 0.15, txHash: "0xabc", network: "base" });
    const b = buildPaymentAuthorizationMessage({ nonce: "n1", amountUsdc: 0.15, txHash: "0xabc", network: "base" });
    expect(a).toBe(b);
  });

  it("changing any single field changes the message", () => {
    const base = buildPaymentAuthorizationMessage({ nonce: "n1", amountUsdc: 0.15, txHash: "0xabc", network: "base" });
    const diffNonce = buildPaymentAuthorizationMessage({ nonce: "n2", amountUsdc: 0.15, txHash: "0xabc", network: "base" });
    const diffAmount = buildPaymentAuthorizationMessage({ nonce: "n1", amountUsdc: 0.2, txHash: "0xabc", network: "base" });
    const diffTx = buildPaymentAuthorizationMessage({ nonce: "n1", amountUsdc: 0.15, txHash: "0xdef", network: "base" });
    expect(diffNonce).not.toBe(base);
    expect(diffAmount).not.toBe(base);
    expect(diffTx).not.toBe(base);
  });

  it("signPaymentAuthorization + recoverPayerAddress round-trip end to end", async () => {
    const wallet = createTestPayerWallet();
    const signature = await signPaymentAuthorization(wallet, { nonce: "n1", amountUsdc: 0.15, txHash: "0xabc" });
    const message = buildPaymentAuthorizationMessage({ nonce: "n1", amountUsdc: 0.15, txHash: "0xabc", network: "base" });

    const result = recoverPayerAddress(message, signature);
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.address.toLowerCase()).toBe(wallet.address.toLowerCase());
  });
});
