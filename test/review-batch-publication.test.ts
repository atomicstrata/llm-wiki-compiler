/**
 * Batch publication preserves generic citation policy and routes validated
 * answers to individual approval, where exact bytes are protected from the
 * generic link-repair tail. Refusals preserve candidate files and other work.
 */
import { expect, it, vi } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { approveBatch, stageBatchCandidate } from "./fixtures/review-batch.js";
import { usePublicationRoot, propose, generic, retained, candidateBytes, approvePage } from "./fixtures/publication-review.js";
import * as citations from "../src/citations/generic-publication.js";

const root = usePublicationRoot();

it("rejects a validated answer in a mixed batch and preserves it for exact single approval", async () => {
  const answer = await propose(root.dir, "[[Alpha]] and graph-theory.");
  const before = await candidateBytes(root.dir, answer.id);
  const ordinary = await stageBatchCandidate(root.dir, "ordinary");
  const result = await approveBatch(root.dir, answer.id, ordinary.id);
  expect(result.results.map(item => item.status)).toEqual(["invalid", "approved"]);
  expect(result.results[0].error).toContain("approved individually");
  expect(await candidateBytes(root.dir, answer.id)).toBe(before);
  await expect(readFile(path.join(root.dir, "wiki/queries/answer.md"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(process.exitCode).toBe(0);
  expect(await approvePage(root.dir, answer)).toBe(answer.body);
});

it("refuses an answer-only batch without running finalization", async () => {
  const answer = await propose(root.dir);
  const result = await approveBatch(root.dir, answer.id);
  expect(result.status).toBe("partial");
  expect(result.finalized).toBe(false);
  expect(result.results[0].error).toContain("review approve");
});

it.each(["missing", "ambiguous"])("refuses %s citations while allowing unrelated generic candidates", async kind => {
  if (kind === "ambiguous") {
    await retained(root.dir, "argo-cd-ownership");
    await generic(root.dir, "argo-cd-deployments", "Pending");
  }
  const bad = await generic(root.dir, "deployment", "Uses [[Argo CD]].");
  const before = await candidateBytes(root.dir, bad.id);
  const good = await generic(root.dir, "good", "Uses [[Alpha]].");
  const result = await approveBatch(root.dir, bad.id, good.id);
  expect(result.results.map(item => item.status)).toEqual(["invalid", "approved"]);
  expect(result.results[0].error).toContain("broken citation targets");
  expect(await candidateBytes(root.dir, bad.id)).toBe(before);
  await expect(readFile(path.join(root.dir, "wiki/concepts/deployment.md"))).rejects.toMatchObject({ code: "ENOENT" });
});

it("allows pending chains and production prefix repair for generic candidates", async () => {
  await retained(root.dir, "argo-cd-ownership");
  const candidate = await generic(root.dir, "deployment", "Uses [[Argo CD]] and [[beta]].");
  expect((await approveBatch(root.dir, candidate.id)).status).toBe("completed");
  expect(await readFile(path.join(root.dir, "wiki/concepts/deployment.md"), "utf8"))
    .toContain("[[argo-cd-ownership|Argo CD]]");
});

it("preserves generic warning-only behavior when citation checking is unavailable", async () => {
  const candidate = await generic(root.dir, "deployment", "Uses [[Missing]].");
  vi.spyOn(citations, "genericBrokenTargets").mockRejectedValueOnce(new Error("unavailable"));
  expect((await approveBatch(root.dir, candidate.id)).status).toBe("completed");
  expect(vi.mocked(console.log).mock.calls.flat().join(" ")).toContain("citation check unavailable");
});

it("cannot bypass validated-answer policy with malformed answer metadata", async () => {
  const answer = await propose(root.dir);
  const file = path.join(root.dir, ".llmwiki/candidates", `${answer.id}.json`);
  const malformed = { ...answer, citationManifest: undefined };
  const before = JSON.stringify(malformed);
  await writeFile(file, before);
  const result = await approveBatch(root.dir, answer.id);
  expect(result.results[0].status).toBe("invalid");
  expect(await readFile(file, "utf8")).toBe(before);
});
