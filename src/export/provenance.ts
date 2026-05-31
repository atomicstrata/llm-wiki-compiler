/**
 * Export provenance helpers (radar W4).
 *
 * Surfaces the auditable lineage a downstream consumer (e.g. Atomic Radar)
 * needs to answer "this page came from these sources, via this model and
 * prompt version":
 *
 *  - {@link hashPageBody} derives a deterministic SHA-256 over a page body so
 *    a consumer can detect content drift without re-reading the markdown.
 *  - {@link buildSourceHashLookup} reads `.llmwiki/state.json` (the same
 *    per-source SHA-256 hashes the compiler computes for change detection in
 *    `src/compiler/hasher.ts`) into a filename → hash map.
 *  - {@link resolveSourceHashes} maps a page's `sources` frontmatter list to
 *    those committed hashes, preserving order and de-duplicating.
 *
 * The hashes here are the SAME digests `hasher.ts` writes to state.json — we
 * surface them rather than recompute, so the export stays consistent with the
 * compiler's own change-detection view and stays deterministic (no filesystem
 * re-reads, no wall-clock, no map-iteration order dependence).
 */

import { createHash } from "node:crypto";
import { readState } from "../utils/state.js";

/** Map of source filename → committed SHA-256 hash from state.json. */
export type SourceHashLookup = Record<string, string>;

/**
 * Deterministic SHA-256 (hex) of a page body. Stable for identical input:
 * the same body string always yields the same digest regardless of when or
 * where the export runs.
 * @param body - Full markdown page body (without frontmatter).
 * @returns Hex-encoded SHA-256 digest.
 */
export function hashPageBody(body: string): string {
  return createHash("sha256").update(body, "utf-8").digest("hex");
}

/**
 * Build a filename → source-hash lookup from the persisted compile state.
 * Reuses the per-source SHA-256 hashes the compiler already records for
 * incremental change detection, so the export never recomputes them.
 * @param root - Project root directory containing `.llmwiki/state.json`.
 * @returns Lookup keyed by source filename (as stored in frontmatter `sources`).
 */
export async function buildSourceHashLookup(root: string): Promise<SourceHashLookup> {
  const state = await readState(root);
  const lookup: SourceHashLookup = {};
  for (const [file, entry] of Object.entries(state.sources)) {
    lookup[file] = entry.hash;
  }
  return lookup;
}

/**
 * Resolve the source-file SHA-256 hashes a page derived from.
 *
 * Maps each entry in the page's `sources` frontmatter list to its committed
 * hash. Sources without a recorded hash (e.g. seed pages with an empty
 * source list, or a source removed from state) contribute nothing. Order
 * follows the `sources` list and duplicates collapse, so the output is
 * deterministic for a given (sources, state) pair.
 *
 * @param sources - Source filenames cited by the page (frontmatter `sources`).
 * @param lookup - Filename → hash map from {@link buildSourceHashLookup}.
 * @returns Ordered, de-duplicated list of source hashes.
 */
export function resolveSourceHashes(
  sources: string[],
  lookup: SourceHashLookup,
): string[] {
  const hashes: string[] = [];
  const seen = new Set<string>();
  for (const file of sources) {
    const hash = lookup[file];
    if (hash === undefined || seen.has(hash)) continue;
    hashes.push(hash);
    seen.add(hash);
  }
  return hashes;
}
