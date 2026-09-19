import type { ProviderAdapter } from "./types.js";
import { lambdaLabsAdapter } from "./lambdaLabs.js";
import { runpodAdapter } from "./runpod.js";
import { coreweaveAdapter } from "./coreweave.js";

// CLAUDE.md §2 — exactly 3 provider feeds for V1. Adding a 4th means
// adding one adapter file + one line here, nothing in the engine changes.
export const PROVIDER_ADAPTERS: ProviderAdapter[] = [
  lambdaLabsAdapter,
  runpodAdapter,
  coreweaveAdapter,
];
