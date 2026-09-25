#!/usr/bin/env python3
"""Copy-pasteable Python client for ScoutWyze Compute — dual-rail
(Bearer or x402/USDC-on-Base), targeting the flagship
POST /v1/compute/rank envelope.

Bearer rail: stdlib only (urllib), zero dependencies.
x402 rail: one dependency — pip install eth_account

2026-09-26: rewritten for the real x402 "exact" EVM scheme (EIP-3009
transferWithAuthorization). The previous version of this file had the
payer broadcast their own on-chain transfer via raw JSON-RPC calls and
prove it after the fact — a self-invented flow no standard x402 client
speaks, and a lot more code than the real scheme actually needs. The
real scheme is simpler for the payer: sign an authorization, submit
it, done. No RPC connection, no gas, no ETH needed at all — this
server's own facilitator (PayAI) broadcasts the transaction and pays
gas.

Usage as a CLI:
    python3 python_client.py bearer <apiKey> [gpuClass]
    python3 python_client.py x402 <privateKey> [gpuClass]

Usage as a library:
    from python_client import rank_via_bearer, rank_via_x402
"""

import base64
import json
import sys
import urllib.request

DEFAULT_BASE_URL = "https://scoutwyze-compute.fly.dev"

# Real EIP-3009 typed-data structure — field names/order verified
# 2026-09-26 directly against the real USDC contract's own
# TRANSFER_WITH_AUTHORIZATION_TYPEHASH() getter on Base, not copied
# from the EIP text on faith (see the server's
# src/payments/baseVerification.ts for the full verification).
EIP3009_TYPES = {
    "TransferWithAuthorization": [
        {"name": "from", "type": "address"},
        {"name": "to", "type": "address"},
        {"name": "value", "type": "uint256"},
        {"name": "validAfter", "type": "uint256"},
        {"name": "validBefore", "type": "uint256"},
        {"name": "nonce", "type": "bytes32"},
    ],
}


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


def rank_via_x402(base_url, private_key, params=None):
    """Rail 2 — x402/USDC on Base, real "exact" EVM scheme. Zero human
    involvement, ever, and zero ETH needed either: this server's
    facilitator (PayAI) broadcasts the settlement and pays gas.
    `private_key` only ever signs a message; it's never used to send a
    transaction from this client."""
    from eth_account import Account

    params = params or {}
    status, challenge_body = _http_post_json(f"{base_url}/v1/compute/rank", params)
    if status != 402:
        return {"status": status, "body": challenge_body}

    requirements = challenge_body["accepts"][0]
    account = Account.from_key(private_key)

    import time

    now = int(time.time())
    authorization = {
        "from": account.address,
        "to": requirements["payTo"],
        "value": int(requirements["maxAmountRequired"]),  # already atomic units, per the real x402 spec
        "validAfter": now - 60,
        "validBefore": now + requirements["maxTimeoutSeconds"],
        "nonce": "0x" + __import__("secrets").token_hex(32),
    }
    # Domain name/version come from the server's own advertised
    # requirements["extra"] (found live 2026-09-26: PayAI's /settle
    # rejects a signature made under an unadvertised domain with
    # invalid_exact_evm_missing_eip712_domain) — never hardcode these
    # independently of what the seller actually declared.
    domain = {
        "name": requirements["extra"]["name"],
        "version": requirements["extra"]["version"],
        "chainId": 8453,
        "verifyingContract": requirements["asset"],
    }
    typed_data = {
        "types": {
            "EIP712Domain": [
                {"name": "name", "type": "string"},
                {"name": "version", "type": "string"},
                {"name": "chainId", "type": "uint256"},
                {"name": "verifyingContract", "type": "address"},
            ],
            **EIP3009_TYPES,
        },
        "primaryType": "TransferWithAuthorization",
        "domain": domain,
        "message": authorization,
    }
    signed = Account.sign_typed_data(private_key, full_message=typed_data)
    signature = signed.signature.hex()
    if not signature.startswith("0x"):
        signature = "0x" + signature

    # Wire format: authorization fields as decimal strings, per the
    # real x402 spec's own convention (atomic units / unix seconds as
    # strings, not JSON numbers).
    wire_authorization = {
        "from": authorization["from"],
        "to": authorization["to"],
        "value": str(authorization["value"]),
        "validAfter": str(authorization["validAfter"]),
        "validBefore": str(authorization["validBefore"]),
        "nonce": authorization["nonce"],
    }
    submission = {"x402Version": 1, "scheme": "exact", "network": "base", "payload": {"signature": signature, "authorization": wire_authorization}}
    payment_header = base64.b64encode(json.dumps(submission).encode("utf-8")).decode("ascii")

    paid_status, paid_body = _http_post_json(f"{base_url}/v1/compute/rank", params, headers={"x-payment": payment_header})
    return {"status": paid_status, "body": paid_body}


if __name__ == "__main__":
    args = sys.argv[1:]
    if len(args) < 2:
        print("Usage:")
        print("  python3 python_client.py bearer <apiKey> [gpuClass]")
        print("  python3 python_client.py x402 <privateKey> [gpuClass]")
        sys.exit(1)

    rail, credential = args[0], args[1]
    gpu_class = args[2] if len(args) > 2 else None
    call_params = {"gpuClass": gpu_class, "preference": "cheapest"} if gpu_class else {"preference": "cheapest"}

    if rail == "bearer":
        result = rank_via_bearer(DEFAULT_BASE_URL, credential, call_params)
    elif rail == "x402":
        result = rank_via_x402(DEFAULT_BASE_URL, credential, call_params)
    else:
        print(f"Unknown rail: {rail}")
        sys.exit(1)

    print(json.dumps(result, indent=2))
