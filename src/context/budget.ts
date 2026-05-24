/**
 * Token budget estimation for `llmwiki context`.
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
 */

import type { ContextBudget, ContextPack } from "./types.js";

/** Average chars-per-token used by the cheap heuristic. */
const APPROX_CHARS_PER_TOKEN = 4;

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

/** Build a fresh budget envelope with the v1 defaults. */
export function buildBudget(requestedTokens: number, estimatedTokens: number): ContextBudget {
  return {
    requestedTokens,
    estimatedTokens,
    truncated: false,
    trimmedSections: [],
  };
}
