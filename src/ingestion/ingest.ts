import { IngestionCache } from "./cache.js";
import { PROVIDER_ADAPTERS } from "../providers/registry.js";

export function createIngestionCache(ttlSeconds: number): IngestionCache {
  return new IngestionCache(PROVIDER_ADAPTERS, ttlSeconds);
}
