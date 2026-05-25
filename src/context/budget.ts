/**
 * Token budget estimation + deterministic trimming for `llmwiki context`.
 *
 * V1 uses a deterministic `Math.ceil(chars / 4)` heuristic so the token
 * count is stable across runs and identical between CLI and MCP. The
 * helper is isolated so a real tokenizer can replace it later without
 * touching the orchestrator (see plan §Budgeting).
 *
 * The estimator is intentionally pessimistic on the high side: a 4-char
 * average is slightly low for English prose, so packets that pass
 * `estimatedTokens <= requestedTokens` will fit comfortably in a real
 * tokenizer's count as well.
 *
 * Trimming order (plan §Budgeting §Trimming order):
 *   1. neighbors
 *   2. source windows
 *   3. semantic chunks / excerpts
 *   4. primary pages (last resort)
 *
 * Trim functions mutate a deep-cloned copy of the pack so the caller's
 * draft is never observably modified. JSON validity is preserved at
 * every step because we drop entire array elements rather than
 * surgically slicing strings.
 */

import type { ContextBudget, ContextPack } from "./types.js";

/** Average chars-per-token used by the cheap heuristic. */
const APPROX_CHARS_PER_TOKEN = 4;

/** Section names that can land in `budget.trimmedSections`. */
type TrimmedSection = "neighbors" | "sourceWindows" | "chunks" | "primary";

/**
 * Estimate token count for an arbitrary string. Always returns a
 * non-negative integer. The empty string and `null`/`undefined` map to
 * zero; non-string inputs are coerced.
 */
export function estimateTokens(text: unknown): number {
  if (text === null || text === undefined) return 0;
  const stringified = typeof text === "string" ? text : String(text);
  if (stringified.length === 0) return 0;
  return Math.ceil(stringified.length / APPROX_CHARS_PER_TOKEN);
}

/**
 * Estimate the total token weight of a serialized context pack. Uses
 * the same heuristic as {@link estimateTokens}; runs on the
 * already-rendered JSON string so trimming decisions can iterate
 * without rebuilding the structured envelope from scratch.
 */
export function estimatePackTokens(pack: ContextPack): number {
  return estimateTokens(JSON.stringify(pack));
}

/**
 * Build a fresh budget envelope before estimation/trimming runs.
 * Defaults preserve the v1 contract (`truncated: false`,
 * `trimmedSections: []`); the orchestrator overwrites these in
 * `finalizeBudget` once trimming decisions are known.
 */
export function buildBudget(requestedTokens: number, estimatedTokens: number): ContextBudget {
  return {
    requestedTokens,
    estimatedTokens,
    truncated: false,
    trimmedSections: [],
  };
}

/** Result returned by {@link trimToBudget}; pack is a NEW object, never the input. */
interface TrimResult {
  pack: ContextPack;
  trimmedSections: TrimmedSection[];
}

/**
 * Deterministically trim `pack` until `estimatePackTokens(pack) <=
 * requestedTokens`, in the documented order:
 *   neighbors -> sourceWindows -> chunks -> primary
 *
 * Each section is drained from the END of its array so the highest-
 * scored entries survive longest (ranking output is already sorted
 * descending). The returned pack is always a deep clone — the caller's
 * draft is left untouched.
 *
 * If the minimal envelope (no neighbors, no sourceWindows, no chunks,
 * no primary) still exceeds the budget, the pack is returned as-is
 * with `trimmedSections` listing every section we touched so consumers
 * can see the failure mode.
 */
export function trimToBudget(pack: ContextPack, requestedTokens: number): TrimResult {
  const clone = clonePack(pack);
  const trimmed = new Set<TrimmedSection>();
  if (estimatePackTokens(clone) <= requestedTokens) {
    return { pack: clone, trimmedSections: [] };
  }
  trimNeighbors(clone, requestedTokens, trimmed);
  trimSourceWindows(clone, requestedTokens, trimmed);
  trimChunks(clone, requestedTokens, trimmed);
  trimPrimary(clone, requestedTokens, trimmed);
  return { pack: clone, trimmedSections: orderedSections(trimmed) };
}

/** Deep-clone via `structuredClone` so per-step mutations cannot leak. */
function clonePack(pack: ContextPack): ContextPack {
  return structuredClone(pack);
}

/** Re-emit trimmed sections in the documented trim order, not insertion order. */
function orderedSections(trimmed: Set<TrimmedSection>): TrimmedSection[] {
  const order: TrimmedSection[] = ["neighbors", "sourceWindows", "chunks", "primary"];
  return order.filter((section) => trimmed.has(section));
}

/** Drop neighbors from the end of the sorted list until the pack fits or none remain. */
function trimNeighbors(
  pack: ContextPack,
  budget: number,
  trimmed: Set<TrimmedSection>,
): void {
  while (pack.neighbors.length > 0 && estimatePackTokens(pack) > budget) {
    pack.neighbors.pop();
    trimmed.add("neighbors");
  }
}

/**
 * Drop source windows page-by-page from the bottom-ranked primary
 * entry first so the most relevant page keeps its provenance evidence
 * longest. Walks until either the pack fits or every page has zero
 * windows.
 */
function trimSourceWindows(
  pack: ContextPack,
  budget: number,
  trimmed: Set<TrimmedSection>,
): void {
  for (let i = pack.primary.length - 1; i >= 0; i--) {
    while (pack.primary[i].sourceWindows.length > 0 && estimatePackTokens(pack) > budget) {
      pack.primary[i].sourceWindows.pop();
      trimmed.add("sourceWindows");
    }
    if (estimatePackTokens(pack) <= budget) return;
  }
}

/** Drop semantic chunks page-by-page using the same bottom-up strategy. */
function trimChunks(
  pack: ContextPack,
  budget: number,
  trimmed: Set<TrimmedSection>,
): void {
  for (let i = pack.primary.length - 1; i >= 0; i--) {
    while (pack.primary[i].chunks.length > 0 && estimatePackTokens(pack) > budget) {
      pack.primary[i].chunks.pop();
      trimmed.add("chunks");
    }
    if (estimatePackTokens(pack) <= budget) return;
  }
}

/** Final resort: drop primary pages from the bottom of the ranked list. */
function trimPrimary(
  pack: ContextPack,
  budget: number,
  trimmed: Set<TrimmedSection>,
): void {
  while (pack.primary.length > 0 && estimatePackTokens(pack) > budget) {
    pack.primary.pop();
    trimmed.add("primary");
  }
}
