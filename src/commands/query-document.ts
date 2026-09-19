/**
 * Canonical saved-query document preparation shared by reporting and saving.
 * Keep the existing serialized bytes, including answer line endings and trailing
 * newline; parse only the outer generated frontmatter to locate the answer body.
 */
import { buildFrontmatter, parseFrontmatter } from "../utils/markdown.js";

/** Build a query document and the exact body the production reader sees. */
export function buildQueryDocument(
  question: string, answer: string, createdAt: string,
): { document: string; body: string } {
  const frontmatter = buildFrontmatter({
    title: question, summary: summarizeAnswer(answer), type: "query", createdAt,
  });
  const document = `${frontmatter}\n\n${answer}\n`;
  return { document, body: parseFrontmatter(document).body };
}

/**
 * Generate the existing one-line query summary for the wiki index.
 * Takes the first sentence (up to 120 chars) for page-selection retrieval signal.
 */
export function summarizeAnswer(answer: string): string {
  const firstLine = answer.trim().split(/\n/)[0] ?? "";
  const firstSentence = firstLine.split(/(?<=[.!?])\s/)[0] ?? firstLine;
  return firstSentence.slice(0, 120);
}
