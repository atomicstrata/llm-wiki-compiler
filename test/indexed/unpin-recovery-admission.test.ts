/**
 * @file test/indexed/unpin-recovery-admission.test.ts
 * @description EXPLICIT UNPIN admission, plan binding and effect order
 * (IDX-1, slice 3), through the PUBLIC `catalogUnpin`.
 *
 * GATE. Once the outer active-root check passes, unpin must take the ordinary
 * gated project lock UNCONDITIONALLY and recheck indexed activation for the
 * same canonical root under it. Two deterministic boundaries witness this:
 *  - the scale record disappears after the outer check (the registration
 *    wrapper would otherwise run the removal unlocked on a project with a pin
 *    label but no store), and
 *  - activation changes to `local-standard` while the lock is being taken
 *    (the gate admits a ready record; the old decision must not be reused).
 * Both must positively take the ORDINARY gate exactly once (the lock is held
 * when it returns), then refuse `catalog_not_active` with no label effect and
 * no lock left.
 *
 * BINDING. A group replaced by another inode with the same names, state and
 * bytes after the plan, before the held discard, must refuse and survive. The
 * replacement inode is staged BEFORE it is renamed over R, so it can never
 * reuse R's inode. Before the fix this case shows only that the discard helper
 * is never reached (missing dispatch), not a reproduced replacement bug.
 *
 * ORDER. Index W+R: a fault at the first sync after W is unlinked leaves R and
 * every copy exactly as they were; a fault at the FINAL index sync (W and R
 * both gone) still leaves every copy exactly as it was, so no copy is touched
 * before the whole index group is synced. These two comparisons leave out ONLY
 * the label directory's own link count, which on APFS follows its number of
 * entries and so drops by one per removed index name; its device, inode and
 * mode, and every file's identity, link count and bytes, are still compared.
 *
 * LABELLED SEAMS, each restored in `finally`: `serializeOwner` (own PID);
 * call-through `canonicalRoot` (record removed at the first call, the point
 * between the outer active-root read and the lock); call-through
 * `acquireMutationLockBlocking` (record rewritten just before the real
 * acquisition); call-through `discardProvenPublication` (group replaced just
 * before the real discard; the case also asserts the seam was reached, so it
 * presumes the reviewed helper reuse); call-through `fsyncDirectoryChain`
 * (throws once at the first sync where the named leaves are gone and the rest
 * present).
 */

import { cp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { catalogUnpin } from "../../src/indexed/maintenance.js";
import * as lockGate from "../../src/operation-bundles/lock-gate.js";
import { SCALE_RECORD_FILE } from "../../src/scale/contracts.js";
import { serializeAnyScaleRecord } from "../../src/scale/record-v2-schema.js";
import * as readerLease from "../../src/segments/reader-lease.js";
import * as publication from "../../src/utils/publication-group.js";
import { failDirectorySyncWhen, presentAt } from "../fixtures/sync-fault.js";
import {
  ACTIVE_INDEXED, INDEX, PINS, SUBJECT, buildPinTemplate, codeOf, dataState, interruptIndex, labelDir, labelEntries,
  pinProject, privateDir, removeFixtureRoots, withOwnerSeam, writePrivate,
} from "./fixtures/pin-publication-fixture.js";

/** Durable template commits on the test volume. */
const CASE_TIMEOUT_MS = 120_000;
const LOCK = ".llmwiki/lock";
let template = "";
beforeAll(async () => { template = await buildPinTemplate(); }, CASE_TIMEOUT_MS);
afterAll(removeFixtureRoots);

/** Whether `relPath` under `root` is present (the shared fixture probe). */
const present = presentAt;

/** A project with the active record and the subject's genuine, alias-free pin, but no indexed store. */
async function storelessPinProject(): Promise<string> {
  const root = path.join(await privateDir(), "wiki");
  await mkdir(path.join(root, PINS), { recursive: true });
  await cp(path.join(template, PINS, SUBJECT), labelDir(root), { recursive: true });
  await writeFile(path.join(root, SCALE_RECORD_FILE), serializeAnyScaleRecord(ACTIVE_INDEXED));
  return root;
}

/** Run `work` with a call-through spy on `module[name]` that runs `before` once, before the real call. */
async function onceBefore<M extends object, K extends keyof M>(module: M, name: K, before: () => Promise<void>, work: () => Promise<unknown>): Promise<{ code: string; reached: boolean }> {
  const real = module[name] as unknown as (...args: unknown[]) => Promise<unknown>;
  let reached = false;
  const seam = spyOn(module, name as never).mockImplementation((async (...args: unknown[]) => {
    if (!reached) { reached = true; await before(); }
    return real(...args);
  }) as never);
  try { return { code: await codeOf(work() as Promise<unknown>), reached }; } finally { seam.mockRestore(); }
}

/** One observed gate acquisition: the intent it was asked for, and whether the lock was held when it returned. */
interface Acquisition { readonly intent: unknown; readonly held: boolean }

/** Observe every real `acquireMutationLockBlocking` for `root`, running `before` once ahead of the first. */
function observeAcquisitions(root: string, before: () => Promise<void> = async () => undefined): { calls: Acquisition[]; mockRestore(): void } {
  const real = lockGate.acquireMutationLockBlocking;
  const calls: Acquisition[] = [];
  const seam = spyOn(lockGate, "acquireMutationLockBlocking").mockImplementation(async (...args: Parameters<typeof real>) => {
    if (calls.length === 0) await before();
    await real(...args);
    calls.push({ intent: args[1], held: await present(root, LOCK) });
  });
  return { calls, mockRestore: () => seam.mockRestore() };
}

describe("unpin owns the ordinary gate and rechecks activation under it", () => {
  it("refuses when the record disappears after the outer check, removing nothing", () => withOwnerSeam(async () => {
    const root = await storelessPinProject();
    const before = labelEntries(await dataState(root), SUBJECT);
    const gate = observeAcquisitions(root);
    let seen: { code: string; reached: boolean };
    try { seen = await onceBefore(readerLease, "canonicalRoot", () => rm(path.join(root, SCALE_RECORD_FILE)), () => catalogUnpin(root, SUBJECT)); } finally { gate.mockRestore(); }
    expect({ ...seen, gate: gate.calls }).toEqual({ code: "catalog_not_active", reached: true, gate: [{ intent: "ordinary", held: true }] });
    expect(labelEntries(await dataState(root), SUBJECT)).toEqual(before);
    expect(await present(root, LOCK)).toBe(false);
  }), CASE_TIMEOUT_MS);

  it("refuses when activation changes while the lock is taken, removing nothing", () => withOwnerSeam(async () => {
    const root = await pinProject(template);
    const before = await dataState(root);
    const standard = serializeAnyScaleRecord({ ...ACTIVE_INDEXED, active: { architecture: "local-standard", sinceRevision: 1 } });
    const gate = observeAcquisitions(root, () => writeFile(path.join(root, SCALE_RECORD_FILE), standard));
    let code = "";
    try { code = await codeOf(catalogUnpin(root, SUBJECT)); } finally { gate.mockRestore(); }
    expect({ code, gate: gate.calls }).toEqual({ code: "catalog_not_active", gate: [{ intent: "ordinary", held: true }] });
    expect(await dataState(root)).toEqual(before);
    expect(await present(root, LOCK)).toBe(false);
  }), CASE_TIMEOUT_MS);
});

describe("the held discard is bound to the planned group", () => {
  it("refuses an R index replaced by a same-bytes inode before the discard, keeping it", () => withOwnerSeam(async () => {
    const root = await pinProject(template);
    await interruptIndex(root, "R");
    const key = `${PINS}/${SUBJECT}/${INDEX}.tmp`;
    const tmp = path.join(labelDir(root), `${INDEX}.tmp`);
    const { [key]: planned, ...copies } = labelEntries(await dataState(root), SUBJECT);
    let replacement = "";
    const stage = path.join(root, "replacement-stage");
    const replace = async () => { await writePrivate(stage, await readFile(tmp)); await rename(stage, tmp); replacement = (await dataState(root))[key]!; };
    const seen = await onceBefore(publication, "discardProvenPublication", replace, () => catalogUnpin(root, SUBJECT));
    expect([seen.reached, seen.code === "accepted", replacement === planned]).toEqual([true, false, false]);
    expect(labelEntries(await dataState(root), SUBJECT)).toEqual({ ...copies, [key]: replacement });
  }), CASE_TIMEOUT_MS);
});

/** `entry` (dev:ino:mode:nlink:sha256 from `dataState`) with its link count set to `links`. */
function withLinks(entry: string, links: number): string {
  const fields = entry.split(":");
  fields[3] = String(links);
  return fields.join(":");
}

/** Fail the first directory sync at which every `gone` entry is absent and every `kept` one present; otherwise call through. */
const failSyncWhen = (root: string, gone: readonly string[], kept: readonly string[]): { mockRestore(): void } => failDirectorySyncWhen(root, gone, kept, "injected sync failure");

/** `entries` with the label directory's own link count dropped (dev:ino:mode:dir kept); every file entry unchanged. */
function withoutLabelDirLinks(entries: Record<string, string>): Record<string, string> {
  const key = `${PINS}/${SUBJECT}`;
  const fields = entries[key]?.split(":");
  if (fields === undefined || fields.at(-1) !== "dir") throw new Error("the label directory entry is missing");
  return { ...entries, [key]: [...fields.slice(0, 3), "dir"].join(":") };
}

const W_KEY = `${PINS}/${SUBJECT}/${INDEX}.writing`;
const R_KEY = `${PINS}/${SUBJECT}/${INDEX}.tmp`;

/** Unpin an index W+R pin with the sync fault armed for `gone` (the rest of the label kept); the code and the label before and after. */
async function unpinWithIndexFault(gone: readonly string[]): Promise<{ code: string; before: Record<string, string>; after: Record<string, string> }> {
  const root = await pinProject(template);
  await interruptIndex(root, "WR");
  const before = labelEntries(await dataState(root), SUBJECT);
  const leaves = Object.keys(before).filter((name) => name !== `${PINS}/${SUBJECT}`);
  const fault = failSyncWhen(root, gone, leaves.filter((name) => !gone.includes(name)));
  let code = "";
  try { code = await codeOf(catalogUnpin(root, SUBJECT)); } finally { fault.mockRestore(); }
  return { code, before, after: labelEntries(await dataState(root), SUBJECT) };
}

describe("the index group is removed and synced before any copy", () => {
  it("a fault at the first sync after unlinking W leaves R and every copy exactly as they were", () => withOwnerSeam(async () => {
    const { code, before, after } = await unpinWithIndexFault([W_KEY]);
    const { [W_KEY]: w, [R_KEY]: r, ...copies } = before;
    expect([code === "accepted", w !== undefined, W_KEY in after]).toEqual([false, true, false]);
    expect(withoutLabelDirLinks(after)).toEqual(withoutLabelDirLinks({ ...copies, [R_KEY]: withLinks(r!, 1) }));
  }), CASE_TIMEOUT_MS);

  it("a fault at the final index sync (W and R gone) still leaves every copy exactly as it was", () => withOwnerSeam(async () => {
    const { code, before, after } = await unpinWithIndexFault([W_KEY, R_KEY]);
    const { [W_KEY]: w, [R_KEY]: r, ...copies } = before;
    expect([code === "accepted", w !== undefined && r !== undefined, Object.keys(copies).length > 2]).toEqual([false, true, true]);
    expect(withoutLabelDirLinks(after)).toEqual(withoutLabelDirLinks(copies));
  }), CASE_TIMEOUT_MS);
});
