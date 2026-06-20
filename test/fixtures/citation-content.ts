/**
 * Shared test fixture for building numbered source content strings.
 *
 * Produces content in the same format that `buildBudgetedCombinedContent`
 * emits (right-aligned 1-indexed line numbers, e.g. ` 1 | line 1`).
 * Used by citation-normalize and page-renderer-citation-normalize tests.
 */

/**
 * Build a minimal `combinedContent` string resembling what
 * `buildBudgetedCombinedContent` produces for a given source file and N lines.
 * @param file - Source filename (e.g. "karpathy.md").
 * @param lineCount - Number of lines to include.
 * @returns Combined content string with numbered lines.
 */
export function makeNumberedContent(file: string, lineCount: number): string {
  const width = String(lineCount).length;
  const numbered = Array.from(
    { length: lineCount },
    (_, i) => `${String(i + 1).padStart(width)} | line ${i + 1}`,
  ).join("\n");
  return `--- SOURCE: ${file} ---\n\n${numbered}`;
}
