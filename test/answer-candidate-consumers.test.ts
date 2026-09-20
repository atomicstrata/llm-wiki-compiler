/**
 * Real import and advisory evaluation paths cannot rewrite answer candidates.
 * Metadata remains durable even when read-only projections omit audit fields.
 */
import { expect, it } from "vitest";
import { mkdir, readFile, writeFile } from "fs/promises";
import path from "path";
import { runOkfImport } from "../src/import/run.js";
import { evaluateCandidates } from "../src/eval/candidates.js";
import { writeFreshCandidate, listCandidates } from "../src/compiler/candidates.js";
import reviewReject from "../src/commands/review-reject.js";
import { reportAnswerCitations } from "../src/citations/answer-report.js";
import { useTempRoot } from "./fixtures/temp-root.js";
import { answerDraft, candidateFile, replaceCandidate } from "./fixtures/answer-candidate.js";

const root = useTempRoot();

/** Write an actual importable query bundle. */
async function queryBundle(): Promise<string> {
  const bundle = path.join(root.dir, "bundle");
  await mkdir(path.join(bundle, "queries"), { recursive: true });
  await writeFile(path.join(bundle, "queries/answer.md"), "---\ntype: query\ntitle: Answer\n---\n\nImported.\n");
  return bundle;
}

it.each([true, false])("preserves actual OKF collision behavior with import-first=%s", async importFirst => {
  const bundle = await queryBundle();
  if (importFirst) expect((await runOkfImport(root.dir, bundle)).pages).toHaveLength(1);
  const answer = await writeFreshCandidate(root.dir, answerDraft());
  const original = await readFile(candidateFile(root.dir, answer.id), "utf8");
  const report = await runOkfImport(root.dir, bundle);
  expect(report.pages).toEqual([]);
  expect(report.skipped).toContainEqual(expect.objectContaining({ slug: "answer", reason: "pending-candidate" }));
  expect(await readFile(candidateFile(root.dir, answer.id), "utf8")).toBe(original);
  expect(await listCandidates(root.dir)).toHaveLength(importFirst ? 2 : 1);
});

it("keeps evaluation advisory and skips invalid metadata without rewriting either record", async () => {
  const valid = await writeFreshCandidate(root.dir, answerDraft());
  const invalid = await writeFreshCandidate(root.dir, answerDraft());
  const original = await readFile(candidateFile(root.dir, valid.id), "utf8");
  const invalidRaw = await replaceCandidate(root.dir, invalid.id, { ...invalid, citationManifest: undefined });
  const report = await evaluateCandidates(root.dir, "fast");
  expect(report.candidates.map(candidate => candidate.id)).toEqual([valid.id]);
  expect(report.skippedCandidates).toContainEqual(expect.objectContaining({ id: invalid.id }));
  expect(await readFile(candidateFile(root.dir, valid.id), "utf8")).toBe(original);
  expect(await readFile(candidateFile(root.dir, invalid.id), "utf8")).toBe(invalidRaw);
});

it("rejects just the explicit sibling and gives retained pages precedence", async () => {
  const first = await writeFreshCandidate(root.dir, answerDraft());
  const second = await writeFreshCandidate(root.dir, answerDraft());
  const bytes = await readFile(candidateFile(root.dir, second.id), "utf8");
  await writeFile(path.join(root.dir, "wiki/queries/answer.md"), "---\ntitle: Retained\n---\n\nRetained.");
  expect((await reportAnswerCitations(root.dir, "[[answer]]")).citations).toEqual([
    { target: "answer", status: "resolved", pageId: "queries/answer" },
  ]);
  await reviewReject(first.id);
  expect((await listCandidates(root.dir)).map(candidate => candidate.id)).toEqual([second.id]);
  expect(await readFile(candidateFile(root.dir, second.id), "utf8")).toBe(bytes);
});
