/**
 * Embedding-refresh configuration shared by provider preflight and writers.
 *
 * Keeping the environment parser outside the embedding writer lets compile
 * entry points decide which provider capabilities they need without importing
 * filesystem, locking, migration, or provider-construction code. The accepted
 * opt-out spellings match the other negative environment switch exposed by
 * llmwiki (`LLMWIKI_SOURCES_SECTION`).
 */

import { ENV_EMBEDDINGS } from "./constants.js";

/** Case-insensitive values that disable embedding production. */
const EMBEDDINGS_DISABLED_VALUES: ReadonlySet<string> = new Set([
  "0",
  "false",
  "no",
  "off",
]);

/** Return whether embedding production is explicitly disabled. */
export function embeddingsDisabled(): boolean {
  const value = process.env[ENV_EMBEDDINGS];
  return value !== undefined && EMBEDDINGS_DISABLED_VALUES.has(value.trim().toLowerCase());
}
