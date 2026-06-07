/**
 * Per-concept prompt-budget enforcement (issue #39).
 *
 * When the same concept is extracted from many overlapping sources, the
 * page-generation prompt would otherwise concatenate every full source
 * — linear in source count — and reliably blow past the LLM provider's
 * context window. This module clips each contributing source's slice to
 * a fair share of a configurable total budget and emits a single warning
 * when truncation kicks in.
 *
 * The fix is deliberately defensive (proportional truncation) rather than
 * smart (semantic ranking / summarisation). It prevents crashes while a
 * deeper retrieval-driven solution is designed.
 */

import * as output from "../utils/output.js";
import {
  DEFAULT_PROMPT_BUDGET_CHARS,
  PROMPT_BUDGET_ENV_VAR,
} from "../utils/constants.js";

/** Marker appended to a source slice when it was truncated to fit the budget. */
const TRUNCATION_MARKER = "\n\n[…truncated for prompt budget — see #39…]";

/** A single source's contribution to the combined per-concept content. */
export interface SourceSlice {
  /** Source filename (e.g. "ml-paper.md") shown as a section header in the prompt. */
  file: string;
  /** Raw extracted source content, before any budgeting. */
  content: string;
}

/**
 * Resolve the active prompt-budget character cap. Reads the
 * `LLMWIKI_PROMPT_BUDGET_CHARS` env var when present and parseable; falls
 * back to `DEFAULT_PROMPT_BUDGET_CHARS`. Invalid values (non-numeric or
 * <= 0) are ignored so a typo can't accidentally truncate every prompt
 * to nothing.
 */
export function resolvePromptBudgetChars(): number {
  const raw = process.env[PROMPT_BUDGET_ENV_VAR];
  if (!raw) return DEFAULT_PROMPT_BUDGET_CHARS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_PROMPT_BUDGET_CHARS;
  return parsed;
}

/**
 * Combine per-source slices into the single content blob the LLM prompt
 * receives, applying a fair-share budget when the raw total would exceed
 * the configured ceiling. When no truncation is needed the output is
 * byte-identical to the previous unbudgeted concatenation, so existing
 * compile output is unchanged for typical workloads.
 *
 * @param concept - Human-readable concept title (used in the warning only).
 * @param slices - One entry per contributing source, in arrival order.
 * @returns The combined content string suitable for buildPagePrompt.
 */
export function buildBudgetedCombinedContent(
  concept: string,
  slices: SourceSlice[],
): string {
  const budget = resolvePromptBudgetChars();
  const totalRaw = slices.reduce((sum, s) => sum + s.content.length, 0);

  if (totalRaw <= budget) {
    return formatSlices(slices);
  }

  const perSource = Math.max(1, Math.floor(budget / slices.length));
  warnTruncation(concept, totalRaw, slices.length, perSource, budget);

  const trimmed = slices.map((s) =>
    s.content.length > perSource
      ? { ...s, content: s.content.slice(0, perSource) + TRUNCATION_MARKER }
      : s,
  );
  return formatSlices(trimmed);
}

/**
 * Prepend right-aligned 1-indexed line numbers to each line of source content.
 * Gives the LLM explicit anchors so its ^[file.md:N-M] citations are accurate.
 */
function numberLines(content: string): string {
  const lines = content.split("\n");
  const width = String(lines.length).length;
  return lines
    .map((line, i) => `${String(i + 1).padStart(width)} | ${line}`)
    .join("\n");
}

/**
 * Clip a single source's content to the active prompt budget and prepend line
 * numbers, so a prompt that asks the model for line spans actually shows the
 * model numbered lines (and never exceeds the budget). Used by the rule
 * extractor, which feeds one source per call rather than a merged concept.
 *
 * @param file - Source filename, for the truncation warning only.
 * @param content - Raw source content.
 * @returns Numbered (and, when over budget, truncated) content.
 */
export function budgetAndNumberSource(file: string, content: string): string {
  const budget = resolvePromptBudgetChars();
  if (content.length <= budget) {
    return numberLines(content);
  }
  warnTruncation(file, content.length, 1, budget, budget);
  return numberLines(content.slice(0, budget) + TRUNCATION_MARKER);
}

/** Render the slice list using the same `--- SOURCE: ---` headers the LLM is taught to read. */
function formatSlices(slices: SourceSlice[]): string {
  return slices
    .map((s) => `--- SOURCE: ${s.file} ---\n\n${numberLines(s.content)}`)
    .join("\n\n");
}

/** Emit a single, actionable warning when the budget kicks in for a concept. */
function warnTruncation(
  concept: string,
  totalRaw: number,
  sourceCount: number,
  perSource: number,
  budget: number,
): void {
  output.status(
    "!",
    output.warn(
      `Combined source content for "${concept}" (${totalRaw.toLocaleString()} chars across ` +
        `${sourceCount} sources) exceeds the ${budget.toLocaleString()}-char prompt budget; ` +
        `truncating each source to ~${perSource.toLocaleString()} chars. ` +
        `Raise via ${PROMPT_BUDGET_ENV_VAR} when running against larger-context models.`,
    ),
  );
}
