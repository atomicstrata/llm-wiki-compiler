/**
 * Replacement-aware citation validation. Publishing a query answer replaces
 * `wiki/queries/<slug>.md` with the answer's own document, so a link that only
 * resolved through the OLD page's aliases is broken the moment the write lands.
 * Validation must judge the answer against the index as it will be after the
 * write: the target carries the proposed document's metadata, not the page it
 * replaces. The same page still resolves by its filename slug, and links to other
 * pages are unaffected. Covered for direct save, reviewed staging, and approval
 * of a candidate whose stored manifest predates this check.
 */
import { expect, it } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { usePublicationRoot, retained, propose, approvePage, candidateBytes, expectApprovedAndCleared } from "./fixtures/publication-review.js";
import { maybeSaveQueryPage } from "../src/commands/query-publication.js";
import { stageQueryProposal } from "../src/commands/query-proposal.js";
import { buildQueryDocument } from "../src/commands/query-document.js";
import { readCandidate } from "../src/compiler/candidates.js";
import approve from "../src/commands/review-approve.js";

const root = usePublicationRoot();
const PRIOR = "---\ntitle: Prior answer\naliases: [old-evidence]\n---\nPrior evidence.\n";
const targetPath = () => path.join(root.dir, "wiki/queries/answer.md");

/** Seed the page the answer for question "Answer" would replace. */
async function seedPriorAnswer(): Promise<void> {
  await writeFile(targetPath(), PRIOR);
}

it("refuses a direct save whose only citation resolves through the replaced page's alias", async () => {
  await seedPriorAnswer();
  const result = await maybeSaveQueryPage({ root: root.dir, question: "Answer", answer: "Uses [[old-evidence]].", save: true });
  expect(result.saved).toBeUndefined();
  expect(result.publicationRefusal).toMatchObject({ code: "broken", targets: ["old-evidence"] });
  expect(await readFile(targetPath(), "utf8")).toBe(PRIOR);
});

it("refuses reviewed staging for the same replacement-broken citation", async () => {
  await seedPriorAnswer();
  const result = await maybeSaveQueryPage({ root: root.dir, question: "Answer", answer: "Uses [[old-evidence]].", save: true, review: true });
  expect(result.candidateId).toBeUndefined();
  expect(result.publicationRefusal).toMatchObject({ code: "broken", targets: ["old-evidence"] });
});

it("refuses approval of a candidate whose stored manifest recorded the alias as resolved", async () => {
  await seedPriorAnswer();
  const document = buildQueryDocument("Answer", "Uses [[old-evidence]].", "2026-09-19T00:00:00Z").document;
  const stale = { version: 1 as const, citations: [{ target: "old-evidence", status: "resolved" as const, pageId: "queries/answer" as const }] };
  const candidate = (await readCandidate(root.dir, await stageQueryProposal({ root: root.dir, question: "Answer", document, report: stale })))!;
  const before = await candidateBytes(root.dir, candidate.id);
  await approve(candidate.id);
  expect(process.exitCode).toBe(1);
  expect(await candidateBytes(root.dir, candidate.id)).toBe(before);
  expect(await readFile(targetPath(), "utf8")).toBe(PRIOR);
});

it("still resolves the replaced page by its own slug and other pages by their aliases", async () => {
  await seedPriorAnswer();
  await retained(root.dir, "evidence-page", ["kept-alias"]);
  const candidate = await propose(root.dir, "See [[answer]] and [[kept-alias]].");
  expect(candidate.citationManifest!.citations).toEqual([
    { target: "answer", status: "resolved", pageId: "queries/answer" },
    { target: "kept-alias", status: "resolved", pageId: "concepts/evidence-page" },
  ]);
  await expectApprovedAndCleared(root.dir, candidate);
});

it("directly saves over an aliased page when the answer does not depend on the removed alias", async () => {
  await seedPriorAnswer();
  const result = await maybeSaveQueryPage({ root: root.dir, question: "Answer", answer: "Uses [[Alpha]].", save: true });
  expect(result.saved).toBe("answer");
  expect(await readFile(targetPath(), "utf8")).not.toBe(PRIOR);
});

it("approves a first-time answer that links to its own future slug", async () => {
  const candidate = await propose(root.dir, "See [[answer]].");
  expect(candidate.citationManifest!.citations).toEqual([{ target: "answer", status: "resolved", pageId: "queries/answer" }]);
  expect(await approvePage(root.dir, candidate)).toBe(candidate.body);
});
