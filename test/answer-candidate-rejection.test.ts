/**
 * Invalid metadata stays non-promotable and recoverable by explicit safe id.
 * Rejection preserves original bytes and obeys the existing review lock.
 */
import { afterEach, expect, it, vi } from "vitest";
import { readFile, readdir, symlink, unlink, writeFile } from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import { writeCandidate, writeFreshCandidate, listCandidates } from "../src/compiler/candidates.js";
import { CandidateCustodyUnavailableError } from "../src/compiler/candidate-custody.js";
import reviewShow from "../src/commands/review-show.js";
import reviewApprove from "../src/commands/review-approve.js";
import reviewReject from "../src/commands/review-reject.js";
import { reportAnswerCitations } from "../src/citations/answer-report.js";
import { collectStatus } from "../src/status/collect.js";
import * as lock from "../src/utils/lock.js";
import * as output from "../src/utils/output.js";
import { useTempRoot } from "./fixtures/temp-root.js";
import { answerDraft, candidateFile, replaceCandidate } from "./fixtures/answer-candidate.js";

const root = useTempRoot();
afterEach(() => { process.exitCode = 0; });

/** Persist unsupported metadata and return its exact original bytes. */
async function invalidCandidate() {
  const candidate = await writeFreshCandidate(root.dir, answerDraft());
  const raw = await replaceCandidate(root.dir, candidate.id, { ...candidate,
    id: "../untrusted", candidateKind: { name: "validated-answer", version: 99 } });
  return { id: candidate.id, raw };
}

it.each([reviewShow, reviewApprove])("targeted %s refuses invalid kind and leaves wiki and candidate unchanged", async command => {
  const { id, raw } = await invalidCandidate();
  const status = vi.spyOn(output, "status").mockImplementation(() => {});
  await command(id);
  expect(process.exitCode).toBe(1);
  expect(status.mock.calls.flat().join(" ")).toContain("InvalidCandidateMetadata");
  expect(status.mock.calls.flat().join(" ")).not.toContain("not found");
  expect(await readFile(candidateFile(root.dir, id), "utf8")).toBe(raw);
  expect(await readdir(path.join(root.dir, "wiki/queries"))).toEqual([]);
});

it("archives invalid metadata by raw file id under lock with exact original bytes", async () => {
  const { id, raw } = await invalidCandidate();
  const acquire = vi.spyOn(lock, "acquireLock");
  const release = vi.spyOn(lock, "releaseLock");
  await reviewReject(id);
  expect(acquire).toHaveBeenCalledTimes(1);
  expect(release).toHaveBeenCalledTimes(1);
  expect(existsSync(candidateFile(root.dir, id))).toBe(false);
  expect(await readFile(path.join(root.dir, ".llmwiki/candidates/archive", `${id}.json`), "utf8")).toBe(raw);
  expect(await readdir(path.join(root.dir, "wiki/queries"))).toEqual([]);
  expect(await readdir(path.join(root.dir, "wiki/concepts"))).toEqual([]);
});

it("keeps report, status, listing and generic writes usable beside invalid metadata", async () => {
  const { id, raw } = await invalidCandidate();
  expect(await listCandidates(root.dir)).toEqual([]);
  expect(await reportAnswerCitations(root.dir, "[[answer]]")).toEqual({ version: 1,
    citations: [{ target: "answer", status: "broken" }] });
  expect((await collectStatus(root.dir)).pendingCandidates).toBe(0);
  const generic = await writeCandidate(root.dir, { title: "Answer", slug: "answer", summary: "",
    sources: [], body: "Generic", targetDirectory: "queries" });
  expect(generic.id).not.toBe(id);
  expect(await readFile(candidateFile(root.dir, id), "utf8")).toBe(raw);
});

it("retains invalid bytes when the review lock is unavailable", async () => {
  const { id, raw } = await invalidCandidate();
  const acquire = vi.spyOn(lock, "acquireLock").mockResolvedValue(false);
  await reviewReject(id);
  expect(acquire).toHaveBeenCalledTimes(1);
  expect(process.exitCode).toBe(1);
  expect(await readFile(candidateFile(root.dir, id), "utf8")).toBe(raw);
});

it("refuses a file removed between the precheck and lock acquisition", async () => {
  const { id } = await invalidCandidate();
  const acquire = vi.spyOn(lock, "acquireLock").mockImplementation(async () => {
    await unlink(candidateFile(root.dir, id));
    return true;
  });
  await reviewReject(id);
  expect(acquire).toHaveBeenCalledTimes(1);
  expect(process.exitCode).toBe(1);
  expect(existsSync(path.join(root.dir, ".llmwiki/candidates/archive", `${id}.json`))).toBe(false);
});

it("refuses missing and unsafe raw ids", async () => {
  await reviewReject("missing");
  expect(process.exitCode).toBe(1);
  await expect(reviewReject("../outside")).rejects.toMatchObject({ name: "UnsafeCandidateIdError" });
});

it("refuses a candidate symlink to another regular in-project file", async () => {
  const { id } = await invalidCandidate();
  const retained = path.join(root.dir, "wiki/queries/retained.md");
  await writeFile(retained, "Retained bytes");
  await unlink(candidateFile(root.dir, id));
  await symlink(retained, candidateFile(root.dir, id));
  await expect(reviewReject(id)).rejects.toBeInstanceOf(CandidateCustodyUnavailableError);
  expect(await readFile(retained, "utf8")).toBe("Retained bytes");
});

it("approval rechecks invalid metadata introduced while waiting for its lock", async () => {
  const candidate = await writeFreshCandidate(root.dir, answerDraft());
  const status = vi.spyOn(output, "status").mockImplementation(() => {});
  vi.spyOn(lock, "acquireLock").mockImplementation(async () => {
    await replaceCandidate(root.dir, candidate.id, { ...candidate, candidateKind: { name: "other", version: 1 } });
    return true;
  });
  await reviewApprove(candidate.id);
  expect(process.exitCode).toBe(1);
  expect(status.mock.calls.flat().join(" ")).toContain("InvalidCandidateMetadata");
  expect(existsSync(candidateFile(root.dir, candidate.id))).toBe(true);
  expect(await readdir(path.join(root.dir, "wiki/queries"))).toEqual([]);
});

it("rejection rechecks a symlink substituted while waiting for its lock", async () => {
  const { id } = await invalidCandidate();
  const sibling = await writeFreshCandidate(root.dir, answerDraft());
  const bytes = await readFile(candidateFile(root.dir, sibling.id), "utf8");
  vi.spyOn(lock, "acquireLock").mockImplementation(async () => {
    await unlink(candidateFile(root.dir, id));
    await symlink(candidateFile(root.dir, sibling.id), candidateFile(root.dir, id));
    return true;
  });
  await expect(reviewReject(id)).rejects.toBeInstanceOf(CandidateCustodyUnavailableError);
  expect(await readFile(candidateFile(root.dir, sibling.id), "utf8")).toBe(bytes);
});
