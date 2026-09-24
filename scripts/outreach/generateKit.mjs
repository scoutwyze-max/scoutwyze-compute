#!/usr/bin/env node
// Kit generator — turns a discovered candidate into a standalone,
// human-reviewable integration kit (markdown: context + snippets +
// draft CTA copy). Never touches the target repo itself — no clone,
// no diff, no PR, no issue. Output is a local file for review;
// whether/how to actually reach out is a separate, deliberate decision
// this script does not make.
//
// One kit type (2026-09-24, collapsed from the earlier bearer/x402
// split): /v1/compute/rank has been dual-rail since x402 was extended
// onto it, so a real integration kit for that endpoint has to show
// BOTH paths, not pick one — a human-operated service wants the
// prepaid Bearer path, a fully autonomous agent wants x402. Showing
// only one would misrepresent what the endpoint actually does.

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

rank = requests.post(
    "${BASE_URL}/v1/compute/rank",
    headers={"Authorization": "Bearer sw_live_..."},
    json={"gpuClass": "H100", "preference": "cheapest"},
).json()
`;
  }
  if (stack === "node") {
    return `const rank = await fetch("${BASE_URL}/v1/compute/rank", {
  method: "POST",
  headers: { "Authorization": "Bearer sw_live_...", "Content-Type": "application/json" },
  body: JSON.stringify({ gpuClass: "H100", preference: "cheapest" }),
}).then(r => r.json());
`;
  }
  return `curl -X POST ${BASE_URL}/v1/compute/rank \\
  -H "Authorization: Bearer sw_live_..." \\
  -H "Content-Type: application/json" \\
  -d '{"gpuClass":"H100","preference":"cheapest"}'
`;
}

function mcpSnippet() {
  return `{
  "mcpServers": {
    "scoutwyze-compute": {
      "command": "npx",
      "args": ["-y", "@scoutwyze/compute-mcp"],
      "env": { "SCOUTWYZE_API_KEY": "sw_live_..." }
    }
  }
}
`;
}

function x402Snippet() {
  return `# 1. Call it with no credentials at all — real 402 challenge back
curl -X POST ${BASE_URL}/v1/compute/rank -d '{"gpuClass":"H100"}'
# -> 402, body includes nonce / payTo / maxAmountRequired / expiresAt
#    ("resource" in the challenge correctly says /v1/compute/rank)

# 2. Sign + submit a real on-chain USDC (Base) transfer proving payment,
#    resubmit the SAME request with the X-PAYMENT header -> 200
#    (see scripts/pay-x402-quote.mjs in the ScoutWyze Compute repo for
#    a full reference implementation of this flow)
#
# No API key. No signup. No card. No human on either end for this path
# — the agent authenticates itself with a real payment, not a lookup.
`;
}

function buildKit(candidate) {
  const stack = detectStack(candidate.language);
  return `# Integration kit — ${candidate.fullName}

**Review-only draft. Nothing here has been sent to anyone.**

- Why this repo: ${candidate.signal} (matched in \`${candidate.path}\`)
- Repo: ${candidate.url}
- Language: ${candidate.language ?? "unknown"} · ★${candidate.stars}
- Endpoint: \`POST /v1/compute/rank\` — $0.15/successful match, dual-rail as of 2026-09-24 (see SOT.md §4/§5). Every response's \`billing.rail\` field says which path was used.

## Path A — prepaid key (a human funds it once, then it's headless)

\`\`\`${stack === "curl" ? "bash" : stack}
${bearerSnippet(stack)}\`\`\`

Debit is deferred until AFTER scoring — a \`no_match\` result is never charged on this path.

## Path B — fully agent-native, zero human on either end

\`\`\`bash
${x402Snippet()}\`\`\`

This path settles on payment BEFORE scoring — real USDC has already moved by the time a \`no_match\` is known, and there's no refund path for it (the response says so explicitly when it happens). That's the tradeoff for not needing a signup step at all.

## Path C — via MCP, if this is used inside Claude Desktop or Cursor

Real, published, cold-\`npx\`-verified — not a placeholder. Uses Path A's prepaid key under the hood (the MCP server never holds a private key or settles x402 itself; on an unauthenticated call it surfaces the real 402 challenge back to you instead of failing silently).

\`\`\`json
${mcpSnippet()}\`\`\`

## Suggested outreach copy (draft — edit before use, if used at all)

> Saw ${candidate.fullName} calls a GPU provider's API directly — thought you might want a live price/freshness check alongside it. Free sample, no key: \`curl ${BASE_URL}/v1/compute/sample\`. If it's for a human-operated service, $10 prepaid gets you a key (also works as an MCP tool in Claude Desktop/Cursor — \`npx @scoutwyze/compute-mcp\`). If it's for an autonomous agent, it can pay per-call over x402 with no key at all.

## Funnel
- Free sample first, either way: \`GET /v1/compute/sample\`
- Path A: \`POST /v1/signup\` (free) → \`POST /v1/checkout-sessions\` ($10/$50/$200, real Stripe) → \`POST /v1/compute/rank\` with the key
- Path B: \`POST /v1/compute/rank\` unauthenticated → real 402 challenge → pay it → retry with \`X-PAYMENT\`
- Path C: same key as Path A, wired into an MCP host instead of called directly
`;
}

export function generateKit(candidate) {
  const safeName = candidate.fullName.replace("/", "__");
  const path = `scripts/outreach/kits/${safeName}.md`;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, buildKit(candidate), "utf-8");
  return path;
}
