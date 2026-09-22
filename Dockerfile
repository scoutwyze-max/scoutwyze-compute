# ScoutWyze Compute — production image.
#
# Debian-based (not Alpine) in BOTH stages, deliberately — better-sqlite3
# is a native addon; mixing glibc (Debian) and musl (Alpine) between a
# build stage and a different runtime base is a real, easy-to-hit ABI
# mismatch ("invalid ELF header" at boot). Same base in both stages
# avoids that class of bug entirely.

FROM node:20-bookworm-slim AS builder
WORKDIR /app

# build-essential/python3 — fallback for better-sqlite3's node-gyp
# compile path if a prebuilt binary isn't available for this exact
# node/platform combination. A no-op (skipped) when a prebuild matches.
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential python3 \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
# `npm run build` = tsc + copy-fixtures (package.json) — tsc alone does
# NOT copy the provider fixture JSON files into dist/, since they're
# read via a runtime readFileSync, not a TS import. Missing this step
# was a real bug caught live: the built app boots and reports healthy,
# but silently ingests zero facts from all 3 providers (fail-closed
# swallows the ENOENT into a per-provider "failed" status rather than
# crashing) — a production deploy that LOOKS fine and serves nothing.
RUN npm run build

FROM node:20-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
# Fresh install, prod deps only — keeps typescript/vitest/tsx etc. out
# of the final image, and (same reasoning as the builder stage) compiles
# better-sqlite3 fresh against THIS exact base image rather than trusting
# a copied node_modules from a stage that's supposed to be identical but
# might drift.
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential python3 \
    && npm ci --omit=dev \
    && apt-get purge -y build-essential python3 \
    && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/dist ./dist

# Real SQLite file, prepaid-credit ledger, x402 nonces, processed-
# payment-event idempotency — all durable state lives under this path.
# Must be a mounted persistent volume in any real deployment (see
# fly.toml's [[mounts]]) or every restart loses everything: issued API
# keys, credit balances, payment idempotency records.
ENV DATABASE_PATH=/data/scoutwyze-compute.db
VOLUME ["/data"]

EXPOSE 8787
CMD ["node", "dist/index.js"]
