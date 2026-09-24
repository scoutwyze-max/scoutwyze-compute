#!/usr/bin/env node
// Orchestrator: discovery -> kit generation -> local review. That's it.
//
// Usage:
//   node scripts/outreach/run.mjs [--max N]
//
// Hard boundary, not a suggestion: this script never contacts anyone
// and never touches a target repo beyond the read-only search +
// metadata lookup in discover.mjs. It writes markdown kits to
// scripts/outreach/kits/ for manual review. Opening an issue/PR or
// messaging a maintainer is a separate, deliberate, per-repo human
// decision — nothing here automates that step, on purpose.

import { discover } from "./discover.mjs";
import { generateKit } from "./generateKit.mjs";

const args = process.argv.slice(2);
const maxArg = args.includes("--max") ? Number(args[args.indexOf("--max") + 1]) : Infinity;

const candidates = (await discover()).slice(0, maxArg);
console.error(`\n${candidates.length} candidate(s) after discovery.\n`);

const index = [];
for (const candidate of candidates) {
  const path = generateKit(candidate);
  index.push({ repo: candidate.fullName, path });
  console.error(`  wrote ${path}`);
}

console.error(`\n${index.length} kit(s) written under scripts/outreach/kits/. Review before sending anything, anywhere.`);
