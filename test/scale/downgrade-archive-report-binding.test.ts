/**
 * @file test/scale/downgrade-archive-report-binding.test.ts
 * @description An archived run report is read only from the run store
 * manifest the bound scale-down plan recorded (IDX-2), through the public
 * `readArchivedReport`.
 *
 * GENUINE BYTES: one scratch batch run of a private project is written by the
 * real run store (`BatchRun`, durable segment and manifest publication) through
 * two consistent checkpoints: an older one (phase `detect`, two report lines)
 * and the planned one (phase `done`, 501 lines, so the report pages). The older
 * checkpoint's store files are copied aside right after it is published, and
 * each checkpoint is read on its own through the ordinary `readReport`.
 *
 * CONSTRUCTED: the scale-down around it. `.llmwiki/indexed` is renamed into a
 * strictly built plan's evidence directory, the plan recording the run store's
 * manifest digest, beside a receipt cross-bound to that plan and naming the
 * archived directory's identity.
 *
 * THE SUBSTITUTION: the older checkpoint is restored beneath the UNCHANGED
 * archived indexed directory (missing older segments copied back, the manifest
 * replaced by rename, single link), so the receipt, plan, run id and cursor
 * binding all still match. The archive must refuse it, typed. A plan that
 * records no manifest for the run's store refuses the same way. No read may
 * change any file of the project.
 *
 * LABELLED SEAM: `serializeOwner` is spied to a deterministic own-PID record
 * (the `test/portable/scale-first-open.test.ts` seam) because the ordinary
 * report reads register a reader lease; no native start-time probe runs.
 */

import { createHash } from "node:crypto";
import { cp, mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { RUN_STORE_PREFIX } from "../../src/compiler/batch/contracts.js";
import { readReport, report, type ReportPageV1 } from "../../src/compiler/batch/report.js";
import { readArchivedReport } from "../../src/scale/downgrade-archive-reader.js";
import { identityAt } from "../../src/scale/downgrade-fs.js";
import { downgradeDir } from "../../src/scale/downgrade-journal.js";
import { buildDowngradePlan, serializeDowngradePlan } from "../../src/scale/downgrade-plan.js";
import { INDEXED_DIR, MANIFEST_LEAF } from "../../src/segments/contracts.js";
import * as lockOwner from "../../src/utils/lock-owner.js";
import { newScratchBatchRun } from "../batch/scratch-run.js";
import { ownPidSerializeOwnerSpy, privateRoots, restoreAll, type Restorable } from "../fixtures/scoped-test-roots.js";
import { PLANNED_ESTIMATE, plantLeaf, refusalCodeOf } from "./cancel-helpers.js";
import { entryStates } from "./fixtures/admission-fixtures.js";

/** Durable run-store commits on the test volume. */
const CASE_TIMEOUT_MS = 120_000;
/** One more report line than a report page holds (500), so the planned report pages once. */
const PLANNED_LINES = 501;
/** The fence revision of the constructed scale-down (one past its original record). */
const FENCE = 3;
/** SHA-256 of a file's exact bytes. */
const fileSha256 = async (file: string): Promise<string> => createHash("sha256").update(await readFile(file)).digest("hex");
const { privateDir, cleanup } = privateRoots("llmwiki-archive-report-");
const spies: Restorable[] = [];

beforeEach(() => { spies.push(ownPidSerializeOwnerSpy()); });
afterEach(async () => {
  restoreAll(spies);
  await cleanup();
});

/** A new private project root (removed after each case). */
const privateRoot = (): Promise<string> => privateDir();

/** One genuine run with an older and a planned checkpoint, each read on its own; the older store files are kept in `snapshot`. */
async function twoCheckpointRun(root: string, snapshot: string): Promise<{ runId: string; older: ReportPageV1; planned: ReportPageV1 }> {
  const run = await newScratchBatchRun(root);
  for (let at = 0; at < 2; at++) await report(run, { kind: "compiled", file: `older-${at}.md` });
  await run.advance("detect");
  const store = path.join(root, INDEXED_DIR, `${RUN_STORE_PREFIX}${run.runId}`);
  await cp(store, snapshot, { recursive: true });
  const older = await readReport(root, run.runId);
  for (let at = 2; at < PLANNED_LINES; at++) await report(run, { kind: "compiled", file: `planned-${at}.md` });
  await run.advance("done");
  return { runId: run.runId, older, planned: await readReport(root, run.runId) };
}

/** A completed scale-down archive holding that run; `recordStore: false` leaves the run store out of the plan's stores. */
async function archivedProject(recordStore = true) {
  const root = await privateRoot();
  const snapshot = path.join(await privateRoot(), "older-store");
  const { runId, older, planned } = await twoCheckpointRun(root, snapshot);
  const store = `${RUN_STORE_PREFIX}${runId}`;
  const manifestSha256 = await fileSha256(path.join(root, INDEXED_DIR, store, MANIFEST_LEAF));
  const runs = [{ runId, status: "done" }];
  const plan = buildDowngradePlan(root, {
    from: "local-indexed", target: "local-standard", record: { revision: FENCE - 1, sha256: "0".repeat(64) }, requested: PLANNED_ESTIMATE,
    measured: { sourceDocuments: 0, sourceBytes: 0, wikiFiles: 0, wikiBytes: 0 }, freeze: { entries: 0, bytes: 0, digest: "" },
    stores: recordStore ? [{ name: store, manifestSha256 }] : [], units: [], priors: [], runs, lastRun: runId, pins: { labels: [], digest: "" },
    capabilities: [], notices: [], blockers: [],
  });
  const dir = downgradeDir(plan, FENCE);
  await mkdir(path.join(root, dir), { recursive: true });
  await rename(path.join(root, INDEXED_DIR), path.join(root, dir, "indexed"));
  await writeFile(path.join(root, dir, "plan.json"), serializeDowngradePlan(plan));
  await plantLeaf(root, `${dir}/receipt.json`, { format: "llmwiki-scale-downgrade-receipt", version: 1, plan: plan.digest, target: "local-standard", fenceRevision: FENCE,
    archive: { indexed: await identityAt(root, `${dir}/indexed`), pins: null, stores: plan.inventory.stores.map((entry) => entry.name) }, runs, lastRun: runId, pinLabels: [], units: [], priors: [] });
  return { root, name: path.posix.basename(dir), dir, runId, storeDir: path.join(root, dir, "indexed", store), snapshot, older, planned };
}

/** Every entry under `root` with its inode, timestamps and (for a file) bytes: any change a read made shows here. */
function treeState(root: string): Promise<Record<string, string>> {
  return entryStates(root, async (file, info) => `${info.ino}:${info.mtimeNs}:${info.ctimeNs}:${info.isFile() ? await fileSha256(file) : "dir"}`);
}

/** Require the archived report read of `project` to refuse as invalid while changing nothing under its root. */
async function expectArchiveRefusedUnchanged(project: Awaited<ReturnType<typeof archivedProject>>): Promise<void> {
  const before = await treeState(project.root);
  expect(await refusalCodeOf(readArchivedReport(project.root, project.name, project.runId))).toBe("scale_downgrade_archive_invalid");
  expect(await treeState(project.root)).toEqual(before);
}

/** Restore the older checkpoint beneath the unchanged archived directory: missing older segments back, then the manifest by rename. */
async function restoreOlderCheckpoint(project: Awaited<ReturnType<typeof archivedProject>>): Promise<void> {
  const present = new Set(await readdir(project.storeDir));
  for (const name of await readdir(project.snapshot)) {
    if (name !== MANIFEST_LEAF && !present.has(name)) await cp(path.join(project.snapshot, name), path.join(project.storeDir, name));
  }
  await cp(path.join(project.snapshot, MANIFEST_LEAF), path.join(project.storeDir, "restored.tmp"));
  await rename(path.join(project.storeDir, "restored.tmp"), path.join(project.storeDir, MANIFEST_LEAF));
}

/** The older checkpoint's store, read on its own by the ordinary report reader in a fresh project. */
async function olderReadOnItsOwn(project: Awaited<ReturnType<typeof archivedProject>>): Promise<ReportPageV1> {
  const fresh = await privateRoot();
  await cp(project.storeDir, path.join(fresh, INDEXED_DIR, path.basename(project.storeDir)), { recursive: true });
  return readReport(fresh, project.runId);
}

describe("an archived report is read only from the manifest its plan recorded", () => {
  it("reads the planned checkpoint page by page, with archive cursors, changing nothing", async () => {
    const project = await archivedProject();
    const before = await treeState(project.root);
    const first = await readArchivedReport(project.root, project.name, project.runId);
    expect(first).toMatchObject({ runId: project.runId, phase: "done", lines: project.planned.lines });
    expect(first.cursor).toBe(`a1.${first.cursor!.split(".")[1]}.${project.planned.cursor}`);
    const second = await readArchivedReport(project.root, project.name, project.runId, first.cursor);
    expect(second.lines).toEqual([{ kind: "compiled", file: `planned-${PLANNED_LINES - 1}.md` }]);
    expect(second.cursor).toBeUndefined();
    expect(await treeState(project.root)).toEqual(before);
    expect(lockOwner.serializeOwner).toHaveBeenCalledWith(process.pid);
  }, CASE_TIMEOUT_MS);

  it("refuses an older checkpoint of the same run restored beneath the unchanged archive", async () => {
    const project = await archivedProject();
    expect((await readArchivedReport(project.root, project.name, project.runId)).phase).toBe("done");
    const leaves = async () => [await identityAt(project.root, `${project.dir}/indexed`), await readFile(path.join(project.root, project.dir, "plan.json"), "utf8"), await readFile(path.join(project.root, project.dir, "receipt.json"), "utf8")];
    const kept = await leaves();
    await restoreOlderCheckpoint(project);
    expect(await leaves()).toEqual(kept);
    expect(await olderReadOnItsOwn(project)).toEqual(project.older);
    expect(project.older).toMatchObject({ phase: "detect", lines: [{ kind: "compiled", file: "older-0.md" }, { kind: "compiled", file: "older-1.md" }] });
    await expectArchiveRefusedUnchanged(project);
  }, CASE_TIMEOUT_MS);

  it("refuses a plan that records no manifest for the run's store", async () => {
    const project = await archivedProject(false);
    await expectArchiveRefusedUnchanged(project);
  }, CASE_TIMEOUT_MS);
});
