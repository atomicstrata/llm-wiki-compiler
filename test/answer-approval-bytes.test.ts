/**
 * Approval preserves the exact validated document, skips answer-only repair
 * hazards, refreshes retrieval artifacts and handles siblings by explicit ID.
 */
import { expect, it, vi } from "vitest";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import approve from "../src/commands/review-approve.js";
import reject from "../src/commands/review-reject.js";
import { maybeSaveQueryPage } from "../src/commands/query-publication.js";
import { updateEmbeddingsLockedCore } from "../src/utils/embeddings.js";
import { usePublicationRoot, propose, candidateBytes, retained, expectApprovalRefused, approvePage } from "./fixtures/publication-review.js";
import * as planner from "../src/trust/planner.js";

const root = usePublicationRoot();
it("publishes exact direct-save bytes, leaves same-slug concept unchanged and refreshes index MOC embeddings", async () => {
  await retained(root.dir, "graph-theory");
  const sameSlug = path.join(root.dir, "wiki/concepts/answer.md");
  const original = "---\ntitle: Answer\n---\nMentions graph-theory and [[graph]].\n";
  await writeFile(sameSlug, original);
  const candidate = await propose(root.dir, "[[Alpha]]\r\nMentions graph-theory.\r\n");
  await maybeSaveQueryPage({ root: root.dir, question: "Direct", answer: "unused", document: candidate.body, save: true });
  expect(await approvePage(root.dir, candidate))
    .toBe(await readFile(path.join(root.dir, "wiki/queries/direct.md"), "utf8"));
  expect(await readFile(sameSlug, "utf8")).toBe(original);
  expect(await readFile(path.join(root.dir, "wiki/index.md"), "utf8")).toContain("answer");
  expect(await readFile(path.join(root.dir, "wiki/MOC.md"), "utf8")).toContain("answer");
  expect(updateEmbeddingsLockedCore).toHaveBeenCalledWith(expect.any(String), ["queries/answer"], expect.any(Function));
  await expect(candidateBytes(root.dir, candidate.id)).rejects.toMatchObject({ code: "ENOENT" });
});

it("refuses planner byte drift before applying any answer write", async () => {
  const candidate = await propose(root.dir);
  const originalPlan = planner.planPageMutation;
  vi.spyOn(planner, "planPageMutation").mockImplementation(async (input) => {
    const result = await originalPlan(input);
    result.planned[0].body += "Drift\n";
    return result;
  });
  const before = await candidateBytes(root.dir, candidate.id);
  await expectApprovalRefused(root.dir, candidate, before);
});

it("refuses a sibling whose target precondition went stale after another sibling landed, retaining every proposal", async () => {
  const first = await propose(root.dir, "First [[Alpha]]");
  const second = await propose(root.dir, "Second [[Alpha]]");
  const unused = await propose(root.dir, "Unused [[Alpha]]");
  const secondBytes = await candidateBytes(root.dir, second.id);
  const unusedBytes = await candidateBytes(root.dir, unused.id);
  const target = path.join(root.dir, "wiki/queries/answer.md");
  expect(await approvePage(root.dir, first)).toBe(first.body);
  process.exitCode = 0;
  await approve(second.id);
  expect(process.exitCode).toBe(1);
  const messages = vi.mocked(console.log).mock.calls.flat().map(String);
  expect(messages.some(line => line.includes("target page changed since this answer was staged"))).toBe(true);
  expect(await readFile(target, "utf8")).toBe(first.body);
  expect(await candidateBytes(root.dir, second.id)).toBe(secondBytes);
  expect(await candidateBytes(root.dir, unused.id)).toBe(unusedBytes);
  const retainedLink = await propose(root.dir, "[[Answer]]", "Sibling reader");
  expect(retainedLink.citationManifest!.citations[0].status).toBe("resolved");
  process.exitCode = 0;
  await reject(unused.id);
  expect(await readFile(target, "utf8")).toBe(first.body);
  expect(await candidateBytes(root.dir, second.id)).toBe(secondBytes);
});

it("warns before replacing an unchanged existing query and refuses once the target is deleted", async () => {
  const first = await propose(root.dir, "First [[Alpha]]");
  const target = path.join(root.dir, "wiki/queries/answer.md");
  expect(await approvePage(root.dir, first)).toBe(first.body);
  const replacement = await propose(root.dir, "Replacement [[Alpha]]");
  expect(replacement.expectedTargetHash).toBeTypeOf("string");
  vi.mocked(console.log).mockImplementation((...args) => {
    if (args.join(" ").includes("Replacing existing query wiki/queries/answer.md")) {
      expect(readFileSync(target, "utf8")).toBe(first.body);
    }
  });
  expect(await approvePage(root.dir, replacement)).toBe(replacement.body);
  const messages = vi.mocked(console.log).mock.calls.flat().map(String);
  expect(messages.some(line => line.includes("Replacing existing query wiki/queries/answer.md"))).toBe(true);
  const orphaned = await propose(root.dir, "Orphaned [[Alpha]]");
  const orphanedBytes = await candidateBytes(root.dir, orphaned.id);
  await unlink(target);
  process.exitCode = 0;
  await approve(orphaned.id);
  expect(process.exitCode).toBe(1);
  await expect(readFile(target)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await candidateBytes(root.dir, orphaned.id)).toBe(orphanedBytes);
});

it("propagates a real index refresh failure after the page write and retains the candidate", async () => {
  const candidate = await propose(root.dir);
  await unlink(path.join(root.dir, "wiki/index.md"));
  await mkdir(path.join(root.dir, "wiki/index.md"));
  await expect(approve(candidate.id)).rejects.toMatchObject({ code: "EISDIR" });
  expect(await readFile(path.join(root.dir, "wiki/queries/answer.md"), "utf8")).toBe(candidate.body);
  expect(await candidateBytes(root.dir, candidate.id)).toContain(candidate.id);
});
