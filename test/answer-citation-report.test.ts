/**
 * Answer classification witnesses pin viewer precedence and normalized occurrence
 * order. Pending proposals never override retained pages or contribute aliases.
 */
import { describe, expect, it } from "vitest";
import { classifyAnswerCitations } from "../src/citations/answer-report.js";
import type { AnswerCitationIndex, RetainedCitationTarget } from "../src/citations/answer-types.js";
import { resolveBareSlug } from "../src/viewer/collect.js";

const retained: RetainedCitationTarget[] = [
  { id: "queries/alpha", pageDirectory: "queries", slug: "alpha" },
  { id: "concepts/alpha", pageDirectory: "concepts", slug: "alpha", aliases: ["Query Exact", "Alias Only"] },
  { id: "queries/query-exact", pageDirectory: "queries", slug: "query-exact", aliases: ["Alias Only", "Query Alias"] },
  { id: "concepts/second", pageDirectory: "concepts", slug: "second", aliases: ["Alias Only"] },
];

describe("classifyAnswerCitations", () => {
  it("prefers retained resolution over pending and deduplicates targets", () => {
    const index: AnswerCitationIndex = { retained, pending: [{ target: "alpha", candidateId: "pending-alpha" }] };
    expect(classifyAnswerCitations("[[Alpha]] [[Alpha|label]]", index)).toEqual({
      version: 1, citations: [{ target: "alpha", status: "resolved", pageId: "concepts/alpha" }],
    });
  });

  it.each([
    ["alpha", "concepts/alpha"], ["query-exact", "queries/query-exact"],
    ["alias-only", "concepts/alpha"], ["query-alias", "queries/query-exact"],
  ])("preserves production precedence for %s", (target, pageId) => {
    expect(resolveBareSlug(target, retained)).toBe(pageId);
    expect(classifyAnswerCitations(`[[${target}]]`, { retained, pending: [] }).citations).toEqual([
      { target, status: "resolved", pageId },
    ]);
  });

  it("keeps first occurrence order with sorted unique exact pending IDs", () => {
    const pending = [
      { target: "beta", candidateId: "z" }, { target: "beta", candidateId: "a" },
      { target: "beta", candidateId: "z" }, { target: "other", candidateId: "other" },
    ];
    expect(classifyAnswerCitations("[[Missing]] [[Beta]] [[Alpha]] [[beta]]", { retained, pending })).toEqual({
      version: 1, citations: [
        { target: "missing", status: "broken" },
        { target: "beta", status: "pending", candidateIds: ["a", "z"] },
        { target: "alpha", status: "resolved", pageId: "concepts/alpha" },
      ],
    });
  });

  it.each(["", "No citations", "`[[alpha]]` [See [[beta]]](https://example.com)"])("returns an empty report for %s", (body) => {
    expect(classifyAnswerCitations(body, { retained, pending: [] })).toEqual({ version: 1, citations: [] });
  });
});
