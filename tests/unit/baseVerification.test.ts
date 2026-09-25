import { describe, expect, it } from "vitest";
import {
  recoverEip3009Signer,
  checkEip3009AuthorizationBounds,
  verifyOnChainUsdcTransfer,
  BASE_USDC_CONTRACT_ADDRESS,
} from "../../src/payments/baseVerification.js";
import { createTestPayerWallet, buildEip3009Authorization, signEip3009Authorization } from "../helpers/x402TestHelpers.js";
import { encodeUsdcTransferLog, fakeSuccessfulReceipt, fakeFailedReceipt } from "../helpers/fakeUsdcTransfer.js";
import { FakeChainReader } from "../helpers/fakeChainReader.js";

const TREASURY = "0xc132a315a05541a4b72c272de539eb86de977fb9";

describe("recoverEip3009Signer — real EIP-712 typed-data signature recovery", () => {
  it("recovers the exact address that signed the authorization", async () => {
    const wallet = createTestPayerWallet();
    const authorization = buildEip3009Authorization({ from: wallet.address, to: TREASURY, amountUsdc: 0.15 });
    const signature = await signEip3009Authorization(wallet, authorization);

    const result = recoverEip3009Signer(authorization, signature);
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.address.toLowerCase()).toBe(wallet.address.toLowerCase());
  });

  it("a signature over a DIFFERENT authorization (e.g. tampered value) does not recover to the original signer", async () => {
    const wallet = createTestPayerWallet();
    const signedAuthorization = buildEip3009Authorization({ from: wallet.address, to: TREASURY, amountUsdc: 0.15 });
    const signature = await signEip3009Authorization(wallet, signedAuthorization);

    const tampered = { ...signedAuthorization, value: "999000000" };
    const result = recoverEip3009Signer(tampered, signature);
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.address.toLowerCase()).not.toBe(wallet.address.toLowerCase());
  });

  it("rejects a malformed signature rather than throwing", () => {
    const authorization = buildEip3009Authorization({ from: TREASURY, to: TREASURY, amountUsdc: 0.15 });
    const result = recoverEip3009Signer(authorization, "not-a-real-signature");
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toMatch(/EIP-3009 signature recovery failed/);
      expect(result.code).toBe("invalid_exact_evm_payload_signature");
    }
  });

  it("real Base USDC contract address is checksummed and matches Circle's published address, not the bridged USDbC token", () => {
    expect(BASE_USDC_CONTRACT_ADDRESS).toBe("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
  });
});

describe("checkEip3009AuthorizationBounds — recipient/amount/time-window checks, no network", () => {
  const NOW = Math.floor(Date.now() / 1000);

  it("accepts a well-formed authorization within bounds", () => {
    const authorization = buildEip3009Authorization({ from: "0x0000000000000000000000000000000000dEaD", to: TREASURY, amountUsdc: 0.15, nowSeconds: NOW });
    const result = checkEip3009AuthorizationBounds(authorization, TREASURY, 0.15, NOW);
    expect(result.valid).toBe(true);
  });

  it("accepts an authorization for MORE than the minimum required (overpayment is fine)", () => {
    const authorization = buildEip3009Authorization({ from: "0x0000000000000000000000000000000000dEaD", to: TREASURY, amountUsdc: 1.0, nowSeconds: NOW });
    const result = checkEip3009AuthorizationBounds(authorization, TREASURY, 0.15, NOW);
    expect(result.valid).toBe(true);
  });

  it("rejects an authorization for LESS than the required amount", () => {
    const authorization = buildEip3009Authorization({ from: "0x0000000000000000000000000000000000dEaD", to: TREASURY, amountUsdc: 0.05, nowSeconds: NOW });
    const result = checkEip3009AuthorizationBounds(authorization, TREASURY, 0.15, NOW);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.code).toBe("invalid_exact_evm_payload_authorization_value_mismatch");
  });

  it("rejects an authorization made out to the WRONG recipient (not our treasury)", () => {
    const someoneElse = createTestPayerWallet().address;
    const authorization = buildEip3009Authorization({ from: "0x0000000000000000000000000000000000dEaD", to: someoneElse, amountUsdc: 0.15, nowSeconds: NOW });
    const result = checkEip3009AuthorizationBounds(authorization, TREASURY, 0.15, NOW);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.code).toBe("invalid_exact_evm_payload_recipient_mismatch");
  });

  it("rejects an authorization that isn't valid yet (validAfter in the future)", () => {
    const authorization = buildEip3009Authorization({
      from: "0x0000000000000000000000000000000000dEaD",
      to: TREASURY,
      amountUsdc: 0.15,
      nowSeconds: NOW,
      validAfterOffsetSeconds: 3600, // starts valid an hour from now
    });
    const result = checkEip3009AuthorizationBounds(authorization, TREASURY, 0.15, NOW);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.code).toBe("invalid_exact_evm_payload_authorization_valid_after");
  });

  it("rejects an authorization that has already expired (validBefore has passed)", () => {
    const authorization = buildEip3009Authorization({
      from: "0x0000000000000000000000000000000000dEaD",
      to: TREASURY,
      amountUsdc: 0.15,
      nowSeconds: NOW,
      validAfterOffsetSeconds: -3600,
      validBeforeOffsetSeconds: -1800, // expired 30 minutes ago
    });
    const result = checkEip3009AuthorizationBounds(authorization, TREASURY, 0.15, NOW);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.code).toBe("invalid_exact_evm_payload_authorization_valid_before");
  });
});

describe("verifyOnChainUsdcTransfer — real RPC-shaped receipt verification (unchanged by the 2026-09-26 EIP-3009 rewrite)", () => {
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
    if (!result.valid) {
      expect(result.reason).toMatch(/no matching USDC Transfer/);
      expect(result.code).toBe("invalid_payload");
    }
  });

  it("rejects a transaction that was never mined / unknown hash", async () => {
    const reader = new FakeChainReader(); // no receipt configured
    const result = await verifyOnChainUsdcTransfer(reader, "0xneverexisted", "0x0000000000000000000000000000000000dEaD", TREASURY, 0.15);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toMatch(/not found/);
      expect(result.code).toBe("invalid_transaction_state");
    }
  });

  it("rejects a failed/reverted transaction even if it contains a matching-looking log", async () => {
    const reader = new FakeChainReader();
    const from = createTestPayerWallet().address;
    reader.setReceipt("0xtx1", fakeFailedReceipt([encodeUsdcTransferLog(from, TREASURY, 0.15)]));

    const result = await verifyOnChainUsdcTransfer(reader, "0xtx1", from, TREASURY, 0.15);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toMatch(/failed\/reverted/);
      expect(result.code).toBe("invalid_transaction_state");
    }
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
    if (!result.valid) {
      expect(result.reason).toMatch(/RPC error/);
      expect(result.code).toBe("unexpected_verify_error");
    }
  });
});
