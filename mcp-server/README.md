# ScoutWyze Compute MCP server

A stateless MCP (Model Context Protocol) wrapper around ScoutWyze
Compute's GPU-offer-ranking API, for MCP-native agent hosts (Claude
Desktop, Cursor, custom agent frameworks). Ranks current RunPod GPU
offers by price and freshness — nothing else. Not part of the main
`scoutwyze-compute` app; this is a separate, independently
installable package, kept out of `src/` on purpose.

## Hard boundary — read this before extending this server

**This server never holds a private key and never signs or settles an
x402 payment itself.** If a call to `scoutwyze_rank` is unauthenticated
(no `SCOUTWYZE_API_KEY` configured, or the key is invalid), the real
x402 payment challenge from the API is returned as the tool's result
content, not swallowed or auto-paid — for example:

```json
{
  "x402Version": 1,
  "error": "payment_required",
  "accepts": [{
    "scheme": "exact", "network": "base", "maxAmountRequired": "150000",
    "resource": "/v1/compute/rank",
    "payTo": "0xc132a315a05541a4b72c272de539eb86de977fb9",
    "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    "maxTimeoutSeconds": 120,
    "extra": { "name": "USD Coin", "version": "2" }
  }]
}
```

A wallet-capable **calling agent** — not this server — is responsible
for signing an EIP-3009 `TransferWithAuthorization` (EIP-712 typed
data, under the exact `extra.name`/`extra.version` domain above — real
x402 "exact" EVM scheme, no on-chain broadcast from the payer at all;
this server's own facilitator handles that) and retrying the same tool
call with the resulting `X-PAYMENT` proof. See `examples/node-client.mjs`
or `examples/python_client.py` in the main repo for a complete, tested
reference implementation of that signing flow. This server's only
credential is an optional prepaid Bearer key.

This isn't a style choice. A "lightweight package anyone can spin up
locally" holding a real funded private key is a fundamentally
different risk class than anything else in this codebase, and it
contradicts the posture maintained everywhere else in it (the on-chain
verification code reads the chain, it never sends transactions or
holds keys). Do not add wallet/signing capability to this server.

## Tools

- **`scoutwyze_sample`** — free, anonymous, rate-limited preview
  (`GET /v1/compute/sample`). No arguments, never billed.
- **`scoutwyze_rank`** — ranks GPU offers for a workload
  (`POST /v1/compute/rank`). `gpuClass`, `minVramGb`, `region`,
  `maxPricePerHour`, `preference` — all optional. Billed per
  successful match; the real price is always read live from the
  response's `billing.price_usd`, never hardcoded here (server-side
  pricing can change; a static price in a tool description would just
  go stale the same way several other docs in this repo have before).

`POST /v1/route/quote` is deliberately not wrapped — it uses an older,
separate response schema, and `compute/rank` is the flagship,
actively-documented path (see `SOT.md`).

## Configuration

Published on npm as `@scoutwyze/compute-mcp` and listed in the official
MCP Registry as `io.github.scoutwyze-max/compute-mcp`. Add to your MCP
host's config (e.g. Claude Desktop's `mcp.json`):

```json
{
  "mcpServers": {
    "scoutwyze-compute": {
      "command": "npx",
      "args": ["-y", "@scoutwyze/compute-mcp"],
      "env": {
        "SCOUTWYZE_API_KEY": "sw_live_..."
      }
    }
  }
}
```

For local development, point at the built file directly instead:

```json
{
  "mcpServers": {
    "scoutwyze-compute": {
      "command": "node",
      "args": ["/absolute/path/to/scoutwyze-compute/mcp-server/dist/index.js"],
      "env": {
        "SCOUTWYZE_API_KEY": "sw_live_..."
      }
    }
  }
}
```

- `SCOUTWYZE_API_KEY` — optional. A prepaid Bearer key from
  `POST /v1/signup` + `POST /v1/checkout-sessions`. Omit it entirely to
  run unauthenticated — `scoutwyze_rank` will then return a real x402
  challenge instead of ranked results (see the boundary above).
- `SCOUTWYZE_BASE_URL` — optional, defaults to
  `https://scoutwyze-compute.fly.dev`. Override for local development
  against the main app's `npm run dev` server.

## Development

```
npm install
npm run build   # -> dist/index.js
npm run dev     # runs directly from src/ via tsx, no build step
```

## Publishing a new version

`npm version <patch|minor|major>` then `npm publish` from inside this
directory (`prepublishOnly` runs the build automatically, so `dist/`
is always fresh — never publish a stale build by hand-running
`npm run build` first and trusting it's still current). After
publishing to npm, also bump `version` in **both** `server.json`
(official MCP Registry) and `manifest.json` (MCPB bundle, below) to
match, and re-run `mcp-publisher publish server.json` — three separate
version strings that don't cross-check each other, easy for one to
drift silently otherwise.

`tsc` does not preserve or set the executable bit on its output, so
`dist/index.js` comes out of a plain `npm run build` as `644` — not
runnable via `bin`. The `postbuild` script (`chmod +x dist/index.js`)
fixes this on every build; don't remove it.

## MCPB bundle (Smithery, Claude Desktop single-click install)

`manifest.json` is a real MCPB manifest (github.com/modelcontextprotocol/mcpb,
`manifest_version: "0.3"`) — a *different* file from `server.json`
(the official MCP Registry's own manifest format; the two are
unrelated specs with overlapping-sounding names). `npm run build:mcpb`
stages a clean directory (`dist/`, `manifest.json`,
production-only `node_modules`, `package.json` — none of the repo's
own `src/`, tests, `Dockerfile`, or `server.json`) and packs it into
`scoutwyze-compute-mcp.mcpb` via the real `mcpb` CLI (`@anthropic-ai/mcpb`,
a local devDependency). The output `.mcpb` file is gitignored and
rebuilt on demand, same as `dist/`.

This is what Smithery's stdio publish path expects
(`smithery mcp publish ./scoutwyze-compute-mcp.mcpb -n <org>/<name>`,
per smithery.ai/docs/build/publish — verified against their live docs
2026-09-25, not the older `smithery.yaml` convention some example
repos still show) — requires a one-time `smithery auth login` (GitHub
OAuth, a human/browser step) before the CLI can publish; not
scriptable end-to-end without that. The same `.mcpb` file also works
for Claude Desktop's single-click local install (drag the file onto
the app).

**Published live 2026-09-25 as `scoutwyze/compute-mcp`**
(`https://smithery.ai/servers/scoutwyze/compute-mcp`). Real, hard-won
finding while getting there: **`manifest.json` deliberately has no
top-level `tools` array**, even though MCPB's own spec allows one and
`mcpb validate` accepts it fine. Smithery's stdio-bundle ingestion
throws a 400 (`"Invalid input: expected object, received undefined"`,
once per declared tool) on any bundle that includes one — confirmed by
bisection: a manifest with `tools` fails every time, the identical
manifest without it publishes clean, `user_config`/`env`/every other
optional field included. Looks like a real gap in their ingestion
(their own docs describe a *different*, richer tool-schema format —
`@modelcontextprotocol/sdk/types.js`-shaped, with a required
`inputSchema` — used for hosted URL servers' static server cards, not
MCPB's plainer `tools[]`), not something on our end to fix. If you're
re-publishing and add `tools` back because it seems like the more
complete manifest, you will hit this again — check whether Smithery's
ingestion has been fixed before doing so, don't assume it's safe now
just because MCPB's own validator accepts it.

## Other rules this server follows, not just documents

- **Fails closed.** A network failure to the real API returns a fixed,
  generic error — never a cached or fabricated result.
- **Never echoes `SCOUTWYZE_API_KEY`** in any tool response or error
  message, including on network failure (the error path is a fixed
  string, not an interpolation of the underlying error object, which
  could in principle carry request details).
- **`schema_version` passes through untouched** — this server never
  restructures or reinterprets the upstream response body, so a
  calling agent can detect a future envelope change itself.
