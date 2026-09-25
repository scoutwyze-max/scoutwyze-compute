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

## What's actually verified here, and what isn't

Real verification, not just "it imports cleanly" — done this session,
2026-09-25:

- **Bearer rail** — all three clients (Node, Python, and the LangChain
  tool wrapping Python) called the live dev server end-to-end and got
  correct, correctly-shaped, correctly-zero-charged responses.
- **x402 message construction + signing** — verified the Node client's
  signature round-trips through `ethers.verifyMessage` (the exact
  function the server uses) to the right address; verified the same
  for the Python client's `eth_account`-generated signature; then
  cross-checked that a **Python-generated signature is correctly
  recovered by the server's own Node/ethers verification function** —
  real interop proof, not an assumption that "both implement EIP-191
  correctly."
- **x402 real on-chain broadcast — NOT verified live.** No funded
  Base wallet or local test chain (Anvil/Hardhat) was available this
  session to actually send a transaction and watch the server accept
  it end-to-end. The transaction-building and signing steps were
  checked in isolation (correct `eth_account.SignedTransaction`
  attributes, correct unprefixed hex from `.raw_transaction.hex()`,
  correct ERC20 `transfer` selector verified via real keccak
  computation, correct Base chain ID verified via a live
  `eth_chainId` RPC call) — but nobody has watched a real transfer
  from these specific client files clear and get accepted by
  `/v1/compute/rank`. Treat that specific path as implemented-but-
  unconfirmed until someone runs it with real funds.

## Which rail should I use?

- Already have infrastructure/credentials to manage (an existing
  account system, secrets manager, etc.)? **Bearer** — one-time human
  signup + Stripe funding, then headless.
- A fully autonomous agent with its own wallet and no human in the
  loop at all, ever? **x402** — no signup, no key, pays per call.

See `SOT.md` §4/§5 in the repo root for the full settle-before-grant
asymmetry between the two rails before choosing.
