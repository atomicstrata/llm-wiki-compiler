/**
 * Canonical query serialization witnesses pin the pre-extraction saved bytes.
 * Frontmatter metadata must never become answer-body citation diagnostics.
 */
import { expect, it } from "vitest";
import { buildFrontmatter, parseFrontmatter } from "../src/utils/markdown.js";
import { summarizeAnswer } from "../src/commands/query-save.js";
import { classifyAnswerCitations } from "../src/citations/answer-report.js";

it.each([
  "---\n[[Alpha]]\n---\n[[Beta]]",
  "First [[Alpha]].\r\n\r\n[[Beta]]\r\n",
  "`[[summary-only]]`\n\n[[Alpha]]",
  "",
])("preserves saved bytes and parses only the outer frontmatter: %s", async (answer) => {
  const { buildQueryDocument } = await import("../src/commands/query-document.js");
  const question = "Question [[title-only]]";
  const createdAt = "2026-09-18T00:00:00.000Z";
  const frontmatter = buildFrontmatter({
    title: question, summary: summarizeAnswer(answer), type: "query", createdAt,
  });
  const originalDocument = `${frontmatter}\n\n${answer}\n`;
  const result = buildQueryDocument(question, answer, createdAt);
  expect(result.document).toBe(originalDocument);
  expect(result.body).toBe(parseFrontmatter(originalDocument).body);
  expect(result.body).toBe(`\n${answer}\n`);
  const targets = classifyAnswerCitations(result.body, { retained: [], pending: [] }).citations;
  expect(targets.map(({ target }) => target)).not.toContain("title-only");
  expect(targets.map(({ target }) => target)).not.toContain("summary-only");
});
