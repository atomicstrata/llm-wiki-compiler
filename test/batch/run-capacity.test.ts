/**
 * @file test/batch/run-capacity.test.ts
 * @description Exercise the real selector and listing at the old and
 * current indexed-entry boundaries. Only cstate and run manifests reside on disk.
 * The fixture stops at the local detect checkpoint, before provider work.
 */

import { afterEach, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runListing } from "../../src/compiler/batch/detect.js";
import { selectRun } from "../../src/compiler/batch/run-select.js";
import { BatchRun, runIds } from "../../src/compiler/batch/run-store.js";
import { importCompileState } from "../../src/cstate/import.js";
import { INDEXED_DIR } from "../../src/segments/contracts.js";
import { diskLocalReads } from "../../src/storage/disk-local-reads.js";

const OLD_LIMIT = 1_024;
const STORE_LIMIT = 10_000;
const owned: string[] = [];

/** Use only a private project's local compile state and empty source tree. */
async function project() {
  const root = await fs.mkdtemp(path.join(tmpdir(), "llmwiki-run-capacity-"));
  owned.push(root);
  await importCompileState(root);
  return { root, reads: diskLocalReads(root), policy: "capacity-fixture", batchSize: 10, restart: false };
}

/** Supply inert directory entries at the filesystem iterator for this project only. */
function directorySlots(root: string) {
  const indexed = path.join(root, INDEXED_DIR);
  const open = fs.opendir;
  let extra = 0;
  const spy = spyOn(fs, "opendir").mockImplementation(async (target, options) => {
    const dir = await open(target, options);
    if (target !== indexed) return dir;
    const actual = dir[Symbol.asyncIterator].bind(dir);
    dir[Symbol.asyncIterator] = async function* () {
      yield* { [Symbol.asyncIterator]: actual };
      for (let slot = 0; slot < extra; slot++) {
        yield {
          name: `fixture-${slot}`, parentPath: indexed, path: indexed,
          isDirectory: () => true, isSymbolicLink: () => false, isFile: () => false,
          isBlockDevice: () => false, isCharacterDevice: () => false, isFIFO: () => false, isSocket: () => false,
        };
      }
      return undefined;
    };
    return dir;
  });
  return {
    async fill(total: number) { extra = total - (await fs.readdir(indexed)).length; },
    async count() { return (await fs.readdir(indexed)).length + extra; },
    restore: () => spy.mockRestore(),
  };
}

/** Read back the ordinary listing checkpoint without running subsequent phases. */
async function listThroughCheckpoint(run: BatchRun): Promise<void> {
  await runListing(run, run.root, diskLocalReads(run.root));
  const saved = await BatchRun.open(run.root, run.runId);
  expect(saved.meta.phase).toBe("detect");
  expect(saved.meta.checkpoint).toBeGreaterThanOrEqual(2);
}

afterEach(async () => {
  for (const root of owned.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

/** Check full-capacity refusal without any loss of the active run or its attempts. */
async function assertFullRefusals(req: Awaited<ReturnType<typeof project>>, last: BatchRun, slots: ReturnType<typeof directorySlots>): Promise<void> {
  const resumed = await selectRun(req);
  expect(resumed.runId).toBe(last.runId);
  const before = (await BatchRun.open(req.root, last.runId)).meta;
  await expect(selectRun({ ...req, restart: true })).rejects.toMatchObject({
    code: "compile_batch_run_active", message: expect.stringContaining("resume"),
  });
  expect((await BatchRun.open(req.root, last.runId)).meta).toEqual(before);

  const priorIds = await runIds(req.root);
  await resumed.advance("done");
  await expect(selectRun(req)).rejects.toMatchObject({
    code: "compile_batch_run_unknown", message: expect.stringContaining("catalog runs"),
  });
  expect(await runIds(req.root)).toEqual(priorIds);
  expect(await slots.count()).toBe(STORE_LIMIT);
}

/** Recover the old overflow, restart into the last slot, and check both guards. */
it("recovers old overflow and preserves a full inventory on creation refusal", async () => {
  const req = await project();
  const slots = directorySlots(req.root);
  try {
    await slots.fill(OLD_LIMIT);
    const stranded = await selectRun(req);
    expect(await runIds(req.root)).toEqual([stranded.runId]);
    const resumed = await selectRun(req);
    expect(resumed.runId).toBe(stranded.runId);
    await listThroughCheckpoint(resumed);

    await slots.fill(STORE_LIMIT - 1);
    const replacement = await selectRun({ ...req, restart: true });
    expect(replacement.runId).not.toBe(stranded.runId);
    expect((await BatchRun.open(req.root, stranded.runId)).meta.phase).toBe("superseded");
    expect(await slots.count()).toBe(STORE_LIMIT);
    await listThroughCheckpoint(replacement);
    await assertFullRefusals(req, replacement, slots);
  } finally {
    slots.restore();
  }
});
