/**
 * @file test/indexed/unpin-recovery-states.test.ts
 * @description EXPLICIT UNPIN of an interrupted pin publication (IDX-1,
 * slice 3) through the PUBLIC `catalogUnpin`, `catalogPins` and
 * `catalogGcPreview`, on pins written by the real `catalogPin`.
 *
 * RECOGNIZED. The create-only writer publishes each copy, then the index, and
 * can stop inside any one of them: W, W+R, R or R+F of `pin.json` (every copy
 * settled) or of the LAST copy before any index name. For each of the eight,
 * the read-only views still refuse (a preview never settles an alias), the
 * explicit unpin removes the label, a fresh preview drops that label's
 * blocker, and the bystander pin and every store stay byte- and
 * identity-identical.
 *
 * REFUSED. A representative case per class keeps every name, inode, mode,
 * link count and byte of the label and everything else: a bad last indexed
 * copy, a staged copy that is not the live manifest's exact bytes, a copy
 * alias beside an index name, a distinct-inode pair, an externally linked
 * alias, a writer-impossible index (`createdAt: 42`), a truncated W, F with an
 * independent W, two interrupted groups, and a symlinked alias.
 *
 * ALIAS-FREE POLICY is unchanged: an incomplete pin (no index) with an
 * operator-created regular reserved copy name still unpins (CP327 P3 debt).
 */

import { link, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { catalogGcPreview, catalogPins, catalogUnpin } from "../../src/indexed/maintenance.js";
import {
  BYSTANDER, INDEX, SUBJECT, WRITER_STATES, buildPinTemplate, codeOf, copyNames, dataState, interrupt, interruptIndex, interruptLastCopy,
  labelDir, labelEntries, outsideLabel, pinProject, removeFixtureRoots, withOwnerSeam, writePrivate, type WriterState,
} from "./fixtures/pin-publication-fixture.js";

/** Durable template commits on the test volume. */
const CASE_TIMEOUT_MS = 120_000;
let template = "";
beforeAll(async () => { template = await buildPinTemplate(); }, CASE_TIMEOUT_MS);
afterAll(removeFixtureRoots);

/** Whether some read-only view names a blocker for the subject pin. */
async function subjectBlocked(root: string): Promise<{ pins: boolean; gc: boolean }> {
  const mentions = (blockers: readonly string[]) => blockers.some((blocker) => blocker.includes(`pin ${SUBJECT}`));
  return { pins: mentions((await catalogPins(root)).blockers), gc: mentions((await catalogGcPreview(root)).blockers) };
}

/** Plant `state` of `target` on a fresh project. */
async function interrupted(target: "index" | "copy", state: WriterState): Promise<string> {
  const root = await pinProject(template);
  if (target === "index") await interruptIndex(root, state); else await interruptLastCopy(root, state);
  return root;
}

describe("an interrupted pin publication is removed by the explicit unpin only", () => {
  for (const target of ["index", "copy"] as const) {
    for (const state of WRITER_STATES) {
      it(`${target} ${state}: views refuse, unpin removes the label, a fresh preview clears it`, () => withOwnerSeam(async () => {
        const root = await interrupted(target, state);
        const before = await dataState(root);
        expect(await subjectBlocked(root)).toEqual({ pins: true, gc: true });
        expect(await dataState(root)).toEqual(before);
        expect(await codeOf(catalogUnpin(root, SUBJECT))).toBe("accepted");
        const after = await dataState(root);
        expect(labelEntries(after, SUBJECT)).toEqual({});
        expect(after).toEqual(outsideLabel(before, SUBJECT));
        expect(await subjectBlocked(root)).toEqual({ pins: false, gc: false });
      }), CASE_TIMEOUT_MS);
    }
  }
});

/** A refused layout: how to plant it on a fresh project. */
type Layout = (root: string) => Promise<void>;
const dir = (root: string) => labelDir(root);

const REFUSED: readonly (readonly [string, Layout])[] = [
  ["a bad last indexed copy", async (root) => { await interruptIndex(root, "R"); await writeFile(path.join(dir(root), (await copyNames(root)).at(-1)!), "{}\n", { flag: "a" }); }],
  ["a staged copy that is not the live manifest's exact bytes", async (root) => { const last = await interruptLastCopy(root, "R"); await writeFile(path.join(dir(root), `${last}.tmp`), "\n", { flag: "a" }); }],
  ["a copy alias beside an index name", async (root) => { const index = await readFile(path.join(dir(root), INDEX)); await interruptLastCopy(root, "R"); await writePrivate(path.join(dir(root), INDEX), index); }],
  ["a distinct-inode W+R pair", async (root) => { await interruptIndex(root, "W"); await writePrivate(path.join(dir(root), `${INDEX}.tmp`), await readFile(path.join(dir(root), `${INDEX}.writing`))); }],
  ["an alias linked from outside the label", async (root) => { await interruptIndex(root, "R"); await link(path.join(dir(root), `${INDEX}.tmp`), path.join(root, "outside-link")); }],
  ["a writer-impossible index (createdAt 42)", async (root) => { await interruptIndex(root, "R"); await rewriteIndex(root, (value) => { value.createdAt = 42; }); }],
  ["a truncated W index", async (root) => { await interruptIndex(root, "W"); const file = path.join(dir(root), `${INDEX}.writing`); await writePrivate(file, (await readFile(file)).subarray(0, 40)); }],
  ["F with an independent W", async (root) => { await writePrivate(path.join(dir(root), `${INDEX}.writing`), await readFile(path.join(dir(root), INDEX))); }],
  ["two interrupted groups", async (root) => { const last = await interruptLastCopy(root, "R"); const first = (await copyNames(root))[0]!; expect(first).not.toBe(last); await interrupt(dir(root), first, "W"); }],
  ["a symlinked alias", async (root) => { await interruptIndex(root, "R"); await rm(path.join(dir(root), `${INDEX}.tmp`)); await symlink(path.join(dir(root), (await copyNames(root))[0]!), path.join(dir(root), `${INDEX}.tmp`)); }],
];

/** Rewrite the subject's R index with `edit`, keeping the writer's key order and final newline. */
async function rewriteIndex(root: string, edit: (value: Record<string, unknown>) => void): Promise<void> {
  const file = path.join(dir(root), `${INDEX}.tmp`);
  const value = JSON.parse((await readFile(file)).toString("utf8")) as Record<string, unknown>;
  edit(value);
  await rm(file);
  await writePrivate(file, `${JSON.stringify(value)}\n`);
}

describe("anything else refuses before any effect and keeps every name, identity and byte", () => {
  for (const [label, plant] of REFUSED) {
    it(`refuses ${label}`, () => withOwnerSeam(async () => {
      const root = await pinProject(template);
      await plant(root);
      const before = await dataState(root);
      expect(await codeOf(catalogUnpin(root, SUBJECT))).not.toBe("accepted");
      expect(await dataState(root)).toEqual(before);
      expect((await subjectBlocked(root)).gc).toBe(true);
    }), CASE_TIMEOUT_MS);
  }
});

describe("the alias-free policy is unchanged", () => {
  it("an incomplete pin with an operator-created regular reserved copy still unpins", () => withOwnerSeam(async () => {
    const root = await pinProject(template);
    await rm(path.join(dir(root), INDEX));
    await writeFile(path.join(dir(root), "catalog.manifest"), "operator\n");
    const before = await dataState(root);
    expect(await codeOf(catalogUnpin(root, SUBJECT))).toBe("accepted");
    expect(await dataState(root)).toEqual(outsideLabel(before, SUBJECT));
    expect(labelEntries(await dataState(root), BYSTANDER)).toEqual(labelEntries(before, BYSTANDER));
  }), CASE_TIMEOUT_MS);
});
