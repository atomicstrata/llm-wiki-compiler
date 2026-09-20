/**
 * Fail-closed versioned answer metadata, while retaining tolerant queue reads.
 * These witnesses exercise disk admission rather than only a schema helper.
 */
import { expect, it, vi } from "vitest";
import { readFile } from "fs/promises";
import { writeCandidate, writeFreshCandidate, readCandidate, listCandidates,
countCandidates, listCandidatePage, loadCandidateOrFail } from "../src/compiler/candidates.js";
import { readCandidateSnapshot } from "../src/compiler/candidate-read.js";
import { InvalidCandidateMetadataError } from "../src/citations/answer-manifest.js";
import * as output from "../src/utils/output.js";
import { useTempRoot } from "./fixtures/temp-root.js";
import { answerDraft, candidateFile, replaceCandidate } from "./fixtures/answer-candidate.js";

const root = useTempRoot();

it("round trips the exact kind and manifest through all consumed reads", async () => {
  const draft = answerDraft();
  const created = await writeFreshCandidate(root.dir, draft);
  expect(created).toMatchObject(draft);
  expect(await readCandidate(root.dir, created.id)).toEqual(created);
  expect((await readCandidateSnapshot(root.dir, created.id))?.candidate).toEqual(created);
  expect((await listCandidates(root.dir))[0]).toEqual(created);
  expect((await listCandidatePage(root.dir, 10)).candidates).toEqual([created]);
  expect(await readFile(candidateFile(root.dir, created.id), "utf8")).toBe(JSON.stringify(created, null, 2));
});

it("preserves legacy bytes and omission of both additive fields", async () => {
  const draft = { title: "Old", slug: "old", summary: "", sources: [], body: "Old body" };
  const created = await writeCandidate(root.dir, draft);
  const expected = { id: created.id, ...draft, generatedAt: created.generatedAt,
    reviewMode: "forced", heldReasons: [{ code: "manual-review-requested" }] };
  expect(await readFile(candidateFile(root.dir, created.id), "utf8")).toBe(JSON.stringify(expected, null, 2));
  expect(await readCandidate(root.dir, created.id)).toEqual(expected);
});

it.each([
  ["unsupported kind version", { candidateKind: { name: "validated-answer", version: 2 } }],
  ["unknown kind", { candidateKind: { name: "other", version: 1 } }],
  ["extra kind fields", { candidateKind: { name: "validated-answer", version: 1, extra: true } }],
  ["required manifest absent", { citationManifest: undefined }],
  ["orphan manifest", { candidateKind: undefined }],
  ["null kind", { candidateKind: null }],
  ["invalid destination", { targetDirectory: "concepts" }],
  ["typed target", { targetEntityType: "papers" }],
  ["malformed typed target", { targetEntityType: null }],
  ["imported mode", { reviewMode: "imported" }],
  ["nonempty sources", { sources: ["source.md"] }],
  ["connector provenance", { connectorProvenance: null }],
  ["source states", { sourceStates: {} }],
  ["unsafe internal id", { id: "../outside" }],
  ["mismatched internal id", { id: "other" }],
])("skips %s with a named warning and retains original bytes", async (_name, changes) => {
  const created = await writeFreshCandidate(root.dir, answerDraft());
  const raw = await replaceCandidate(root.dir, created.id, { ...created, ...changes });
  const note = vi.spyOn(output, "note").mockImplementation(() => {});
  expect(await readCandidate(root.dir, created.id)).toBeNull();
  expect(await listCandidates(root.dir, { strictIo: true })).toEqual([]);
  expect(await countCandidates(root.dir)).toBe(0);
  const targeted = readCandidate(root.dir, created.id, { rejectInvalidMetadata: true });
  await expect(targeted).rejects.toBeInstanceOf(InvalidCandidateMetadataError);
  await expect(targeted).rejects.toMatchObject({ name: "InvalidCandidateMetadataError", candidateId: created.id });
  expect(await listCandidatePage(root.dir, 10)).toEqual({ candidates: [], total: 0 });
  expect(note).toHaveBeenCalledWith(expect.stringContaining(`InvalidCandidateMetadata: ${created.id}`));
  expect(await readFile(candidateFile(root.dir, created.id), "utf8")).toBe(raw);
});

it("targeted metadata diagnostics are invalid-candidate rather than not-found", async () => {
  const created = await writeFreshCandidate(root.dir, answerDraft());
  await replaceCandidate(root.dir, created.id, { ...created, citationManifest: undefined });
  const status = vi.spyOn(output, "status").mockImplementation(() => {});
  try {
    expect(await loadCandidateOrFail(root.dir, created.id)).toBeNull();
    expect(process.exitCode).toBe(1);
    expect(status.mock.calls.flat().join(" ")).toContain("InvalidCandidateMetadata");
    expect(status.mock.calls.flat().join(" ")).not.toContain("not found");
  } finally { process.exitCode = 0; }
});

it("rejects invalid draft metadata before any write or generic canonicalization", async () => {
  const draft = answerDraft();
  const invalid = { ...draft, citationManifest: undefined };
  await expect(writeCandidate(root.dir, invalid)).rejects.toMatchObject({ name: "InvalidCandidateMetadataError" });
  expect(await listCandidates(root.dir)).toEqual([]);
});
