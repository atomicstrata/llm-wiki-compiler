/**
 * Publication policy witnesses exercise the strict validator with production
 * recognition and on-disk resolution, independently of generation and writes.
 */
import { beforeEach, expect, it } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { assertCitationPublication, validateCitationPublication } from "../src/citations/answer-publication.js";
import type { AnswerCitationReport } from "../src/citations/answer-types.js";
import { buildQueryDocument } from "../src/commands/query-document.js";
import { useTempRoot } from "./fixtures/temp-root.js";
import { stageCitationWorkspace } from "./fixtures/query-answer-citations.js";
import { slugify } from "../src/utils/markdown.js";

const ctx = useTempRoot();
beforeEach(() => stageCitationWorkspace(ctx.dir));

/** The query page the validated document would replace, as the save path derives it. */
const QUESTION = "[[title-only]]";
const TARGET = slugify(QUESTION);

/** Prepare exactly the document that the save path validates and writes. */
function document(answer: string): string {
  return buildQueryDocument(QUESTION, answer, "2026-09-19T00:00:00Z").document;
}

it.each(["direct", "proposal", "approval"] as const)("pure %s policy matrix", (mode) => {
  expect(() => assertCitationPublication({ version: 1, citations: [] }, mode)).not.toThrow();
  const pending: AnswerCitationReport = { version: 1, citations: [{ target: "beta", status: "pending", candidateIds: ["beta"] }] };
  if (mode === "proposal") expect(() => assertCitationPublication(pending, mode)).not.toThrow();
  else expect(() => assertCitationPublication(pending, mode)).toThrow("pending citation targets: beta");
  expect(() => assertCitationPublication({ version: 1, citations: [{ target: "gone", status: "broken" }] }, mode))
    .toThrow("broken citation targets: gone");
});

it.each(["direct", "proposal", "approval"] as const)("%s accepts resolved and empty reports", async (mode) => {
  expect((await validateCitationPublication(ctx.dir, document("[[Alpha]]"), mode, TARGET)).citations)
    .toEqual([{ target: "alpha", status: "resolved", pageId: "concepts/alpha" }]);
  expect(await validateCitationPublication(ctx.dir, document("`[[code-only]]`"), mode, TARGET))
    .toEqual({ version: 1, citations: [] });
});

it.each(["direct", "approval"] as const)("%s refuses pending targets", async (mode) => {
  await expect(validateCitationPublication(ctx.dir, document("[[BETA]] [[beta]]"), mode, TARGET))
    .rejects.toMatchObject({ code: "pending", targets: ["beta"], report: { version: 1 } });
});

it("proposal accepts pending observations without granting publication", async () => {
  expect((await validateCitationPublication(ctx.dir, document("[[beta]]"), "proposal", TARGET)).citations)
    .toEqual([{ target: "beta", status: "pending", candidateIds: ["pending-beta"] }]);
});

it.each(["direct", "proposal", "approval"] as const)("%s refuses broken targets with exact diagnostics", async (mode) => {
  await expect(validateCitationPublication(ctx.dir, document("[[BETA]] [[Gone]] [[GONE]]"), mode, TARGET))
    .rejects.toMatchObject({ code: "broken", targets: ["gone"] });
});

it("keeps exact-slug precedence over aliases and retained precedence over pending", async () => {
  await writeFile(path.join(ctx.dir, "wiki/concepts/alpha.md"), "---\naliases: [Beta, Query Exact]\n---\nBody");
  await writeFile(path.join(ctx.dir, "wiki/queries/query-exact.md"), "---\ntitle: Query\n---\nBody");
  expect((await validateCitationPublication(ctx.dir, document("[[Beta]] [[Query Exact]]"), "direct", TARGET)).citations)
    .toEqual([{ target: "beta", status: "resolved", pageId: "concepts/alpha" },
      { target: "query-exact", status: "resolved", pageId: "queries/query-exact" }]);
});

it("refuses a typed-only target rather than treating it as retained", async () => {
  await mkdir(path.join(ctx.dir, "wiki/papers"));
  await writeFile(path.join(ctx.dir, "wiki/papers/typed-only.md"), "---\ntitle: Typed\n---\nBody");
  await expect(validateCitationPublication(ctx.dir, document("[[Typed Only]]"), "direct", TARGET))
    .rejects.toMatchObject({ code: "broken", targets: ["typed-only"] });
});
