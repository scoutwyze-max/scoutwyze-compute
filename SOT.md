# ScoutWyze Compute — System Source of Truth (SOT)
**Scope:** Compute venture only — Real Estate is a separate codebase I have no visibility into and make no claims about.
**Status:** Compute-side claims below were independently tested against the live production code and API on 2026-09-23/24, not taken from prior documentation. Where something is unverified or roadmap-only, it's labeled as such, not folded into "verified." Updated 2026-09-24: x402 extended onto `compute/rank` (see §4/§5 — this was the single biggest inaccuracy in the previous version of this document).
**Live:** https://scoutwyze-compute.fly.dev

## 1. What it is
A metered, machine-readable API that ranks current RunPod GPU offers by price and freshness. It is a quote/ranking service — it does not reserve, provision, or start any machine. Booking exists in code (`POST /v1/route/book`) but is intentionally unpublished (undocumented in `llms.txt`/OpenAPI/landing page) because it has not had a successful end-to-end live booking yet.

**Scope note (real discrepancy, not swept under the rug):** the project's own original spec (`CLAUDE.md`) restricts V1 to "8× H100 80GB, US-based regions." The deployed `rank`/`sample` endpoints do not enforce this — they serve RunPod's full live catalog (any GPU model, any GPU count, any region including EU/AP) unless a caller explicitly filters. This is current, verified behavior, and it's broader than the documented V1 scope. Worth a deliberate decision — either update the scope doc or add the restriction to the code — rather than leaving the two silently disagreeing.

## 2. Endpoints (verified live, 2026-09-23/24)

| Endpoint | Auth | Billed | Response shape |
|---|---|---|---|
| `GET /v1/compute/sample` (alias `/v1/route/sample`) | none | no | Frozen envelope (§3) |
| `POST /v1/compute/rank` (alias `/v1/route/rank`) | Bearer **or** x402/USDC-on-Base (since 2026-09-24) | $0.15 — Bearer debits only on a real match; x402 settles on payment, before scoring (see §5) | Frozen envelope (§3) |
| `POST /v1/route/quote` | Bearer **or** x402/USDC-on-Base | $0.15, debited on successful auth | Separate, older schema (§4) — **not** the frozen envelope |
| `POST /v1/route/book` | Bearer only | Vendor cost + 15% margin, debited only after RunPod accepts | Separate shape; deployed but unpublished |

`rank`/`sample` restrict results to RunPod only, by deliberate production policy — Lambda Labs and CoreWeave rows exist in the ingestion layer as fixture/comparison data but can never appear as a recommendation or alternative.

## 3. The frozen envelope — exact shape, not paraphrased

Applies to `compute/rank` and `compute/sample` only, not to `route/quote` or `route/book`.

```json
{
  "status": "ok | no_match | no_inventory",
  "schema_version": "1.0",
  "coverage": { "vertical": "gpu_compute", "providers_live": ["runpod"] },
  "recommended": { /* one offer, shape below */ },
  "alternatives": [ /* zero or more offers, same shape */ ],
  "limits": { "not_reserved": true, "not_provisioned": true, "can_provision": false },
  "billing": { "billable": true, "unit": "successful_rank", "price_usd": 0.15, "rail": "bearer", "creditsRemaining": 9.85 }
}
```
`billing.rail` (added 2026-09-24) is `"bearer"` or `"x402"` — see §5 for why the two are not interchangeable. `creditsRemaining` only appears on the Bearer rail (x402 has no ledger balance to report).
Each offer inside `recommended`/`alternatives`:
```json
{
  "provider": "runpod", "sku": "...", "region": "...", "vendorHourly": 0, "vramGb": 0, "gpuCount": 0,
  "observed_at": "...", "freshness_seconds": 0, "source": "live_api | fixture",
  "availability_status": "low | medium | high | none | null",
  "classification": "provider_reported",
  "score": 0, "scoreBreakdown": { "priceScore": 0, "freshnessScore": 0, "weights": {"price": 0.8, "freshness": 0.2}, "ageMinutes": 0 },
  "reason": "..."
}
```
`classification: "provider_reported"` tags everything above `score` as the provider's own claim, untouched; `score`/`scoreBreakdown`/`reason` are ScoutWyze's own computation over those claims. `billing` on `no_match`/`no_inventory` omits `creditsRemaining` (nothing was charged); `sample`'s `billing.billable` is always `false` and carries a `note` instead of a price.

`limits` is a static, literal constant on every response from these two endpoints — not derived from any request or cache state. It is a machine-checkable assertion, not a claim in prose.

## 4. Payment — what's actually funded and by whom

There are no spend policies, per-agent caps, hourly limits, or endpoint allowlists anywhere in the code. Grepped for this explicitly — it doesn't exist. What exists:

**Rail 1 — Prepaid Bearer key (works on `compute/rank`, `route/quote`).** A human funds a flat USD balance once via real Stripe Checkout ($10/$50/$200 packs, live mode, verified this session). From then on, an agent calls the API with that key with zero human involvement per call — but it's a flat balance getting debited $0.15 at a time until it hits zero, not a policy engine. When it hits zero, the human has to fund it again; nothing auto-refills.

**Rail 2 — x402 / USDC on Base (works on `compute/rank` AND `route/quote`), real "exact" EVM scheme as of 2026-09-26.** An unauthenticated request, or one with an unrecognized/revoked Bearer key, gets a real HTTP 402 with real PaymentRequirements (`scheme`, `network`, `payTo`, `asset` — the real USDC contract address, not the string `"USDC"` this codebase sent before this pass — `maxAmountRequired` in atomic units, `maxTimeoutSeconds`, `extra: {name, version}` — the token's EIP-712 domain). The payer signs an EIP-3009 `TransferWithAuthorization` (EIP-712 typed data) and never broadcasts anything themselves; this server verifies the signature and bounds itself (`baseVerification.ts`'s `recoverEip3009Signer`/`checkEip3009AuthorizationBounds`, domain independently confirmed against a live on-chain call to the real USDC contract's own `DOMAIN_SEPARATOR()`/`TRANSFER_WITH_AUTHORIZATION_TYPEHASH()`), then settles via PayAI's facilitator (`payments/payAiFacilitator.ts`, genuinely permissionless for this volume — no API key, no KYB), then independently re-verifies the resulting settlement on-chain itself (`verifyOnChainUsdcTransfer`, unchanged) rather than trusting PayAI's success claim alone. **This replaces the previous session's self-invented flow** (payer broadcasts their own transfer, proves it after the fact with a custom EIP-191 message) — that flow, while internally consistent and tested, was not spec-compliant: a real x402 client using standard tooling could never have paid this server, because it would construct a signed EIP-3009 authorization and this server would have rejected it as malformed. **A second real compliance bug found in the same pass:** `maxAmountRequired` was sent as a human-decimal string (`"0.15"`) instead of atomic units (`"150000"`) — also fixed. **Verified live 2026-09-26, real production dependency, not a mock:** both `examples/node-client.mjs` and `examples/python_client.py` were run against this server's real `/settle` call to `facilitator.payai.network` and got back real, informative PayAI errors (`invalid_exact_evm_missing_eip712_domain`, then after fixing that, `invalid_exact_evm_insufficient_balance` for an unfunded wallet) — confirming the full pipeline (signature, requirements shape, PayAI request/response parsing, error-code mapping) works end to end. A funded real-money settlement was separately run to completion — see this file's git history/commit log for that transaction's hash rather than trusting a claim here that could go stale.

**Machine-parseable failure codes.** A rejected payment attempt (bad signature, expired/already-settled authorization, insufficient amount, insufficient balance, recipient mismatch) carries a `code` field alongside the existing free-text `reason` — real x402/PayAI error vocabulary, verified against both `coinbase/x402/specs/x402-specification-v2.md` §9 AND PayAI's own live OpenAPI description (`payai.network/openapi.json`) AND two codes actually observed live from PayAI's real `/settle` responses that weren't documented in either schema (`invalid_exact_evm_missing_eip712_domain`, `invalid_exact_evm_insufficient_balance` — PayAI's own docs explicitly say "handle unknown values," and this is exactly that case). Unrecognized codes fall back to `unexpected_verify_error` rather than leaking an unvetted string through. `code` is omitted (not null) on the very first, no-payment-submitted-yet challenge — that's an initial offer, not a rejected attempt, so there's nothing to code. See `X402ErrorCode` in `x402.ts` for the full type and reasoning.

## 5. Settle-before-grant — a real per-rail asymmetry, not a blanket guarantee

This is more nuanced than "some endpoints defer billing and some don't" — it depends on *which rail* a given request used, not just which endpoint:

- **Bearer, on `rank`**: debit is deferred until AFTER scoring — a `no_match`/`no_inventory` result is never charged. Unchanged since this route existed.
- **Bearer, on `quote`**: always charges on successful auth, before the response is built — a real, pre-existing difference between the two Bearer-authenticated routes, not new.
- **x402, on `rank` or `quote`**: settles on successful payment verification, BEFORE scoring — real USDC has already moved on-chain by the time the handler knows whether there's a match. There is no refund path for a no-match result on this rail. This is not a bug or an oversight — it's unavoidable: a completed on-chain transfer can't be deferred or undone the way a ledger debit can.
- **`book`**: the opposite direction entirely — dispatches to the vendor *first*, debits only after the vendor accepts, because there's no vendor-side cancellation API.

`compute/rank`'s response makes this checkable, not just documented: `billing.rail` (`"bearer"` or `"x402"`) tells the caller which guarantee applied to that specific request, and on `no_match`/`no_inventory` the x402 case includes an explicit `note` explaining why `billable` is still `true`.

## 6. Machine discovery — what's real vs. aspirational

`GET /llms.txt` and `GET /openapi.json` exist, are live, and accurately describe the endpoints above (verified this session). What's **not** verified: whether any agent framework actually crawls these files at runtime and auto-wires the API into a tool config today. That's a real, current gap — treat "agent frameworks discover and configure this programmatically" as a design goal the docs support, not an observed, production-verified behavior.

**x402 Bazaar extension (added 2026-09-24)** — `compute/rank`'s 402 response includes a real `extensions.bazaar` field (schema verified directly against x402-foundation's own TypeScript source, not assumed; hand-built to avoid a 9-dependency/1.7MB SDK for one static JSON object). Confirmed live: the field is present, correctly shaped, and correctly scoped to `rank` only (`route/quote` has none). **Updated 2026-09-26:** real settlements now flow through PayAI's facilitator (see §4) — the precondition for actual Bazaar listing that was previously unmet. Whether this endpoint has actually been crawled into PayAI's Bazaar catalog (`GET https://facilitator.payai.network/discovery/resources`) has not been separately re-checked after the first real settlement; treat "settlements now route through a Bazaar-participating facilitator" as confirmed and "therefore currently listed" as unconfirmed until someone checks that endpoint directly.

**Registry syndication (added 2026-09-25)** — beyond the official MCP Registry (`server.json`, live since 2026-09-24), the MCP server is now published live on Smithery as `scoutwyze/compute-mcp` (`https://smithery.ai/servers/scoutwyze/compute-mcp`), via a real MCPB bundle (`mcp-server/manifest.json`, `npm run build:mcpb`) that also works for Claude Desktop's single-click install. Real, functionally verified end to end — not just schema-checked: built, extracted, exercised with a live MCP `initialize`/`tools/list` handshake against the packed contents, then actually published through Smithery's real API (`smithery mcp publish`, requiring one prior human step: `smithery auth login`, GitHub OAuth). **Real gap found and worked around, not just documented:** Smithery's stdio-bundle ingestion 400s on any manifest with a top-level `tools` array, even a MCPB-spec-valid one — confirmed by bisection (three test publishes: with `tools` → fails every time; without it, everything else identical → publishes clean). `manifest.json` deliberately omits `tools` because of this; see `mcp-server/README.md`'s own note before adding it back. Researched and deliberately declined: an A2A (Agent2Agent) Agent Card (real spec verified, but built for stateful task delegation this one-shot REST+x402 API has no use for) and "MCPMarket" (mcpmarket.com — real and active, but a paid SEO-style directory: $29 for fast listing or a 4-6 week free queue, plain web form, no manifest format, no API — not a peer of the actual registries above).

## 7. Namespace rule (forward-looking, not yet exercised)
`/v1/compute/*` is the canonical namespace; a hypothetical second vertical would live at `/v1/<vertical>/quote` rather than an overloaded shared path. No second vertical exists yet — this is a documented constraint on future work, not something currently running in production.
