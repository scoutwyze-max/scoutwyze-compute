#!/usr/bin/env node
// Kit generator — turns a discovered candidate into a standalone,
// human-reviewable integration kit (markdown: context + snippet + draft
// CTA copy). Never touches the target repo itself — no clone, no diff,
// no PR, no issue. Output is a local file for review; whether/how to
// actually reach out is a separate, deliberate decision this script
// does not make.
//
// Two flavors, kept deliberately non-overlapping per SOT.md:
//   - "bearer": /v1/compute/sample + /v1/compute/rank (Bearer-only, no
//     x402 on these two)
//   - "x402": /v1/route/quote only (the one endpoint that actually
//     supports x402/USDC-on-Base, plus Bearer as its fallback rail)

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const BASE_URL = "https://scoutwyze-compute.fly.dev";

function detectStack(language) {
  const lang = (language ?? "").toLowerCase();
  if (lang === "python") return "python";
  if (lang === "javascript" || lang === "typescript") return "node";
  return "curl";
}

function bearerSnippet(stack) {
  if (stack === "python") {
    return `import requests

# Free, no key — same response shape as the paid call below
sample = requests.get("${BASE_URL}/v1/compute/sample").json()

# Paid — $0.15, debited only on a real match
rank = requests.post(
    "${BASE_URL}/v1/compute/rank",
    headers={"Authorization": "Bearer sw_live_..."},
    json={"gpuClass": "H100", "preference": "cheapest"},
).json()
`;
  }
  if (stack === "node") {
    return `// Free, no key — same response shape as the paid call below
const sample = await fetch("${BASE_URL}/v1/compute/sample").then(r => r.json());

// Paid — $0.15, debited only on a real match
const rank = await fetch("${BASE_URL}/v1/compute/rank", {
  method: "POST",
  headers: { "Authorization": "Bearer sw_live_...", "Content-Type": "application/json" },
  body: JSON.stringify({ gpuClass: "H100", preference: "cheapest" }),
}).then(r => r.json());
`;
  }
  return `# Free, no key
curl ${BASE_URL}/v1/compute/sample

# Paid — $0.15, debited only on a real match
curl -X POST ${BASE_URL}/v1/compute/rank \\
  -H "Authorization: Bearer sw_live_..." \\
  -H "Content-Type: application/json" \\
  -d '{"gpuClass":"H100","preference":"cheapest"}'
`;
}

function x402Snippet() {
  return `# 1. Unauthenticated request gets a real 402 challenge
curl -X POST ${BASE_URL}/v1/route/quote -d '{}'
# -> 402, body includes nonce / payTo / maxAmountRequired / expiresAt

# 2. Sign + submit a real on-chain USDC (Base) transfer proving payment,
#    resubmit with the X-PAYMENT header -> 200
#    (see scripts/pay-x402-quote.mjs in the ScoutWyze Compute repo for
#    a full reference implementation of this flow)

# Bearer key also works on this same endpoint, for teams that'd rather
# prepay once via Stripe instead of paying per-call on-chain:
curl -X POST ${BASE_URL}/v1/route/quote \\
  -H "Authorization: Bearer sw_live_..." \\
  -d '{"workload_type":"inference","region":"us-east-1"}'
`;
}

function bearerKit(candidate) {
  const stack = detectStack(candidate.language);
  return `# Integration kit — ${candidate.fullName}

**Review-only draft. Nothing here has been sent to anyone.**

- Why this repo: ${candidate.signal} (matched in \`${candidate.path}\`)
- Repo: ${candidate.url}
- Language: ${candidate.language ?? "unknown"} · ★${candidate.stars}
- Endpoint flavor: Bearer/prepaid (\`/v1/compute/sample\`, \`/v1/compute/rank\`) — no x402 on these two, by design (see SOT.md §4).

## Suggested integration snippet

\`\`\`${stack === "curl" ? "bash" : stack}
${bearerSnippet(stack)}\`\`\`

## Suggested outreach copy (draft — edit before use, if used at all)

> Saw ${candidate.fullName} calls a GPU provider's API directly — thought you might want a live price/freshness check alongside it. Free sample, no key: \`curl ${BASE_URL}/v1/compute/sample\`. $10 prepaid if you want the filtered version (\`/v1/compute/rank\`), no subscription.

## Funnel
1. Free sample (\`GET /v1/compute/sample\`) — no signup
2. \`POST /v1/signup\` — free key
3. \`POST /v1/checkout-sessions\` — $10/$50/$200 prepaid pack, real Stripe
4. \`POST /v1/compute/rank\` — $0.15/successful match
`;
}

function x402Kit(candidate) {
  return `# Integration kit (x402) — ${candidate.fullName}

**Review-only draft. Nothing here has been sent to anyone.**

- Why this repo: ${candidate.signal} (matched in \`${candidate.path}\`)
- Repo: ${candidate.url}
- Language: ${candidate.language ?? "unknown"} · ★${candidate.stars}
- Endpoint flavor: x402/USDC-on-Base (\`/v1/route/quote\` only — NOT compute/rank or compute/sample, which are Bearer-only. See SOT.md §4.)

## Suggested integration snippet

\`\`\`bash
${x402Snippet()}\`\`\`

## Suggested outreach copy (draft — edit before use, if used at all)

> Saw ${candidate.fullName} calls a GPU provider's API directly — if you're doing anything agent-driven, \`/v1/route/quote\` pays natively over x402/USDC on Base, no API key or signup needed. Real 402 challenge, real on-chain settlement.

## Funnel
1. Agent hits \`POST /v1/route/quote\` unauthenticated → real 402 challenge
2. Agent signs + submits a real Base USDC transfer, resubmits with \`X-PAYMENT\` → 200
3. (Or: a Bearer key works on the same endpoint too, for teams that'd rather prepay via Stripe)
`;
}

export function generateKit(candidate, flavor) {
  const content = flavor === "x402" ? x402Kit(candidate) : bearerKit(candidate);
  const safeName = candidate.fullName.replace("/", "__");
  const path = `scripts/outreach/kits/${flavor}/${safeName}.md`;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf-8");
  return path;
}
