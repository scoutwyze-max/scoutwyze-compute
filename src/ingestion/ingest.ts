import { IngestionCache } from "./cache.js";
import { PROVIDER_ADAPTERS } from "../providers/registry.js";

export function createIngestionCache(): IngestionCache {
  return new IngestionCache(PROVIDER_ADAPTERS);
}

/**
 * Starts the background refresh loop. Returns a stop function so tests
 * (and graceful shutdown) can clean up the interval instead of leaking it.
 */
export function startBackgroundIngestion(
  cache: IngestionCache,
  intervalSeconds: number,
): { stop: () => void } {
  const timer = setInterval(() => {
    void cache.ingestAll();
  }, intervalSeconds * 1000);
  // Don't hold the process open just for this timer during tests/scripts.
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}
