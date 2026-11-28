/**
 * @file Create-only scale-down publication faults in disposable directories.
 * Restore each path-specific directory-sync spy at test teardown.
 */
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { link, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDowngradeIntent, readDowngradeIntent, type DowngradeIntentV1 } from "../../src/segments/downgrade-access.js";
import { DOWNGRADE_INTENT_FILE } from "../../src/scale/downgrade-contracts.js";
import { recordCancelIntent, readCancelIntent, recordCancelReceipt, readCancelReceipt, recordReceipt, readReceipt } from "../../src/scale/downgrade-journal.js";
import * as durability from "../../src/utils/atomic-write-durability.js";

const realChain = durability.fsyncDirectoryChain;
const plan = "a".repeat(64);
const intent: DowngradeIntentV1 = { format: "llmwiki-scale-downgrade-intent", version: 1, plan, target: "local-standard",
  originalRevision: 7, originalRecordSha256: "b".repeat(64), fenceRevision: 8, dir: ".llmwiki/scale-downgrade/8-aaaaaaaaaaaa" };
const body = `${JSON.stringify(intent)}\n`;
let root: string | undefined;
let faultAt: bigint | undefined;
let faults = 0;
let faultLeaf: string | undefined;

let restoreSync: (() => void) | undefined;

/** Inject only immediately before a real strict directory sync at the chosen link count. */
beforeEach(() => {
  const spy = spyOn(durability, "fsyncDirectoryChain").mockImplementation((...[dir, binding, before, scope]: Parameters<typeof realChain>) => realChain(dir, binding, async (entry) => {
    await before?.(entry);
    if (root === undefined || faultAt === undefined || entry !== path.join(root, ".llmwiki")) return;
    const current = await lstat(faultLeaf ?? path.join(root, DOWNGRADE_INTENT_FILE), { bigint: true }).catch(() => null);
    if (current?.nlink !== faultAt) return;
    faults += 1;
    throw new Error("injected directory sync EIO");
  }, scope));
  restoreSync = () => spy.mockRestore();
});

/** Create an empty project inside the guarded test scratch. */
async function fixture() {
  root = await mkdtemp(path.join(await realpath(tmpdir()), "create-only-downgrade-"));
  await mkdir(path.join(root, ".llmwiki"));
  const leaf = path.join(root, DOWNGRADE_INTENT_FILE);
  return { project: root, leaf, alias: `${leaf}.tmp` };
}

afterEach(async () => {
  restoreSync?.();
  restoreSync = undefined;
  if (root !== undefined) await rm(root, { recursive: true });
  root = undefined;
  faultAt = undefined;
  faults = 0;
  faultLeaf = undefined;
});

/** The real link was committed before sync failed, while the normal reader still refuses it. */
test("replays the exact intent after a post-link directory sync fault", async () => {
  const { project, leaf, alias } = await fixture();
  faultAt = 2n;
  await expect(createDowngradeIntent(project, intent)).rejects.toThrow("injected directory sync EIO");
  const first = await lstat(leaf, { bigint: true });
  expect(first.nlink).toBe(2n);
  expect((await lstat(alias, { bigint: true })).ino).toBe(first.ino);
  expect(await readFile(leaf, "utf8")).toBe(body);
  expect(await readDowngradeIntent(project)).toEqual({ kind: "unreadable" });
  await expect(createDowngradeIntent(project, intent)).rejects.toMatchObject({ code: "scale_downgrade_partial" });
  expect(faults).toBe(2);
  expect((await lstat(alias, { bigint: true })).ino).toBe(first.ino);
  faultAt = undefined;
  await createDowngradeIntent(project, intent);
  expect(await readDowngradeIntent(project)).toEqual({ kind: "ok", intent });
  expect((await lstat(leaf, { bigint: true })).ino).toBe(first.ino);
  await expect(lstat(alias)).rejects.toMatchObject({ code: "ENOENT" });
});

/** A still-visible single-link destination requires a fresh strict sync before success. */
test("checkpoints the visible one-link intent after a final sync fault", async () => {
  const { project, leaf, alias } = await fixture();
  faultAt = 1n;
  await expect(createDowngradeIntent(project, intent)).rejects.toThrow("injected directory sync EIO");
  expect(await readDowngradeIntent(project)).toEqual({ kind: "ok", intent });
  await expect(lstat(alias)).rejects.toMatchObject({ code: "ENOENT" });
  const before = await lstat(leaf, { bigint: true });
  await expect(createDowngradeIntent(project, intent)).rejects.toMatchObject({ code: "scale_downgrade_partial" });
  expect(faults).toBe(2);
  faultAt = undefined;
  await createDowngradeIntent(project, intent);
  expect((await lstat(leaf, { bigint: true })).ino).toBe(before.ino);
  expect(await readFile(leaf, "utf8")).toBe(body);
});

/** Do not remove a matching-name alias until its bytes match the intended publication. */
test("preserves mismatched bytes and foreign aliases", async () => {
  const { project, leaf, alias } = await fixture();
  await writeFile(leaf, body.replaceAll("bbbb", "cccc"), { mode: 0o600 });
  await link(leaf, alias);
  await expect(createDowngradeIntent(project, intent)).rejects.toMatchObject({ code: "scale_downgrade_partial" });
  expect((await lstat(leaf)).nlink).toBe(2);
  await rm(alias);
  await writeFile(leaf, body);
  await writeFile(alias, "foreign", { mode: 0o600 });
  await expect(createDowngradeIntent(project, intent)).rejects.toMatchObject({ code: "scale_downgrade_partial" });
  expect(await readFile(alias, "utf8")).toBe("foreign");
  expect(await readFile(leaf, "utf8")).toBe(body);
});

/** Bind journal inputs without constructing a real project or acquiring its lock. */
const cancel = { plan, phase: "fenced" as const, fenceRevision: 8, cancelRevision: 9, recordSha256: "d".repeat(64), priors: [] };
const cancelReceipt = { plan, phase: cancel.phase, fenceRevision: 8, cancelRevision: 9,
  recordSha256: cancel.recordSha256, cancelIntentSha256: "e".repeat(64), estimate: "planned-kept" as const, laterRecord: null };
const receipt = { plan, target: intent.target, fenceRevision: 8, archive: { indexed: { kind: "directory" as const, dev: "1", ino: "2", size: "0", mtimeNs: "0" },
  pins: null, stores: [] }, runs: [], lastRun: null, pinLabels: [], units: [], priors: [] };

/** Check that the strict reader withholds a leaf until that exact write has settled. */
async function replayJournal(name: string, publish: (project: string) => Promise<void>, read: (project: string) => Promise<unknown>) {
  const { project } = await fixture();
  const destination = path.join(project, intent.dir, name);
  faultLeaf = destination;
  faultAt = 2n;
  const admitted: string[] = [];
  const continuation = () => publish(project).then(() => { admitted.push("publish-dependent-phase"); });
  await expect(continuation()).rejects.toMatchObject({ code: "scale_downgrade_partial" });
  const first = await lstat(destination, { bigint: true });
  expect(first.nlink).toBe(2n);
  expect((await lstat(destination + ".tmp", { bigint: true })).ino).toBe(first.ino);
  await expect(read(project)).rejects.toMatchObject({ code: "scale_downgrade_partial" });
  await expect(continuation()).rejects.toMatchObject({ code: "scale_downgrade_partial" });
  expect(admitted).toEqual([]);
  faultAt = undefined;
  await continuation();
  expect(admitted).toEqual(["publish-dependent-phase"]);
  expect(await read(project)).toMatchObject({ plan });
  expect((await lstat(destination, { bigint: true })).ino).toBe(first.ino);
  await expect(lstat(destination + ".tmp")).rejects.toMatchObject({ code: "ENOENT" });
}

/** Journal writer witnesses. Held cancel classification is reviewed separately. */
test("settles independently supplied cancel capture before its dependent phase", () =>
  replayJournal("cancel.json", (project) => recordCancelIntent(project, intent.dir, cancel), (project) => readCancelIntent(project, intent.dir, plan)));
/** The bound cancel receipt has the same strictly confined publication protocol. */
test("settles independently supplied cancel receipt before retirement", () =>
  replayJournal("cancel-receipt.json", (project) => recordCancelReceipt(project, intent.dir, cancelReceipt), (project) => readCancelReceipt(project, intent.dir, plan)));
/** Activation receipt writer and strict reader share the publication boundary. */
test("settles independently supplied activation receipt before activation", () =>
  replayJournal("receipt.json", (project) => recordReceipt(project, intent.dir, receipt), (project) => readReceipt(project, intent.dir, plan)));
