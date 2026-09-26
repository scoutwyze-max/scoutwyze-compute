# scoutwyze-compute

Client + LangChain/Haystack Tool wrappers for [ScoutWyze
Compute](https://scoutwyze-compute.fly.dev) — a machine-readable GPU
placement recommendation API for AI infrastructure agents and MLOps
pipelines. Ranks live 8x H100 80GB (RunPod-backed) offers by price and
data freshness; strictly separates what a provider reported from what
ScoutWyze calculated. This is a routing/recommendation layer, not an
execution platform — it never reserves, provisions, or runs anything.

Dual-rail, both real:

- **Bearer** — a prepaid API key, billed per successful match (a
  `no_match` result is never charged). Get one free with
  `POST /v1/signup`, fund it with `POST /v1/checkout-sessions` (real
  Stripe Checkout).
- **x402** — pay per call in USDC on [Base](https://base.org), no
  signup, no API key, no ETH for gas. Uses the real x402 "exact" EVM
  scheme (EIP-3009 `TransferWithAuthorization`): you only ever sign a
  message, this server's own facilitator broadcasts the settlement.

## Install

```bash
pip install scoutwyze-compute                 # Bearer rail only, zero extra deps
pip install "scoutwyze-compute[x402]"          # + x402/USDC-on-Base rail
pip install "scoutwyze-compute[langchain]"     # + LangChain Tool wrapper
pip install "scoutwyze-compute[haystack]"      # + Haystack Tool wrapper
pip install "scoutwyze-compute[all]"           # everything
```

## Usage

### Plain client

```python
from scoutwyze_compute import rank_via_bearer, rank_via_x402

result = rank_via_bearer("https://scoutwyze-compute.fly.dev", "sw_live_...", {"gpuClass": "H100"})
print(result["body"]["recommended"])
```

### LangChain

```python
from scoutwyze_compute.langchain_tool import make_bearer_tool

tool = make_bearer_tool(api_key="sw_live_...")
```

### Haystack

```python
from scoutwyze_compute.haystack_tool import make_bearer_tool

tool = make_bearer_tool(api_key="sw_live_...")
offers = tool.invoke(gpuClass="H100")
```

See the [main repo](https://github.com/scoutwyze-max/scoutwyze-compute)
for full API docs, `llms.txt`, and `openapi.json`.

## License

MIT
