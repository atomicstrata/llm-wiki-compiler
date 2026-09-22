/**
 * @file A bundle apply durably enqueues every page it created or updated for
 * embedding — BEFORE its terminal step, so a crash in that window is replayed by
 * recovery and the page is never silently absent from retrieval. A delete enqueues
 * a TOMBSTONE, so the next drain prunes the page from the store; an entity-typed
 * page is keyed exactly as the store keys it.
 */

import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { approveAndApplyOperationBundleLocked } from "../../src/operation-bundles/executor.js";
import { recoverOperationRunLocked } from "../../src/operation-bundles/recovery.js";
import { loadPendingEmbeddings, writePendingEmbeddings } from "../../src/utils/pending-embeddings.js";
import type { OperationFaultInjector } from "../../src/operation-bundles/adapter-types.js";
import {
  approveRequest, buildRuntime, parkingSourceAdapter, stageEntityPageUpdateBundle, stagePageDeleteBundle,
  stagePageDeleteThenSourceBundle, stagePageUpdateBundle,
} from "./executor-fixtures.js";

const DIR = "concepts";
const SLUG = "sparse-attention";
const V1 = Buffer.from("---\ntitle: Sparse attention\n---\n\nv1\n");
const V2 = Buffer.from("---\ntitle: Sparse attention\n---\n\nv2\n");
let root = "";

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "apply-enqueue-"));
  await mkdir(path.join(root, "wiki", DIR), { recursive: true });
  await mkdir(path.join(root, ".llmwiki"), { recursive: true });
  await writeFile(path.join(root, "wiki", DIR, `${SLUG}.md`), V1);
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

/** Apply one staged bundle to success and return the marker's page ids. */
async function applyAndMarker(staged: Awaited<ReturnType<typeof stagePageUpdateBundle>>): Promise<string[]> {
  const result = await approveAndApplyOperationBundleLocked(root, approveRequest(staged, buildRuntime()));
  expect(result.state).toBe("succeeded");
  return (await loadPendingEmbeddings(root)).map((e) => e.pageId);
}

/** Apply a page delete that CRASHES at `fault`; the delete must have landed and the tombstone must be in the marker. */
async function deleteThenCrashAt(fault: OperationFaultInjector, message: string): Promise<void> {
  const staged = await stagePageDeleteBundle(root, DIR, SLUG, V1);
  await expect(approveAndApplyOperationBundleLocked(root, approveRequest(staged, buildRuntime({ fault })))).rejects.toThrow(message);
  await expect(readFile(path.join(root, "wiki", DIR, `${SLUG}.md`))).rejects.toThrow(/ENOENT/); // the delete LANDED
  expect((await loadPendingEmbeddings(root)).map((e) => e.pageId)).toEqual([`${DIR}/${SLUG}`]);
}

describe("bundle apply enqueues applied pages for embedding", () => {
  it("APPLY-ENQUEUES: a succeeded page update leaves its qualified id in the pending marker", async () => {
    expect(await applyAndMarker(await stagePageUpdateBundle(root, DIR, SLUG, V1, V2))).toEqual([`${DIR}/${SLUG}`]);
    expect(await readFile(path.join(root, "wiki", DIR, `${SLUG}.md`), "utf8")).toContain("v2");
  });

  it("CRASH-BEFORE-TERMINAL: the marker is written ahead of the terminal step and survives recovery", async () => {
    const staged = await stagePageUpdateBundle(root, DIR, SLUG, V1, V2);
    const crashing = buildRuntime({ fault: { beforeTerminalWrite: async () => { throw new Error("crash before terminal"); } } });
    await expect(approveAndApplyOperationBundleLocked(root, approveRequest(staged, crashing))).rejects.toThrow("crash before terminal");
    expect((await loadPendingEmbeddings(root)).map((e) => e.pageId)).toEqual([`${DIR}/${SLUG}`]);
    const recovered = await recoverOperationRunLocked(root, approveRequest(staged, buildRuntime()));
    expect(recovered.state).toBe("succeeded");
    expect((await loadPendingEmbeddings(root)).map((e) => e.pageId)).toEqual([`${DIR}/${SLUG}`]);
  });

  it("DELETE-ENQUEUES-TOMBSTONE: a page delete leaves its qualified id in the marker for the drain to prune", async () => {
    expect(await applyAndMarker(await stagePageDeleteBundle(root, DIR, SLUG, V1))).toEqual([`${DIR}/${SLUG}`]);
  });

  it("ENQUEUED-BEFORE-APPLY: a crash immediately after the store seam commits the delete leaves the tombstone", async () => {
    await deleteThenCrashAt({ afterApply: async () => { throw new Error("crash after apply"); } }, "crash after apply");
  });

  it("ENQUEUED-BEFORE-VERIFY: a crash between the committed delete and its verify read leaves the tombstone", async () => {
    await deleteThenCrashAt({ beforeVerify: async () => { throw new Error("crash before verify"); } }, "crash before verify");
  });

  it("MARKER-UNWRITABLE-PARKS: when the marker cannot be persisted, the delete is NOT applied and the run parks", async () => {
    await mkdir(path.join(root, ".llmwiki", "pending-embeddings.json")); // a planted directory at the marker path
    const staged = await stagePageDeleteBundle(root, DIR, SLUG, V1);
    const result = await approveAndApplyOperationBundleLocked(root, approveRequest(staged, buildRuntime()));
    expect(result.state).toBe("recovery-required");
    expect(await readFile(path.join(root, "wiki", DIR, `${SLUG}.md`), "utf8")).toContain("v1"); // the page is still there
  });

  it("UNREADABLE-EXISTING-MARKER: an unreadable marker parks the run before the effect and is never replaced", async () => {
    await writePendingEmbeddings(root, [{ pageId: "concepts/older", attempts: 0 }]);
    const marker = path.join(root, ".llmwiki", "pending-embeddings.json");
    await chmod(marker, 0o000);
    try {
      const staged = await stagePageDeleteBundle(root, DIR, SLUG, V1);
      const result = await approveAndApplyOperationBundleLocked(root, approveRequest(staged, buildRuntime()));
      expect(result.state).toBe("recovery-required");
      expect(await readFile(path.join(root, "wiki", DIR, `${SLUG}.md`), "utf8")).toContain("v1"); // the page is still there
    } finally {
      await chmod(marker, 0o600);
    }
    // The older refresh survived: the marker was neither replaced nor emptied.
    expect((await loadPendingEmbeddings(root)).map((e) => e.pageId)).toEqual(["concepts/older"]);
  });

  it("PARKED-AFTER-DELETE: a bundle that deletes a page and then parks still leaves the tombstone", async () => {
    const staged = await stagePageDeleteThenSourceBundle(root, DIR, SLUG, V1);
    const result = await approveAndApplyOperationBundleLocked(root, approveRequest(staged, buildRuntime({ source: parkingSourceAdapter() })));
    expect(result.state).toBe("recovery-required");
    expect((await loadPendingEmbeddings(root)).map((e) => e.pageId)).toEqual([`${DIR}/${SLUG}`]);
  });

  it("ENTITY-TARGET: an entity-typed page update is keyed <entityType>/<slug>", async () => {
    await mkdir(path.join(root, "wiki", "papers"), { recursive: true });
    await writeFile(path.join(root, "wiki", "papers", `${SLUG}.md`), V1);
    expect(await applyAndMarker(await stageEntityPageUpdateBundle(root, "papers", SLUG, V1, V2))).toEqual([`papers/${SLUG}`]);
  });
});
