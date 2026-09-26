# Integration examples

Copy-pasteable clients for autonomous agents and MLOps pipelines
calling `POST /v1/compute/rank` directly — no MCP host required (see
`mcp-server/` for that path instead). Each one supports both rails:
prepaid Bearer key, or x402/USDC-on-Base with zero signup.

- **`node-client.mjs`** — Node.js, `npm install ethers`.
- **`python_client.py`** — Python, stdlib-only for the Bearer rail,
  `pip install eth_account` for x402.
- **`langchain_tool.py`** — wraps `python_client.py` as a LangChain
  `StructuredTool` (`pip install langchain-core eth_account`), for
  dropping into an existing LangChain agent's toolset.
- **`haystack_tool.py`** — wraps `python_client.py` as a Haystack
  `Tool` (`pip install haystack-ai eth_account`), for dropping into an
  existing Haystack Agent's toolset.

## The x402 rail is the real "exact" EVM scheme (2026-09-26)

An earlier version of these clients had the payer broadcast their own
on-chain USDC transfer and prove it after the fact — a real, working,
but non-spec-compliant flow that no standard x402 client library
speaks. As of 2026-09-26 this is the real scheme (EIP-3009
`TransferWithAuthorization`, EIP-712 typed-data signature): the payer
only ever **signs a message**. No RPC connection, no ETH for gas, no
on-chain broadcast from the client at all — this server's own
facilitator (PayAI) broadcasts the settlement and pays gas.

## What's actually verified here, and what isn't

Real verification, not just "it imports cleanly":

- **Bearer rail** — all four clients called the live dev server
  end-to-end and got correct, correctly-shaped, correctly-zero-charged
  responses.
- **`haystack_tool.py` specifically** — invoked as a real Haystack
  `Tool.invoke()` call (not just imported) against live production:
  once with a bad key (got the real 402 challenge back, proving the
  unrecognized-key-falls-through-to-x402 path plumbs through
  correctly), once with a real signed-up + admin-credited key (got a
  real 200 with the full ranked envelope) — 2026-09-26.
- **EIP-3009 domain and typehash** — independently confirmed against
  real on-chain calls to the USDC contract on Base (`name()`,
  `version()`, `DOMAIN_SEPARATOR()`, `TRANSFER_WITH_AUTHORIZATION_TYPEHASH()`),
  not copied from the EIP text on faith.
- **Full pipeline, both languages, against the real production
  dependency (PayAI's live facilitator, not a mock)** — both
  `node-client.mjs` and `python_client.py` were run against this
  server's real `/settle` call to `facilitator.payai.network`. First
  attempt surfaced a real, undocumented requirement
  (`invalid_exact_evm_missing_eip712_domain` — PayAI needs the token's
  EIP-712 domain name/version explicitly advertised in the payment
  requirements' `extra` field, not just inferred); after fixing that
  server-side, both clients got back `invalid_exact_evm_insufficient_balance`
  for an unfunded test wallet — confirming the entire chain (signature
  construction, requirements shape, PayAI request/response parsing,
  error-code mapping) works correctly end to end.
- **Real on-chain broadcast with actual funds** — see `SOT.md` §4 for
  whether this has been run to full completion; check there rather
  than trusting a claim in this file, since it can go stale.

## Which rail should I use?

- Already have infrastructure/credentials to manage (an existing
  account system, secrets manager, etc.)? **Bearer** — one-time human
  signup + Stripe funding, then headless.
- A fully autonomous agent with its own wallet and no human in the
  loop at all, ever? **x402** — no signup, no key, no ETH needed, pays
  per call.

See `SOT.md` §4/§5 in the repo root for the full settle-before-grant
asymmetry between the two rails before choosing.
