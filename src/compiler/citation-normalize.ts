/**
 * Compile-time citation normalizer for the llmwiki compile pipeline.
 *
 * The LLM occasionally emits a bare line number as a citation marker,
 * e.g. `^[81]` instead of the required `^[filename.md:81]`. This module
 * repairs or removes such markers BEFORE the page body is written to disk,
 * so bad markers never reach the viewer (which would render a
 * "Source not found: 81" error callout for them).
 *
 * Design: pure function, no I/O. The caller owns the source-file list and
 * the numbered combined-content string that the LLM was given during the
 * compile prompt, so we can both repair unambiguous single-source markers
 * and validate that repaired line references are within the source's range.
 */

/** Regex matching `^[...]` citation markers — same pattern as the viewer uses. */
const MARKER_PATTERN = /\^\[([^\]\n]+)\]/g;

/** Regex matching a line number or line range with no filename component, e.g. `81` or `81-90`. */
const BARE_LINE_RANGE_PATTERN = /^\d+(?:[,-]\s*\d+)?$/;

/** Regex matching a numbered line as emitted by buildBudgetedCombinedContent: ` N | text`. */
const NUMBERED_LINE_PATTERN = /^\s*(\d+)\s*\|/;

/**
 * Return the highest line number present in `combinedContent` (the numbered
 * source text the LLM received). Returns 0 when no numbered lines are found.
 */
function maxLineNumber(combinedContent: string): number {
  let max = 0;
  for (const line of combinedContent.split("\n")) {
    const m = NUMBERED_LINE_PATTERN.exec(line);
    if (m) {
      const n = Number(m[1]);
      if (n > max) max = n;
    }
  }
  return max;
}

/**
 * Return true when the line range expressed in `entry` (e.g. "81" or "81-90")
 * is fully within [1, maxLine].
 */
function rangeIsValid(entry: string, maxLine: number): boolean {
  const parts = entry.split(/[,-]/).map((p) => Number(p.trim()));
  return parts.every((n) => n >= 1 && n <= maxLine);
}

/**
 * Normalise a single comma-separated entry from inside a `^[...]` marker.
 *
 * Returns the (possibly repaired) entry string, or null to signal the entry
 * should be dropped entirely.
 *
 * Only bare line numbers / ranges (no filename component at all) are
 * normalised here. Entries that contain a filename — even an unresolvable
 * or malformed one — are left as-is so the downstream provenance linter
 * (`broken-citation`, `malformed-claim-citation`) can classify them.
 */
function normalizeEntry(
  entry: string,
  sourceFiles: string[],
  maxLine: number,
): string | null {
  const trimmed = entry.trim();
  if (trimmed.length === 0) return null;

  // Split off the file token: everything before the first `:` or `#`.
  const fileToken = trimmed.split(/[:#]/)[0].trim();

  // Case 1: valid filename — keep as-is.
  if (sourceFiles.includes(fileToken)) return trimmed;

  // Case 2: bare line reference — purely digits/range, no filename component.
  if (BARE_LINE_RANGE_PATTERN.test(trimmed)) {
    // Single source: repair if the line is in range, drop if hallucinated.
    if (sourceFiles.length === 1) {
      if (!rangeIsValid(trimmed, maxLine)) return null;
      return `${sourceFiles[0]}:${trimmed}`;
    }
    // Multi-source: ambiguous — drop (can't know which source the LLM meant).
    return null;
  }

  // Case 3: has a filename component (even if unresolvable or malformed) — leave
  // as-is for the downstream provenance linter to handle.
  return trimmed;
}

/**
 * Rebuild a full `^[...]` marker from its surviving entries.
 * Returns null when no entries survive (signals the whole marker should be removed).
 */
function rebuildMarker(entries: string[]): string | null {
  const survivors = entries.filter((e) => e !== null) as string[];
  if (survivors.length === 0) return null;
  return `^[${survivors.join(", ")}]`;
}

/**
 * Clean every `^[...]` citation marker in `body` before the page is written.
 *
 * For each comma-separated entry inside a marker:
 * - Valid filename entries are kept unchanged.
 * - Bare line numbers/ranges (`81`, `81-90`) on a single-source page are
 *   repaired to `<sourceFile>:N` when the line is within the source's range,
 *   or dropped when the line exceeds the source's actual line count.
 * - Bare numbers on multi-source pages are dropped (ambiguous — can't determine
 *   which source the LLM intended).
 * - Entries with a filename component (even unresolvable or malformed) are left
 *   as-is for the downstream provenance linter to classify.
 *
 * When all entries in a marker are dropped the entire `^[...]` marker is
 * removed. A trailing space before the removed marker is also collapsed so
 * `word ^[81]` becomes `word` rather than `word `.
 *
 * @param body - Raw LLM output page body to normalise.
 * @param sourceFiles - Valid source filenames for this page (basenames only).
 * @param combinedContent - The numbered combined-source text the LLM received.
 * @returns The normalised body string.
 */
export function normalizeCitations(
  body: string,
  sourceFiles: string[],
  combinedContent: string,
): string {
  const maxLine = maxLineNumber(combinedContent);
  MARKER_PATTERN.lastIndex = 0;

  return body.replace(MARKER_PATTERN, (fullMatch, inner: string) => {
    const entries = inner.split(",").map((e) => normalizeEntry(e, sourceFiles, maxLine));
    const rebuilt = rebuildMarker(entries as string[]);
    if (rebuilt === null) {
      // Signal for post-replace space cleanup: return empty string; the
      // space cleanup pass below handles the dangling space.
      return "\x00REMOVED\x00";
    }
    return rebuilt;
  });
}

/**
 * Run `normalizeCitations` and also clean up dangling spaces left where a
 * marker was removed. A space immediately before a removed marker is collapsed.
 *
 * This is the public entry point used by the page renderer.
 */
export function normalizeCitationsInBody(
  body: string,
  sourceFiles: string[],
  combinedContent: string,
): string {
  const withSentinels = normalizeCitations(body, sourceFiles, combinedContent);
  // Remove sentinels and the optional preceding space.
  return withSentinels.replace(/ ?\x00REMOVED\x00/g, "");
}
