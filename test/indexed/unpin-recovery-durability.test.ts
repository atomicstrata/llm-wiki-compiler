/**
 * @file test/indexed/unpin-recovery-durability.test.ts
 * @description The pre-effect recheck and the durable directory steps of an
 * explicit unpin's interrupted-pin recovery stay bound to the PLAN (IDX-1,
 * slice 3; independent review P2 A and P2 B), through the PUBLIC
 * `catalogUnpin`.
 *  A. LIVE RECHECK. A staged copy (pre-index R) planned against live A. Just
 *     before the recheck observes the staged group, the live manifest becomes a
 *     byte-different valid B, and that one observation is shown a substituted
 *     label whose R holds B. Comparing the live bytes to an observation that is
 *     not the planned group would authorize B and then discard A. The recheck
 *     must bind its observation to the plan first: refuse, keep the label and
 *     the bystander pin exactly, and leave live B as written.
 *  B1. SYNC IDENTITY. After the first settled copy is unlinked, the label is
 *     moved aside and a real replacement directory installed at the directory
 *     sync's entry. Syncing the replacement would acknowledge the wrong
 *     directory. The sync must be bound to the planned identity and stop there:
 *     no further copy removal is attempted, exactly one copy is reported
 *     removed, and the moved label and the replacement keep their contents.
 *  B2. FINAL ABSENCE. After every planned leaf is removed, the label is moved
 *     aside (nothing installed) at the confined rmdir's last check. An
 *     expected-identity rmdir must treat that absence as a change: refuse, and
 *     leave the moved directory.
 * Every case asserts its seam was reached and the ordinary lock released.
 *
 * LABELLED SEAMS, each restored in `finally`: `serializeOwner` (own PID);
 * call-through `observePublicationGroup` (the target's SECOND observation);
 * call-through `fsyncConfinedDirectory` (first label sync) with a counting
 * call-through `unlinkConfinedLeafIfIdentity`; call-through `lstatLeaf` (the
 * empty label). Synchronous renames stand in for a racing process; this does
 * not close the inherent window between a final check and a path syscall.
 */

import { lstatSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { catalogUnpin } from "../../src/indexed/maintenance.js";
import * as confinedDelete from "../../src/utils/confined-delete.js";
import * as fsPresence from "../../src/utils/fs-presence.js";
import * as publication from "../../src/utils/publication-group.js";
import {
  BYSTANDER, SUBJECT, buildPinTemplate, cloneLabelDir as cloneDir, dataState, interruptIndex, interruptLastCopy, labelDir, labelEntries, pinProject, removeFixtureRoots, swapDirs, withOwnerSeam,
} from "./fixtures/pin-publication-fixture.js";

/** Durable template commits on the test volume. */
const CASE_TIMEOUT_MS = 120_000;
const LOCK = ".llmwiki/lock";
let template = "";
beforeAll(async () => { template = await buildPinTemplate(); }, CASE_TIMEOUT_MS);
afterAll(removeFixtureRoots);

/** Whether `file` is present (any kind). */
const present = (file: string): boolean => { try { lstatSync(file); return true; } catch { return false; } };

/** The refusal message of `work`, or `accepted`. */
function messageOf(work: Promise<unknown>): Promise<string> {
  return work.then(() => "accepted", (error: Error) => error.message);
}

/** B1 and B2: an interrupted (R) subject label, its directory, and the aside path it may be moved to. */
async function interruptedWithAside(): Promise<{ root: string; dir: string; aside: string }> {
  const root = await pinProject(template);
  await interruptIndex(root, "R");
  const [dir, aside] = [labelDir(root), path.join(root, ".llmwiki", "label-aside")];
  return { root, dir, aside };
}

/** Entry names (sorted) and bytes of every leaf of directory `dir`: what a refusal must keep. */
function contents(dir: string): Record<string, string> {
  return Object.fromEntries(readdirSync(dir).sort().map((name) => [name, readFileSync(path.join(dir, name)).toString("hex")]));
}

describe("the pre-effect recheck binds its observation to the plan before comparing the live manifest", () => {
  it("A. refuses when the recheck is shown a substituted R holding a new live manifest, keeping everything", () => withOwnerSeam(async () => {
    const root = await pinProject(template);
    const target = await interruptLastCopy(root, "R");
    const store = target.slice(0, -".manifest".length);
    const live = path.join(root, ".llmwiki", "indexed", store, "manifest.json");
    const liveB = `${JSON.stringify(JSON.parse(readFileSync(live, "utf8")), null, 1)}\n`;
    const [dir, other, spare] = [labelDir(root), path.join(root, ".llmwiki", "label-substitute"), path.join(root, ".llmwiki", "label-spare")];
    const before = await dataState(root);
    const real = publication.observePublicationGroup;
    let observed = 0;
    let reached = false;
    const seam = spyOn(publication, "observePublicationGroup").mockImplementation(async (final, confine, max) => {
      if (path.basename(final) !== target || ++observed !== 2) return real(final, confine, max);
      reached = true;
      writeFileSync(live, liveB);
      cloneDir(dir, other);
      writeFileSync(path.join(other, `${target}.tmp`), liveB);
      swapDirs(dir, other, spare);
      try { return await real(final, confine, max); } finally { swapDirs(dir, other, spare); }
    });
    let message = "";
    try { message = await messageOf(catalogUnpin(root, SUBJECT)); } finally { seam.mockRestore(); }
    const after = await dataState(root);
    expect([reached, message === "accepted", present(path.join(root, LOCK))]).toEqual([true, false, false]);
    expect([labelEntries(after, SUBJECT), labelEntries(after, BYSTANDER)]).toEqual([labelEntries(before, SUBJECT), labelEntries(before, BYSTANDER)]);
    expect(readFileSync(live, "utf8")).toBe(liveB);
  }), CASE_TIMEOUT_MS);
});

describe("the directory steps stay bound to the planned label directory", () => {
  it("B1. stops at a sync of a replacement directory, attempting no further copy removal", () => withOwnerSeam(async () => {
    const { root, dir, aside } = await interruptedWithAside();
    const [syncReal, unlinkReal] = [confinedDelete.fsyncConfinedDirectory, confinedDelete.unlinkConfinedLeafIfIdentity];
    let swapped: Record<string, string> | null = null;
    let unlinksAfterSwap = 0;
    const sync = spyOn(confinedDelete, "fsyncConfinedDirectory").mockImplementation(async (...args: Parameters<typeof syncReal>) => {
      if (swapped === null && args[1] === dir) { renameSync(dir, aside); cloneDir(aside, dir); swapped = contents(aside); }
      return syncReal(...args);
    });
    const unlink = spyOn(confinedDelete, "unlinkConfinedLeafIfIdentity").mockImplementation(async (...args: Parameters<typeof unlinkReal>) => {
      if (swapped !== null) unlinksAfterSwap++;
      return unlinkReal(...args);
    });
    let message = "";
    try { message = await messageOf(catalogUnpin(root, SUBJECT)); } finally { sync.mockRestore(); unlink.mockRestore(); }
    expect([swapped !== null, message.includes("and 1 copies"), unlinksAfterSwap, present(path.join(root, LOCK))]).toEqual([true, true, 0, false]);
    expect([contents(aside), contents(dir)]).toEqual([swapped!, swapped!]);
  }), CASE_TIMEOUT_MS);

  it("B2. refuses when the planned label directory is gone at the final rmdir, leaving the moved directory", () => withOwnerSeam(async () => {
    const { root, dir, aside } = await interruptedWithAside();
    const real = fsPresence.lstatLeaf;
    let moved = false;
    const seam = spyOn(fsPresence, "lstatLeaf").mockImplementation(async (file) => {
      if (!moved && file === dir && readdirSync(dir).length === 0) { renameSync(dir, aside); moved = true; }
      return real(file);
    });
    let message = "";
    try { message = await messageOf(catalogUnpin(root, SUBJECT)); } finally { seam.mockRestore(); }
    expect([moved, message === "accepted", present(aside), present(dir), present(path.join(root, LOCK))]).toEqual([true, false, true, false, false]);
    expect(message).toContain("and 3 copies");
  }), CASE_TIMEOUT_MS);
});
