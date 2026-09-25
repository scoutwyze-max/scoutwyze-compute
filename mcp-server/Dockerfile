# Multi-stage build for @scoutwyze/compute-mcp — a stdio MCP server.
# Not used by this repo's own deployment (the MCP server ships via npm,
# see package.json); this exists so third-party scanners (e.g. Glama's
# MCP directory listing check) can build and run the server themselves
# to confirm it starts and responds to a real MCP introspection
# request, without needing npm publish access.

FROM node:20-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:20-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist

# Stdio transport — no port to expose. SCOUTWYZE_API_KEY is optional
# (see README's Hard boundary section): unset, scoutwyze_rank returns
# a real x402 challenge instead of ranked results, which is enough for
# an introspection/tools-list check to confirm the server is alive.
ENTRYPOINT ["node", "dist/index.js"]
