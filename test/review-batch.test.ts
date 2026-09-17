/**
 * Batch approval invariants against real planners and wiki files: one global
 * tail, independent refusals, conflict handling, target routing, and body pins.
 * Provider calls are disabled except for the explicit shared-drain test.
 */
import { expect, it, vi } from "vitest";
import { readFile, writeFile } from "fs/promises";
import path from "path";
import * as candidates from "../src/compiler/candidates.js";
import * as finalizer from "../src/commands/review-finalize.js";
import * as locks from "../src/utils/lock.js";
import * as indexgen from "../src/compiler/indexgen.js";
import * as embeddings from "../src/utils/embeddings.js";
import { readState, writeState } from "../src/utils/state.js";
import { sha256Text } from "../src/connectors/hash.js";
import { MAX_SOURCE_CHARS } from "../src/utils/constants.js";
import { entityId } from "../src/profile/identity.js";
import { appendRelation } from "../src/relations/store.js";
import { loadPendingEmbeddings, writePendingEmbeddings } from "../src/utils/pending-embeddings.js";
import { useTempRoot } from "./fixtures/temp-root.js";
import { buildResearchLiteProject, gatedResearchProfile, writeProfileFile, writeMarkdownPage } from "./fixtures/profile-fixtures.js";
import { approveBatch, stageBatchCandidate, useQuietBatchTests } from "./fixtures/review-batch.js";

const root = useTempRoot();
useQuietBatchTests();

it("takes one lock and finalizes one time for valid unique IDs", async () => {
  const a = await stageBatchCandidate(root.dir, "alpha");
  const b = await stageBatchCandidate(root.dir, "beta");
  const lock = vi.spyOn(locks, "acquireLock");
  const finalize = vi.spyOn(finalizer, "finalizeReviewApprovals");
  const result = await approveBatch(root.dir, a.id, b.id, a.id);
  expect(result.status).toBe("completed");
  expect(result.finalized).toBe(true);
  expect(result.results.map((item) => item.id)).toEqual([a.id, b.id]);
  expect(lock).toHaveBeenCalledTimes(1);
  expect(finalize).toHaveBeenCalledTimes(1);
  expect(await candidates.listCandidates(root.dir)).toEqual([]);
  expect(result.timingsMs).toEqual(expect.objectContaining({ index: expect.any(Number), cleanup: expect.any(Number) }));
});

it("links new pages mutually while retaining references to existing pages", async () => {
  await writeFile(path.join(root.dir, "wiki/concepts/existing.md"), "---\ntitle: Existing Topic\n---\nText.\n");
  const a = await stageBatchCandidate(root.dir, "alpha", { body: "---\ntitle: Alpha Topic\n---\nBeta Topic and Existing Topic.\n" });
  const b = await stageBatchCandidate(root.dir, "beta", { body: "---\ntitle: Beta Topic\n---\nAlpha Topic.\n" });
  await approveBatch(root.dir, a.id, b.id);
  const alpha = await readFile(path.join(root.dir, "wiki/concepts/alpha.md"), "utf8");
  expect(alpha).toContain("[[beta|Beta Topic]]");
  expect(alpha).toContain("[[existing|Existing Topic]]");
  expect(await readFile(path.join(root.dir, "wiki/concepts/beta.md"), "utf8")).toContain("[[alpha|Alpha Topic]]");
});

it("keeps invalid candidates while union-merging only approved shared-source slugs", async () => {
  const entry = { hash: "old", concepts: ["existing"], compiledAt: "before" };
  await writeState(root.dir, { version: 1, indexHash: "", sources: { "source.md": entry } });
  const sourceStates = { "source.md": { ...entry, hash: "new", concepts: ["held"] } };
  const a = await stageBatchCandidate(root.dir, "alpha", { sourceStates });
  const b = await stageBatchCandidate(root.dir, "beta", { sourceStates });
  const held = await stageBatchCandidate(root.dir, "held", { body: "no frontmatter", sourceStates });
  const result = await approveBatch(root.dir, a.id, held.id, b.id, "missing");
  expect(result.status).toBe("partial");
  expect(result.results.map((item) => item.status)).toEqual(["approved", "invalid", "approved", "invalid"]);
  expect((await readState(root.dir)).sources["source.md"].concepts).toEqual(["existing", "alpha", "beta"]);
  expect(await candidates.readCandidate(root.dir, held.id)).not.toBeNull();
});

it("skips global finalization when no candidate is valid", async () => {
  const generate = vi.spyOn(indexgen, "generateIndex");
  const result = await approveBatch(root.dir, "../unsafe", "missing");
  expect(result.results.map((item) => item.status)).toEqual(["invalid", "invalid"]);
  expect(result.finalized).toBe(false);
  expect(generate).not.toHaveBeenCalled();
});

it("refuses all competing targets while approving unrelated candidates", async () => {
  const first = await stageBatchCandidate(root.dir, "same");
  const second = await candidates.writeFreshCandidate(root.dir, { ...first, body: first.body + "Changed." });
  const unrelated = await stageBatchCandidate(root.dir, "other");
  const result = await approveBatch(root.dir, first.id, unrelated.id, second.id);
  expect(result.results.map((item) => item.status)).toEqual(["conflict", "approved", "conflict"]);
  expect(await candidates.listCandidates(root.dir)).toHaveLength(2);
});

it("rejects stale hashes and inconsistent pins on duplicate IDs", async () => {
  const a = await stageBatchCandidate(root.dir, "alpha");
  const b = await stageBatchCandidate(root.dir, "beta");
  const result = await approveBatch(root.dir,
    { id: a.id, draftContentHash: "stale" }, { id: b.id },
    { id: b.id, draftContentHash: sha256Text(b.body) });
  expect(result.results.map((item) => item.status)).toEqual(["invalid", "conflict"]);
  expect(result.finalized).toBe(false);
});

it("normalizes malformed directory metadata before detecting target conflicts", async () => {
  const a = await stageBatchCandidate(root.dir, "same");
  const b = await candidates.writeFreshCandidate(root.dir, a);
  await writeFile(path.join(root.dir, ".llmwiki/candidates", `${b.id}.json`),
    JSON.stringify({ ...b, targetDirectory: "other", targetEntityType: "" }));
  const result = await approveBatch(root.dir, a.id, b.id);
  expect(result.results.map((item) => item.status)).toEqual(["conflict", "conflict"]);
  expect(result.results.map((item) => item.pagePath)).toEqual(["wiki/concepts/same.md", "wiki/concepts/same.md"]);
});

it("requires connector operator pins and accepts the under-lock body hash", async () => {
  const a = await stageBatchCandidate(root.dir, "connector", { reviewMode: "connector" });
  const refused = await approveBatch(root.dir, a.id);
  expect(refused.results[0].status).toBe("invalid");
  const approved = await approveBatch(root.dir, { id: a.id, draftContentHash: sha256Text(a.body) });
  expect(approved.results[0].status).toBe("approved");
});

it("preserves typed/query namespaces and never puts typed slugs into concept state", async () => {
  await buildResearchLiteProject(root.dir);
  const typed = await stageBatchCandidate(root.dir, "shared", {
    targetEntityType: "experiments", body: "---\nruntime: cpu\n---\nBody.\n",
    sourceStates: { "source.md": { hash: "h", concepts: [], compiledAt: "before" } },
  });
  const query = await stageBatchCandidate(root.dir, "shared", { targetDirectory: "queries" });
  const result = await approveBatch(root.dir, typed.id, query.id);
  expect(result.results.map((item) => item.pagePath)).toEqual(["wiki/experiments/shared.md", "wiki/queries/shared.md"]);
  expect(result.status).toBe("completed");
  expect((await readState(root.dir)).sources).toEqual({});
});

it("refuses typed candidates when the current profile no longer declares their type", async () => {
  const typed = await stageBatchCandidate(root.dir, "typed", { targetEntityType: "papers" });
  const result = await approveBatch(root.dir, typed.id);
  expect(result.results[0].status).toBe("invalid");
  expect(await candidates.readCandidate(root.dir, typed.id)).not.toBeNull();
});

it("treats an oversized typed body as an individual refusal", async () => {
  await buildResearchLiteProject(root.dir);
  const typed = await stageBatchCandidate(root.dir, "large", {
    targetEntityType: "papers", body: "x".repeat(MAX_SOURCE_CHARS + 1),
  });
  const valid = await stageBatchCandidate(root.dir, "valid");
  const result = await approveBatch(root.dir, typed.id, valid.id);
  expect(result.results.map((item) => item.status)).toEqual(["invalid", "approved"]);
});

it("requires relation-gated typed approvals to run individually", async () => {
  const profile = gatedResearchProfile(1);
  await writeProfileFile(root.dir, profile);
  await writeMarkdownPage(root.dir, "wiki/ideas", "evidence", "---\ntitle: Evidence\n---\nText.\n");
  await writeMarkdownPage(root.dir, "wiki/experiments", "exp", "---\ntitle: Experiment\nstage: running\n---\nText.\n");
  await appendRelation(root.dir, profile, {
    type: "tests", from: entityId("experiments", "exp"), to: entityId("ideas", "evidence"), attributes: { metric: "f1" },
  });
  const gated = await stageBatchCandidate(root.dir, "exp", {
    targetEntityType: "experiments", body: "---\ntitle: Experiment\nstage: complete\n---\nText.\n",
  });
  const ordinary = await stageBatchCandidate(root.dir, "ordinary");
  const result = await approveBatch(root.dir, gated.id, ordinary.id);
  expect(result.results.map((item) => item.status)).toEqual(["invalid", "approved"]);
  expect(result.results[0].error).toContain("individually");
  expect((await approveBatch(root.dir, gated.id)).status).toBe("completed");
});

it("refreshes enabled embeddings once, including durable prior pending IDs", async () => {
  vi.stubEnv("LLMWIKI_EMBEDDINGS", "on");
  await writePendingEmbeddings(root.dir, [{ pageId: "concepts/prior", attempts: 0 }]);
  const a = await stageBatchCandidate(root.dir, "alpha");
  const b = await stageBatchCandidate(root.dir, "beta");
  const core = vi.spyOn(embeddings, "updateEmbeddingsLockedCore")
    .mockImplementation(async (_root, ids) => ({ embedded: ids, eligible: ids }));
  await approveBatch(root.dir, a.id, b.id);
  expect(core).toHaveBeenCalledTimes(1);
  expect(core.mock.calls[0][1]).toEqual(expect.arrayContaining(["concepts/prior", "concepts/alpha", "concepts/beta"]));
  expect(await loadPendingEmbeddings(root.dir)).toEqual([]);
});
