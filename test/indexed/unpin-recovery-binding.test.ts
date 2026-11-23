/**
 * @file test/indexed/unpin-recovery-binding.test.ts
 * @description IDENTITY BINDING of an explicit unpin's interrupted-pin
 * recovery (IDX-1, slice 3; independent review findings on the candidate
 * `pin-recovery.ts`), through the PUBLIC `catalogUnpin`.
 *
 * Each case simulates a CONCURRENT process that swaps the whole label
 * directory for a same-named copy (new inodes, same names, same bytes or a
 * chosen variant) at one exact window, and swaps it back, so every path read
 * outside that window sees the planned label:
 *  1. HELD GROUP. The replacement label is in place when the shared discard
 *     observes and holds the group, the planned label is back only while the
 *     proof runs, and the replacement is in place again for the unlink. A proof
 *     that re-reads planned paths approves, and the discard then unlinks the
 *     replacement's R it holds. The proof must bind the HELD leaves and parent.
 *  2. SETTLED COPY. A good copy is in place only while the copy's bytes are
 *     read, while the planned label holds a copy that does not match its index.
 *     Bytes read apart from the planned stamp prove the wrong file. The bytes
 *     must come from a handle whose stamp is the planned one.
 *  3. FINAL RMDIR. After every planned leaf is gone, a different EMPTY label
 *     directory replaces the planned one just before the confined rmdir. It must
 *     survive: the planned directory identity must reach the final deletion.
 * Each must refuse and leave the replacement (or the unproved copy) in place,
 * and release the ordinary lock.
 *  4. UNLINK PARENT. Directly: the identity-bound confined unlink, given the
 *     expected parent identity, must not unlink an otherwise matching leaf whose
 *     parent is another directory.
 * These bind each effect to what was proved; they do NOT close the final
 * check-to-syscall window inherent to path-based unlink and rmdir.
 *
 * LABELLED SEAMS, each restored in `finally` and each asserted reached:
 * `serializeOwner` (own PID); (1) call-through `discardProvenPublication`
 * whose proof argument is wrapped with synchronous swaps; (2) call-through
 * `readConfinedLeafBuffer` and `observePublicationGroup` (whichever the
 * recovery reads the copy with), swapping around that one call; (3) call-through
 * `lstatLeaf` for the empty label directory (the confined rmdir's last check).
 * The swaps stand in for a racing process; nothing here is native or timed.
 */

import { mkdirSync, readdirSync, renameSync, lstatSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { catalogUnpin } from "../../src/indexed/maintenance.js";
import { unlinkConfinedLeafIfIdentity } from "../../src/utils/confined-delete.js";
import * as confinedRead from "../../src/utils/confined-read.js";
import * as fsPresence from "../../src/utils/fs-presence.js";
import * as publication from "../../src/utils/publication-group.js";
import {
  INDEX, buildPinTemplate, cloneLabelDir as cloneLabel, codeOf, copyNames, dataState, interruptIndex, labelDir, labelEntries, pinProject, privateDir, removeFixtureRoots, swapDirs, withOwnerSeam, SUBJECT,
} from "./fixtures/pin-publication-fixture.js";

/** Durable template commits on the test volume. */
const CASE_TIMEOUT_MS = 120_000;
let template = "";
beforeAll(async () => { template = await buildPinTemplate(); }, CASE_TIMEOUT_MS);
afterAll(removeFixtureRoots);

/** The aside, replacement and spare paths of a project (all outside the pins tree). */
const asides = (root: string) => ({ other: path.join(root, ".llmwiki", "label-replacement"), spare: path.join(root, ".llmwiki", "label-spare") });
const LOCK = ".llmwiki/lock";

/** Tests 1 and 2: an interrupted (R) subject label plus a same-named replacement copy of it aside (a good copy of every store). */
async function interruptedWithReplacement(): Promise<{ root: string; dir: string; other: string; spare: string }> {
  const root = await pinProject(template);
  await interruptIndex(root, "R");
  const dir = labelDir(root);
  const { other, spare } = asides(root);
  cloneLabel(dir, other);
  return { root, dir, other, spare };
}

/** The inode at `file`, or null when nothing is there. */
const inoOf = (file: string): bigint | null => { try { return lstatSync(file, { bigint: true }).ino; } catch { return null; } };

/** Whether the ordinary project lock is still present (it must be released after every refusal). */
const lockLeft = (root: string): boolean => { try { lstatSync(path.join(root, LOCK)); return true; } catch { return false; } };

describe("the recovery is bound to what it holds, not to what the planned paths show later", () => {
  it("1. refuses a replacement group held by the discard even if the planned label is back during the proof", () => withOwnerSeam(async () => {
    const { root, dir, other, spare } = await interruptedWithReplacement();
    const replacementR = lstatSync(path.join(other, `${INDEX}.tmp`), { bigint: true }).ino;
    const real = publication.discardProvenPublication;
    let reached = false;
    const seam = spyOn(publication, "discardProvenPublication").mockImplementation(async (final, confine, max, prove) => {
      reached = true;
      swapDirs(dir, other, spare); // the replacement is observed and held
      return real(final, confine, max, ((...args: Parameters<typeof prove>) => {
        swapDirs(dir, other, spare); // the planned label, only while the proof runs
        try { return prove(...args); } finally { swapDirs(dir, other, spare); }
      }) as typeof prove);
    });
    let code = "";
    try { code = await codeOf(catalogUnpin(root, SUBJECT)); } finally { seam.mockRestore(); }
    expect([reached, code === "accepted", lockLeft(root)]).toEqual([true, false, false]);
    expect(inoOf(path.join(dir, `${INDEX}.tmp`))).toBe(replacementR);
  }), CASE_TIMEOUT_MS);

  it("2. refuses a copy whose bytes were read from another file than the planned stamp", () => withOwnerSeam(async () => {
    const { root, dir, other, spare } = await interruptedWithReplacement();
    const last = (await copyNames(root)).at(-1)!;
    await writeFile(path.join(dir, last), "{}\n", { flag: "a" }); // the planned copy no longer matches the index
    const before = labelEntries(await dataState(root), SUBJECT);
    let reached = false;
    const swapAround = <F extends (...args: never[]) => Promise<unknown>>(real: F, pathArg: number) => (async (...args: Parameters<F>) => {
      if (reached || path.basename(String(args[pathArg])) !== last) return real(...args);
      reached = true;
      swapDirs(dir, other, spare);
      try { return await real(...args); } finally { swapDirs(dir, other, spare); }
    }) as F;
    // Capture the real readers BEFORE spying: an argument read after spyOn would be the spy itself.
    const [readReal, observeReal] = [confinedRead.readConfinedLeafBuffer, publication.observePublicationGroup];
    const seams = [
      spyOn(confinedRead, "readConfinedLeafBuffer").mockImplementation(swapAround(readReal, 1)),
      spyOn(publication, "observePublicationGroup").mockImplementation(swapAround(observeReal, 0)),
    ];
    let code = "";
    try { code = await codeOf(catalogUnpin(root, SUBJECT)); } finally { for (const seam of seams) seam.mockRestore(); }
    expect([reached, code === "accepted", lockLeft(root)]).toEqual([true, false, false]);
    expect(labelEntries(await dataState(root), SUBJECT)).toEqual(before);
  }), CASE_TIMEOUT_MS);

  it("3. leaves a different empty label directory that replaced the planned one before the final rmdir", () => withOwnerSeam(async () => {
    const root = await pinProject(template);
    await interruptIndex(root, "R");
    const dir = labelDir(root);
    const { other } = asides(root);
    const real = fsPresence.lstatLeaf;
    let replacement: bigint | null = null;
    const seam = spyOn(fsPresence, "lstatLeaf").mockImplementation(async (file) => {
      if (replacement === null && file === dir && readdirSync(dir).length === 0) {
        renameSync(dir, other);
        mkdirSync(dir, { mode: 0o700 });
        replacement = lstatSync(dir, { bigint: true }).ino;
      }
      return real(file);
    });
    let code = "";
    try { code = await codeOf(catalogUnpin(root, SUBJECT)); } finally { seam.mockRestore(); }
    expect([replacement !== null, code === "accepted", lockLeft(root)]).toEqual([true, false, false]);
    expect(inoOf(dir)).toBe(replacement!);
  }), CASE_TIMEOUT_MS);
});

describe("the identity-bound unlink honours the expected parent identity", () => {
  it("4. does not unlink an otherwise matching leaf whose parent is not the expected directory", async () => {
    const root = await privateDir();
    const [expected, actual] = ["expected", "actual"].map((name) => path.join(root, name));
    for (const dir of [expected, actual]) mkdirSync(dir, { mode: 0o700 });
    const leaf = path.join(actual, "leaf");
    writeFileSync(leaf, "x", { mode: 0o600 });
    const { dev, ino } = lstatSync(expected, { bigint: true });
    const outcome = await unlinkConfinedLeafIfIdentity(root, leaf, actual, () => true, { dev, ino });
    expect([outcome, readdirSync(actual)]).toEqual(["changed", ["leaf"]]);
  });
});
