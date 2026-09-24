# Outreach kit generator

Finds public repos that show a concrete signal of needing GPU pricing
data, and writes a standalone, human-reviewable integration kit for
each one. That is the entire scope.

## Hard boundary — read this before extending this tool

- **Discovery is read-only.** GitHub code search + one repo-metadata
  lookup per candidate, via the authenticated `gh` CLI. No scraping, no
  cloning, no reading a target repo's actual source beyond what the
  search API returns.
- **Kit generation never touches the target repo.** No diffs, no PRs,
  no issues, no commits — standalone markdown files only.
- **Nothing is ever sent automatically.** Every kit is written to
  `scripts/outreach/kits/` for manual review. Deciding whether, how,
  and to whom to actually reach out is a separate human decision this
  tool does not make and should not be extended to make.

This boundary exists on purpose, not by oversight: unsolicited PRs or
DMs pitching a paid product into someone's open-source repo is a well
known bad pattern that reads as spam even when the code itself is
fine, and this product's target audience (developers who already
comparison-shop infra pricing) is unusually quick to call that out
publicly. The cost of that reputational damage is much higher than the
cost of a human spending five minutes reviewing a kit before deciding
what, if anything, to do with it.

## Usage

```
npm run outreach                    # Bearer kits (compute/rank + compute/sample)
npm run outreach -- --flavor x402   # x402 kit (route/quote only)
npm run outreach -- --flavor both
npm run outreach -- --max 5         # cap candidates, e.g. for a quick test run
```

## Flavors

- `bearer` — `/v1/compute/sample` + `/v1/compute/rank`. Bearer/prepaid
  only. Never mentions x402 — those two endpoints don't support it
  (see `SOT.md` §4).
- `x402` — `/v1/route/quote` only, the one endpoint that actually
  supports x402/USDC-on-Base (Bearer also works there as a fallback).
  Never conflated with the `compute/*` envelope, which is a different,
  separate schema (`SOT.md` §3 vs §4).

## Signals used for discovery

Precise, low-noise only — direct provider API calls or the providers'
own env var names (`api.runpod.io`, `RUNPOD_API_KEY`,
`cloud.lambdalabs.com`, `LAMBDA_API_KEY`). Broad keyword searches like
"gpu pricing" were deliberately left out — GitHub code search doesn't
support enough qualifiers to keep those precise, and a noisy candidate
list just wastes review time later. Forks and archived repos are
filtered out — weak leads, the visible owner isn't the one deciding
what an active codebase integrates.
