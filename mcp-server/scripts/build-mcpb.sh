#!/usr/bin/env bash
# Builds a real .mcpb bundle (MCP Bundle spec, github.com/modelcontextprotocol/mcpb)
# for Smithery's stdio publish path (`smithery mcp publish ./scoutwyze-compute-mcp.mcpb`)
# and any other host that accepts MCPB bundles (e.g. Claude Desktop's
# single-click install).
#
# Stages a clean directory instead of packing mcp-server/ as-is — the
# repo root also has src/, tests, tsconfig.json, README.md, Dockerfile,
# and server.json (the DIFFERENT MCP-Registry manifest, not this one),
# none of which belong in an end-user-facing bundle. Uses the local
# @anthropic-ai/mcpb devDependency via npx, not a global install.
set -euo pipefail
cd "$(dirname "$0")/.."

npm run build
rm -rf .mcpb-stage
mkdir -p .mcpb-stage
cp manifest.json .mcpb-stage/
cp -r dist .mcpb-stage/
cp package.json package-lock.json .mcpb-stage/
(cd .mcpb-stage && npm ci --omit=dev)

npx mcpb validate .mcpb-stage/manifest.json
npx mcpb pack .mcpb-stage scoutwyze-compute-mcp.mcpb
echo "Built: mcp-server/scoutwyze-compute-mcp.mcpb"
