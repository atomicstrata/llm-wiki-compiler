/**
 * @file Exercise the ready-link sync fault with real create-only writes.
 * Restore each path-specific directory-sync spy at test teardown.
 */
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { DOWNGRADE_INTENT_FILE } from "../../src/scale/downgrade-contracts.js";
import { assertNotCancelled, readCancelIntent, readCancelReceipt, recordCancelIntent, recordCancelReceipt, recordPlan } from "../../src/scale/downgrade-journal.js";
import { buildDowngradePlan, parseDowngradePlan } from "../../src/scale/downgrade-plan.js";
import { createDowngradeIntent, readDowngradeIntent, type DowngradeIntentV1 } from "../../src/segments/downgrade-access.js";
import * as durability from "../../src/utils/atomic-write-durability.js";

const digest = "a".repeat(64);
const dir = ".llmwiki/scale-downgrade/8-aaaaaaaaaaaa";
const intent: DowngradeIntentV1 = { format: "llmwiki-scale-downgrade-intent", version: 1, plan: digest, target: "local-standard",
  originalRevision: 7, originalRecordSha256: "b".repeat(64), fenceRevision: 8, dir };
const cancel = { plan: digest, phase: "bootstrapped" as const, fenceRevision: 8,
  cancelRevision: null, recordSha256: intent.originalRecordSha256, priors: [] };
const realChain = durability.fsyncDirectoryChain;
const injected = "injected ready-link directory sync failure";
let root: string | undefined;
let fault: string | undefined;

let restoreSync: (() => void) | undefined;

/** Fail only before syncing the actual ready pair, with no destination yet. */
beforeEach(() => {
  const spy = spyOn(durability, "fsyncDirectoryChain").mockImplementation((...[parent, binding, before, scope]: Parameters<typeof realChain>) => realChain(parent, binding, async (entry) => {
    await before?.(entry);
    if (fault === undefined || entry !== path.dirname(fault)) return;
    const ready = await lstat(fault + ".tmp", { bigint: true });
    const writing = await lstat(fault + ".writing", { bigint: true });
    if (ready.nlink === 2n && ready.ino === writing.ino) throw new Error(injected);
  }, scope));
  restoreSync = () => spy.mockRestore();
});

/** A disposable project with no lock or architecture. */
async function fixture() {
  root = await mkdtemp(path.join(await realpath(tmpdir()), "prepublish-"));
  await mkdir(path.join(root, dir), { recursive: true });
  return root;
}

/** Capture the original writer's real ready pair and prove its contents. */
async function failReady(leaf: string, publish: () => Promise<void>, value: unknown) {
  fault = leaf;
  await expect(publish()).rejects.toThrow(injected);
  await expect(lstat(leaf)).rejects.toMatchObject({ code: "ENOENT" });
  const ready = await lstat(leaf + ".tmp", { bigint: true });
  expect(ready.nlink).toBe(2n);
  expect(ready.mode & 0o777n).toBe(0o600n);
  expect((await lstat(leaf + ".writing", { bigint: true })).ino).toBe(ready.ino);
  expect(await readFile(leaf + ".tmp", "utf8")).toBe(JSON.stringify(value) + "\n");
  fault = undefined;
  return ready;
}

/** Ensure replay used the same ready inode and consumed only its aliases. */
async function settled(leaf: string, ino: bigint) {
  const current = await lstat(leaf, { bigint: true });
  expect(current.ino).toBe(ino);
  expect(current.nlink).toBe(1n);
  await expect(lstat(leaf + ".tmp")).rejects.toMatchObject({ code: "ENOENT" });
  await expect(lstat(leaf + ".writing")).rejects.toMatchObject({ code: "ENOENT" });
}

afterEach(async () => {
  restoreSync?.();
  restoreSync = undefined;
  if (root !== undefined) await rm(root, { recursive: true });
  root = undefined;
  fault = undefined;
});

/** The owner could already replay the known plan and live intent. */
test("replays the actual pre-publication plan and intent ready pairs", async () => {
  const project = await fixture();
  const plan = buildDowngradePlan(project, {
    from: "local-indexed", target: "local-standard", record: { revision: 7, sha256: intent.originalRecordSha256 },
    requested: { sizeBytes: 1, documents: 1, sizeBasis: "stated", documentsBasis: "stated" },
    measured: { sourceDocuments: 0, sourceBytes: 0, wikiFiles: 0, wikiBytes: 0 },
    freeze: { entries: 0, bytes: 0, digest }, stores: [], units: [], priors: [], runs: [],
    lastRun: null, pins: { labels: [], digest }, capabilities: [], notices: [], blockers: [],
  });
  const planDir = `.llmwiki/scale-downgrade/8-${plan.digest.slice(0, 12)}`;
  const planPath = path.join(project, planDir, "plan.json");
  await mkdir(path.dirname(planPath));
  const readyPlan = await failReady(planPath, () => recordPlan(project, planDir, plan), plan);
  await recordPlan(project, planDir, plan);
  await settled(planPath, readyPlan.ino);
  expect(parseDowngradePlan(await readFile(planPath, "utf8"), project)).toEqual(plan);
  const leaf = path.join(project, DOWNGRADE_INTENT_FILE);
  const publish = () => createDowngradeIntent(project, intent);
  const ready = await failReady(leaf, publish, intent);
  expect(await readDowngradeIntent(project)).toEqual({ kind: "absent" });
  await publish();
  await settled(leaf, ready.ino);
  expect(await readDowngradeIntent(project)).toEqual({ kind: "ok", intent });
});

/** Prepare the original intent's ready inode using the same fault for each replay case. */
async function interruptedIntent() {
  const project = await fixture();
  const leaf = path.join(project, DOWNGRADE_INTENT_FILE);
  const publish = () => createDowngradeIntent(project, intent);
  const ready = await failReady(leaf, publish, intent);
  return { project, leaf, publish, ready };
}

/** Ready-only represents the valid next publication state after removing the scratch name. */
test("replays the exact surviving ready-only intent inode", async () => {
  const { leaf, publish, ready } = await interruptedIntent();
  await unlink(leaf + ".writing");
  expect((await lstat(leaf + ".tmp")).nlink).toBe(1);
  await publish();
  await settled(leaf, ready.ino);
});

/** Replay the bound cancel writer without a phase or lock. */
test("replays the bound cancel capture at the journal boundary", async () => {
  const project = await fixture();
  const leaf = path.join(project, dir, "cancel.json");
  const publish = () => recordCancelIntent(project, dir, cancel);
  const ready = await failReady(leaf, publish, { format: "llmwiki-scale-downgrade-cancel", version: 1, ...cancel });
  expect(await readCancelIntent(project, dir, digest)).toBeNull();
  await expect(assertNotCancelled(project, dir)).rejects.toMatchObject({ code: "scale_downgrade_cancelled" });
  fault = leaf;
  await expect(publish()).rejects.toThrow(injected);
  expect((await lstat(leaf + ".tmp", { bigint: true })).ino).toBe(ready.ino);
  await expect(assertNotCancelled(project, dir)).rejects.toMatchObject({ code: "scale_downgrade_cancelled" });
  fault = undefined;
  await publish();
  await settled(leaf, ready.ino);
  expect(await readCancelIntent(project, dir, digest)).toMatchObject(cancel);
  await expect(assertNotCancelled(project, dir)).rejects.toMatchObject({ code: "scale_downgrade_cancelled" });
});

/** A wrong body, foreign writing name and wrong mode cannot authorize alias changes. */
test("retains mismatched and foreign pre-publication evidence", async () => {
  const { project, leaf, publish, ready } = await interruptedIntent();
  await expect(createDowngradeIntent(project, { ...intent, originalRecordSha256: "c".repeat(64) }))
    .rejects.toMatchObject({ code: "scale_downgrade_partial" });
  expect((await lstat(leaf + ".writing", { bigint: true })).ino).toBe(ready.ino);
  await unlink(leaf + ".writing");
  await writeFile(leaf + ".writing", "foreign", { mode: 0o600 });
  await expect(publish()).rejects.toMatchObject({ code: "scale_downgrade_partial" });
  expect(await readFile(leaf + ".writing", "utf8")).toBe("foreign");
  expect((await lstat(leaf + ".tmp", { bigint: true })).ino).toBe(ready.ino);
  await expect(lstat(leaf)).rejects.toMatchObject({ code: "ENOENT" });
});

/** A bound bootstrapped receipt can publish from the exact ready inode while apply stays fenced. */
test("replays a positively bound cancel receipt and keeps apply fenced", async () => {
  const project = await fixture();
  await recordCancelIntent(project, dir, cancel);
  const capture = await readFile(path.join(project, dir, "cancel.json"));
  const { priors: _priors, ...outcome } = cancel;
  const value = { ...outcome, cancelIntentSha256: createHash("sha256").update(capture).digest("hex"),
    estimate: "unchanged" as const, laterRecord: null };
  const leaf = path.join(project, dir, "cancel-receipt.json");
  const publish = () => recordCancelReceipt(project, dir, value);
  const ready = await failReady(leaf, publish, { format: "llmwiki-scale-downgrade-cancel-receipt", version: 1, ...value });
  expect(await readCancelReceipt(project, dir, digest)).toBeNull();
  await expect(assertNotCancelled(project, dir)).rejects.toMatchObject({ code: "scale_downgrade_cancelled" });
  await publish();
  await settled(leaf, ready.ino);
  expect(await readCancelReceipt(project, dir, digest)).toMatchObject(value);
  await expect(assertNotCancelled(project, dir)).rejects.toMatchObject({ code: "scale_downgrade_cancelled" });
});

/** Checkpoint-only must refuse absence, and exact bytes cannot compensate for the wrong mode. */
test("keeps ready evidence when existence or the required mode is unproved", async () => {
  const { project, leaf, publish, ready } = await interruptedIntent();
  await expect(createDowngradeIntent(project, intent, true)).rejects.toMatchObject({ code: "scale_downgrade_partial" });
  expect((await lstat(leaf + ".writing", { bigint: true })).ino).toBe(ready.ino);
  await chmod(leaf + ".tmp", 0o640);
  await expect(publish()).rejects.toMatchObject({ code: "scale_downgrade_partial" });
  expect((await lstat(leaf + ".tmp", { bigint: true })).ino).toBe(ready.ino);
  expect((await lstat(leaf + ".writing", { bigint: true })).ino).toBe(ready.ino);
  await expect(lstat(leaf)).rejects.toMatchObject({ code: "ENOENT" });
});
