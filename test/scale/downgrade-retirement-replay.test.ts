/**
 * @file test/scale/downgrade-retirement-replay.test.ts
 * @description Intent-retirement replay through the real public
 * `applyScaleDowngrade` and `cancelScaleDowngrade`, with the real raw project
 * lock, the real retirement rename and the real directory checkpoints.
 *
 * DIRECTLY OBSERVED: the first public call really renames the live intent into
 * its evidence directory, and an injected failure of exactly one parent sync
 * (the live intent's parent, or the evidence directory) stops it there. The
 * retry must sync both parents again, in that order, before any barrier
 * cleanup, and must keep the scale record bytes and the retired inode.
 *
 * CONSTRUCTED: the committed apply state (activation record, bound receipt,
 * archived indexed directory) is planted plainly, standing for a finished
 * activation; the cancel cases start from the plain bootstrapped fixture.
 * The refusals plant a retired intent beside an uncommitted fence, and beside
 * a cancel intent with no receipt.
 *
 * ARCHIVE IDENTITY: a committed apply is proof only while its archived indexed
 * directory is still the exact object its receipt names, at the activation
 * revision as at any later one. The archive is removed, or replaced by a new
 * directory, beside a planted stale barrier of this plan (an interrupted
 * attempt's, its owner a pid that does not exist); the refused apply must
 * leave the record, barrier, receipt and both intent leaves exactly as they
 * were. The accepted replays must really remove that barrier.
 *
 * LABELLED SEAMS: `fsyncDirectoryChain` is wrapped to log each synced directory
 * and to fail one after the rename; `removeStaleBarrierOf` is wrapped to log
 * its call; `serializeOwner` is spied to a deterministic own-PID record (the
 * `test/portable/scale-first-open.test.ts` seam), so no native start-time
 * probe runs. Physical durability is not exercised.
 */

import { lstat, mkdir, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { SCALE_RECORD_FILE } from "../../src/scale/contracts.js";
import type { ScaleRecord } from "../../src/scale/contracts-v2.js";
import { applyScaleDowngrade, intentOf } from "../../src/scale/downgrade-apply.js";
import * as barrier from "../../src/scale/downgrade-barrier.js";
import { cancelScaleDowngrade } from "../../src/scale/downgrade-cancel.js";
import { identityAt } from "../../src/scale/downgrade-fs.js";
import { activationRecord } from "../../src/scale/downgrade-records.js";
import { serializeAnyScaleRecord } from "../../src/scale/record-v2-schema.js";
import * as durability from "../../src/utils/atomic-write-durability.js";
import * as lockOwner from "../../src/utils/lock-owner.js";
import { fenceAndCancelRecords, plainProject, plant, plantLeaf, refusalCodeOf, staleBarrier, type CancelProject } from "./cancel-helpers.js";
import { DURABLE_CANCEL_CASE_TIMEOUT_MS, trackDurableCancelProjects } from "./durable-cancel-lifecycle.js";

const track = trackDurableCancelProjects();
const OFFLINE = { readersOffline: true };
const LIVE_INTENT = ".llmwiki/scale-downgrade.json";
const INJECTED = "injected retirement parent sync failure";

/** What the seams saw, in order, and which parent (relative to the project) must fail once the retired leaf exists. */
const seen = { log: [] as string[], root: "", failParent: null as string | null, retired: "" };
const realSync = durability.fsyncDirectoryChain;
const realBarrier = barrier.removeStaleBarrierOf;
const spies: { mockRestore(): void }[] = [];

beforeEach(() => {
  Object.assign(seen, { log: [], root: "", failParent: null, retired: "" });
  spies.push(spyOn(lockOwner, "serializeOwner").mockImplementation((pid) => JSON.stringify({ pid })));
  spies.push(spyOn(durability, "fsyncDirectoryChain").mockImplementation(async (dir, ...rest) => {
    const parent = path.relative(seen.root, dir);
    seen.log.push(`sync:${parent}`);
    const renamed = seen.retired !== "" && (await lstat(seen.retired).then(() => true, () => false));
    if (renamed && parent === seen.failParent) throw new Error(INJECTED);
    return realSync(dir, ...rest);
  }));
  spies.push(spyOn(barrier, "removeStaleBarrierOf").mockImplementation(async (root, plan) => {
    seen.log.push("barrier");
    return realBarrier(root, plan);
  }));
});
afterEach(() => { for (const spy of spies.splice(0)) spy.mockRestore(); });

/** Point the seams at `project`; the retirement's two parents, in their checkpoint order. */
function watch(project: CancelProject): string[] {
  seen.root = project.root;
  seen.retired = path.join(project.root, project.dir, "intent.json");
  return [".llmwiki", project.dir];
}

/** A committed apply as its activation leaves it, live intent still in place (CONSTRUCTED). */
async function committedProject(): Promise<CancelProject> {
  const project = track(await plainProject());
  const { root, plan, dir } = project;
  const intent = intentOf(plan);
  await plant(root, SCALE_RECORD_FILE, serializeAnyScaleRecord(activationRecord({ revision: intent.fenceRevision } as ScaleRecord, plan.inventory.requested, plan.inventory.target)));
  await mkdir(path.join(root, dir, "indexed"));
  await plantLeaf(root, `${dir}/receipt.json`, { format: "llmwiki-scale-downgrade-receipt", version: 1, plan: plan.digest, target: plan.inventory.target,
    fenceRevision: intent.fenceRevision, archive: { indexed: await identityAt(root, `${dir}/indexed`), pins: null, stores: [] }, runs: [], lastRun: null, pinLabels: [],
    units: plan.inventory.units.map((unit) => ({ ...unit, staged: null })), priors: plan.inventory.priors.map((prior) => ({ relPath: prior.relPath, sha256: prior.sha256, identity: null })) });
  return project;
}

/** Require the retry's last two syncs before the barrier to be the retirement's parents, in order. */
function expectParentsBeforeBarrier(parents: string[]): void {
  const at = seen.log.indexOf("barrier");
  expect(at).toBeGreaterThanOrEqual(2);
  expect(seen.log.slice(at - 2, at)).toEqual(parents.map((parent) => `sync:${parent}`));
}

/** The retired inode and the record bytes a retry must keep. */
async function retainedState(project: CancelProject): Promise<{ ino: bigint; record: string; live: boolean }> {
  const live = await lstat(path.join(project.root, LIVE_INTENT)).then(() => true, () => false);
  return { ino: (await lstat(seen.retired, { bigint: true })).ino, record: await readFile(path.join(project.root, SCALE_RECORD_FILE), "utf8"), live };
}

/** Stop `call` after its real rename by failing parent `failing`, then retry it; require the replay order and the retained state. */
async function interruptThenRetry<T>(project: CancelProject, failing: number, call: () => Promise<T>): Promise<T> {
  const parents = watch(project);
  seen.failParent = parents[failing]!;
  await expect(call()).rejects.toThrow(INJECTED);
  const before = await retainedState(project);
  expect(before.live).toBe(false);
  Object.assign(seen, { failParent: null, log: [] });
  const result = await call();
  expectParentsBeforeBarrier(parents);
  expect(await retainedState(project)).toEqual(before);
  return result;
}

describe("a retry finishes a retirement whose rename outlived a failed parent sync", () => {
  it.each([0, 1])("apply re-syncs both parents before barrier cleanup (failed parent #%d)", async (failing) => {
    const project = await committedProject();
    const result = await interruptThenRetry(project, failing, () => applyScaleDowngrade(project.root, project.plan, OFFLINE));
    expect(result).toMatchObject({ resumed: true, revision: intentOf(project.plan).fenceRevision + 1, dir: project.dir });
  }, DURABLE_CANCEL_CASE_TIMEOUT_MS);

  it.each([0, 1])("cancel replay re-syncs both parents before barrier cleanup (failed parent #%d)", async (failing) => {
    const project = track(await plainProject());
    const result = await interruptThenRetry(project, failing, () => cancelScaleDowngrade(project.root, project.plan, OFFLINE));
    expect(result).toMatchObject({ phase: "bootstrapped", alreadyCancelled: true, resumed: false });
  }, DURABLE_CANCEL_CASE_TIMEOUT_MS);
});

describe("a retired intent alone proves nothing", () => {
  it("apply refuses an uncommitted fence beside a retired intent and syncs nothing", async () => {
    const project = track(await plainProject());
    watch(project);
    await plant(project.root, SCALE_RECORD_FILE, serializeAnyScaleRecord(fenceAndCancelRecords(project.plan).fence));
    await rename(path.join(project.root, LIVE_INTENT), seen.retired);
    const before = await retainedState(project);
    await expect(applyScaleDowngrade(project.root, project.plan, OFFLINE)).rejects.toThrow("fence exists without");
    expect(seen.log).toEqual([]);
    expect(await retainedState(project)).toEqual(before);
  }, DURABLE_CANCEL_CASE_TIMEOUT_MS);

  it("cancel refuses a retired intent whose cancel has no receipt, without touching the barrier", async () => {
    const project = track(await plainProject());
    watch(project);
    const intent = intentOf(project.plan);
    await plantLeaf(project.root, `${project.dir}/cancel.json`, { format: "llmwiki-scale-downgrade-cancel", version: 1, plan: project.plan.digest, phase: "bootstrapped",
      fenceRevision: intent.fenceRevision, cancelRevision: null, recordSha256: intent.originalRecordSha256, priors: [] });
    await rename(path.join(project.root, LIVE_INTENT), seen.retired);
    const before = await retainedState(project);
    expect(await refusalCodeOf(cancelScaleDowngrade(project.root, project.plan, OFFLINE))).toBe("scale_downgrade_partial");
    expect(seen.log).not.toContain("barrier");
    expect(await retainedState(project)).toEqual(before);
  }, DURABLE_CANCEL_CASE_TIMEOUT_MS);
});

const BARRIER = ".llmwiki/indexed-retire.json";
type IntentPlace = "retired" | "live";
type ArchiveChange = "missing" | "replaced";

/** The committed fixture with a stale barrier of its plan, its intent `place`d, and its record `later` revisions past the activation (0: exact). */
async function committedReplay(place: IntentPlace, later = 0): Promise<CancelProject> {
  const project = await committedProject();
  watch(project);
  const { root, plan } = project;
  if (later > 0) {
    const revision = intentOf(plan).fenceRevision + later;
    await plant(root, SCALE_RECORD_FILE, serializeAnyScaleRecord(activationRecord({ revision } as ScaleRecord, plan.inventory.requested, plan.inventory.target)));
  }
  await plant(root, BARRIER, staleBarrier(plan.digest));
  if (place === "retired") await rename(path.join(root, LIVE_INTENT), seen.retired);
  return project;
}

/** Remove the archived indexed directory, or replace it with a new one (the old kept alive, so its inode cannot be reused). */
async function changeArchive(project: CancelProject, change: ArchiveChange): Promise<void> {
  const archived = path.join(project.root, project.dir, "indexed");
  if (change === "missing") return rm(archived, { recursive: true });
  await rename(archived, path.join(project.root, project.dir, "indexed-old"));
  await mkdir(archived);
}

/** Inode and bytes of each leaf a refused replay must keep (null when absent). */
async function replayState(project: CancelProject): Promise<Record<string, string | null>> {
  const leaves = [SCALE_RECORD_FILE, BARRIER, `${project.dir}/receipt.json`, LIVE_INTENT, `${project.dir}/intent.json`];
  const stamp = async (leaf: string): Promise<string | null> => {
    const file = path.join(project.root, leaf);
    const info = await lstat(file, { bigint: true }).catch(() => null);
    return info === null ? null : `${info.ino}:${await readFile(file, "utf8")}`;
  };
  return Object.fromEntries(await Promise.all(leaves.map(async (leaf) => [leaf, await stamp(leaf)] as const)));
}

/** Require an accepted replay to have used the own-PID seam, retired the intent and really removed the stale barrier. */
async function expectAcceptedReplay(project: CancelProject): Promise<void> {
  expect(lockOwner.serializeOwner).toHaveBeenCalledWith(process.pid);
  expect(seen.log).toContain("barrier");
  const state = await replayState(project);
  expect([state[BARRIER], state[LIVE_INTENT]]).toEqual([null, null]);
  expect(state[`${project.dir}/intent.json`]).not.toBeNull();
}

describe("a committed replay is proved only by its receipted archive, at every revision", () => {
  it.each([["retired", "missing"], ["retired", "replaced"], ["live", "missing"], ["live", "replaced"]])(
    "exact activation, %s intent, %s archive: apply refuses and keeps the intent and the barrier", async (place, change) => {
      const project = await committedReplay(place as IntentPlace);
      await changeArchive(project, change as ArchiveChange);
      const before = await replayState(project);
      const code = await refusalCodeOf(applyScaleDowngrade(project.root, project.plan, OFFLINE));
      expect(code).toBe(place === "retired" ? "scale_downgrade_stale_plan" : "scale_downgrade_partial");
      expect(seen.log).not.toContain("barrier");
      expect(await replayState(project)).toEqual(before);
    }, DURABLE_CANCEL_CASE_TIMEOUT_MS);

  it("a later revision with a missing archive still refuses and keeps everything", async () => {
    const project = await committedReplay("live", 1);
    await changeArchive(project, "missing");
    const before = await replayState(project);
    expect(await refusalCodeOf(applyScaleDowngrade(project.root, project.plan, OFFLINE))).toBe("scale_downgrade_partial");
    expect(seen.log).not.toContain("barrier");
    expect(await replayState(project)).toEqual(before);
  }, DURABLE_CANCEL_CASE_TIMEOUT_MS);

  it("exact activation with the receipted archive resumes and removes its own stale barrier", async () => {
    const project = await committedReplay("live");
    const result = await applyScaleDowngrade(project.root, project.plan, OFFLINE);
    expect(result).toMatchObject({ resumed: true, revision: intentOf(project.plan).fenceRevision + 1, dir: project.dir });
    expect(result).not.toHaveProperty("current");
    await expectAcceptedReplay(project);
  }, DURABLE_CANCEL_CASE_TIMEOUT_MS);

  it("a later revision with the receipted archive resumes and reports the current record", async () => {
    const project = await committedReplay("live", 1);
    const fenceRevision = intentOf(project.plan).fenceRevision;
    const result = await applyScaleDowngrade(project.root, project.plan, OFFLINE);
    expect(result).toMatchObject({ resumed: true, revision: fenceRevision + 1, current: { revision: fenceRevision + 2, architecture: "local-standard" } });
    await expectAcceptedReplay(project);
  }, DURABLE_CANCEL_CASE_TIMEOUT_MS);
});
