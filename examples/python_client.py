#!/usr/bin/env python3
"""Copy-pasteable Python client for ScoutWyze Compute — dual-rail
(Bearer or x402/USDC-on-Base), targeting the flagship
POST /v1/compute/rank envelope.

Bearer rail: stdlib only (urllib), zero dependencies.
x402 rail: one dependency for signing/broadcasting —
    pip install eth_account
(deliberately not the full web3.py stack; this hand-rolls the couple
of JSON-RPC calls a real transfer needs via stdlib urllib instead,
consistent with "lightweight" — eth_account alone is ~0 transitive
weight beyond eth-utils/rlp).

Usage as a CLI:
    python3 python_client.py bearer <apiKey> [gpuClass]
    python3 python_client.py x402 <privateKey> [gpuClass]            # signs AND broadcasts a real on-chain transfer
    python3 python_client.py x402 <privateKey> [gpuClass] --dry-run  # stop after signing, don't broadcast

Usage as a library:
    from python_client import rank_via_bearer, rank_via_x402
"""

import json
import sys
import time
import urllib.request

DEFAULT_BASE_URL = "https://scoutwyze-compute.fly.dev"
DEFAULT_RPC_URL = "https://mainnet.base.org"

# Real Base USDC contract — Circle-issued, NOT the bridged USDbC token
# at a different address. Must match
# src/payments/baseVerification.ts's BASE_USDC_CONTRACT_ADDRESS and
# node-client.mjs's copy of the same constant exactly.
BASE_USDC_CONTRACT_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
USDC_DECIMALS = 6
BASE_CHAIN_ID = 8453  # verified live via eth_chainId against mainnet.base.org, not assumed
# keccak256("transfer(address,uint256)")[:4] — verified via eth_utils.keccak, not recalled from memory.
ERC20_TRANSFER_SELECTOR = "a9059cbb"


def _build_payment_authorization_message(nonce, amount_usdc, tx_hash, network):
    """Must match src/payments/baseVerification.ts's
    buildPaymentAuthorizationMessage on the server EXACTLY, and
    node-client.mjs's copy of the same function — this is the
    canonical message the server recomputes and checks the signature
    against. Any drift here means a real signature that recovers to
    the wrong address, rejected server-side with code
    invalid_exact_evm_payload_signature."""
    return "\n".join(
        [
            "ScoutWyze Compute Payment Authorization",
            f"nonce: {nonce}",
            f"amount: {amount_usdc} USDC",
            f"txHash: {tx_hash}",
            f"network: {network}",
        ]
    )


def _http_post_json(url, body, headers=None):
    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(url, data=data, method="POST", headers={"content-type": "application/json", **(headers or {})})
    try:
        with urllib.request.urlopen(req) as res:
            return res.status, json.loads(res.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read())


def rank_via_bearer(base_url, api_key, params=None):
    """Rail 1 — prepaid Bearer key. A human funds the account once
    (POST /v1/signup + POST /v1/checkout-sessions); from then on this
    is a single call with zero further human involvement."""
    status, body = _http_post_json(f"{base_url}/v1/compute/rank", params or {}, headers={"authorization": f"Bearer {api_key}"})
    return {"status": status, "body": body}


def _rpc_call(rpc_url, method, params):
    status, body = _http_post_json(rpc_url, {"jsonrpc": "2.0", "method": method, "params": params, "id": 1})
    if "error" in body:
        raise RuntimeError(f"RPC error calling {method}: {body['error']}")
    return body["result"]


def rank_via_x402(base_url, private_key, params=None, dry_run=False, rpc_url=DEFAULT_RPC_URL):
    """Rail 2 — x402/USDC on Base. Zero human involvement, ever: gets
    the real 402 challenge, signs the canonical authorization message,
    broadcasts a REAL on-chain USDC transfer for the exact required
    amount, waits for it to be mined, then resubmits with the
    resulting X-PAYMENT header. `private_key` funds real gas (ETH) and
    real USDC on Base — this moves real money.

    Pass dry_run=True to stop after signing (no broadcast, no funds
    moved)."""
    from eth_account import Account
    from eth_account.messages import encode_defunct

    params = params or {}
    status, challenge_body = _http_post_json(f"{base_url}/v1/compute/rank", params)
    if status != 402:
        return {"status": status, "body": challenge_body}

    challenge = challenge_body["accepts"][0]
    amount_usdc = float(challenge["maxAmountRequired"])
    account = Account.from_key(private_key)

    if dry_run:
        message_preview = _build_payment_authorization_message(challenge["nonce"], amount_usdc, "<txHash once you broadcast>", "base")
        return {"status": 402, "challenge": challenge, "dryRun": True, "payerAddress": account.address, "messagePreview": message_preview}

    # Real, on-chain, real money — build and broadcast a real ERC20
    # transfer(payTo, amountRaw) call.
    amount_raw = round(amount_usdc * (10**USDC_DECIMALS))
    to_padded = challenge["payTo"][2:].lower().rjust(64, "0")
    amount_padded = format(amount_raw, "x").rjust(64, "0")
    call_data = "0x" + ERC20_TRANSFER_SELECTOR + to_padded + amount_padded

    nonce = int(_rpc_call(rpc_url, "eth_getTransactionCount", [account.address, "pending"]), 16)
    gas_price = int(_rpc_call(rpc_url, "eth_gasPrice", []), 16)
    tx = {
        "nonce": nonce,
        "gasPrice": gas_price,
        "gas": 100_000,  # comfortably above a plain ERC20 transfer's real ~50-65k cost
        "to": BASE_USDC_CONTRACT_ADDRESS,
        "value": 0,
        "data": call_data,
        "chainId": BASE_CHAIN_ID,
    }
    signed_tx = Account.sign_transaction(tx, private_key)
    tx_hash = _rpc_call(rpc_url, "eth_sendRawTransaction", ["0x" + signed_tx.raw_transaction.hex()])

    # Poll for the receipt — a real transfer needs to actually be
    # mined before the server's own chain read will find it.
    receipt = None
    for _ in range(60):
        receipt = _rpc_call(rpc_url, "eth_getTransactionReceipt", [tx_hash])
        if receipt is not None:
            break
        time.sleep(2)
    if receipt is None:
        raise RuntimeError(f"Transaction {tx_hash} was not mined within the polling window — check it manually on BaseScan.")

    message = _build_payment_authorization_message(challenge["nonce"], amount_usdc, tx_hash, "base")
    signature = Account.sign_message(encode_defunct(text=message), private_key=private_key).signature.hex()
    if not signature.startswith("0x"):
        signature = "0x" + signature

    submission = {
        "scheme": "exact",
        "network": "base",
        "nonce": challenge["nonce"],
        "amountUsdc": amount_usdc,
        "payerAddress": account.address,
        "txHash": tx_hash,
        "signature": signature,
    }
    import base64

    payment_header = base64.b64encode(json.dumps(submission).encode("utf-8")).decode("ascii")
    paid_status, paid_body = _http_post_json(f"{base_url}/v1/compute/rank", params, headers={"x-payment": payment_header})
    return {"status": paid_status, "body": paid_body, "txHash": tx_hash}


if __name__ == "__main__":
    args = sys.argv[1:]
    if len(args) < 2:
        print("Usage:")
        print("  python3 python_client.py bearer <apiKey> [gpuClass]")
        print("  python3 python_client.py x402 <privateKey> [gpuClass] [--dry-run]")
        sys.exit(1)

    rail, credential = args[0], args[1]
    rest = args[2:]
    dry_run = "--dry-run" in rest
    gpu_class = next((a for a in rest if a != "--dry-run"), None)
    call_params = {"gpuClass": gpu_class, "preference": "cheapest"} if gpu_class else {"preference": "cheapest"}

    if rail == "bearer":
        result = rank_via_bearer(DEFAULT_BASE_URL, credential, call_params)
    elif rail == "x402":
        result = rank_via_x402(DEFAULT_BASE_URL, credential, call_params, dry_run=dry_run)
    else:
        print(f"Unknown rail: {rail}")
        sys.exit(1)

    print(json.dumps(result, indent=2))
