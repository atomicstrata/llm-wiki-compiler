/**
 * @file test/scale/scale-missing-authority.test.ts
 * @description A scale update never takes a lost or unreadable scale record
 * for a new project while indexed authority may still exist (SCALE-1).
 *
 * FIXTURE: a genuine ACTIVE `local-indexed` project, built once by the real
 * catalog, history and vector bodies (`../catalog/helpers.ts`) over three
 * sources and no pages (page wikilink parsing loads a package outside the
 * guarded closure), whose `.llmwiki/scale.json` is then removed. The retained
 * `.llmwiki/indexed` stores and the stale incumbent sources are its
 * witnesses. Each case runs on its own copy with no downgrade, restore,
 * journal, portable or operation state.
 *
 * REFUSALS: the public disk `scale set` (documents 100, expected revision 0),
 * the SDK `wiki.scale.set`, the read-only preview and the quickstart estimate
 * step (which delegates to init and `scale set`) must refuse typed
 * `scale_state_unreadable`. No scale record may appear, no file may change,
 * the raw lock must be released (no `.llmwiki/lock` left), and the ordinary
 * gate and indexed routing must still refuse. An UNREADABLE record must
 * refuse before any mutating recovery leg: the journal recovery and the
 * handoff settlement are spied (call-through) and must not run.
 *
 * CONTROLS: a clean project with neither record nor indexed stores, a pending
 * `local-indexed` transition whose stores already exist, and an unavailable
 * estimate are all still updated (and the spied journal leg runs for them).
 *
 * LABELLED SEAM: `serializeOwner` is spied to a deterministic own-PID record
 * (the `test/portable/scale-first-open.test.ts` seam) for the raw lock and
 * reader leases; no native start-time probe runs.
 */

import { createHash } from "node:crypto";
import { cp, lstat, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { routedListPages } from "../../src/catalog/routes.js";
import * as preparations from "../../src/preparations/recovery.js";
import { SCALE_RECORD_FILE } from "../../src/scale/contracts.js";
import { scaleGateRefusal } from "../../src/scale/gate.js";
import { parseSizeBytes } from "../../src/scale/plan.js";
import { previewScaleTransition } from "../../src/scale/preview.js";
import { quickstartScaleSetup } from "../../src/scale/quickstart-setup.js";
import { setExpectedScale } from "../../src/scale/transition.js";
import { buildScaleFacade } from "../../src/sdk/scale-facade.js";
import * as journal from "../../src/trust/journal-recovery.js";
import * as lockOwner from "../../src/utils/lock-owner.js";
import { activateIndexed, prepareIndexedActivation, writeCorpus } from "../catalog/helpers.js";
import { ownPidSerializeOwnerSpy, privateRoots, restoreAll, type Restorable } from "../fixtures/scoped-test-roots.js";
import { refusalCodeOf } from "./cancel-helpers.js";

/** Real catalog, history and vector bodies on the test volume. */
const CASE_TIMEOUT_MS = 120_000;
const SET = { request: { documents: 100 }, expectedRevision: 0 };
const { privateDir, cleanup } = privateRoots("llmwiki-scale-authority-");
const spies: Restorable[] = [];
let template = "";
let seams: { journal: { mock: { calls: unknown[] } }; handoffs: { mock: { calls: unknown[] } } };

beforeAll(async () => {
  const owner = ownPidSerializeOwnerSpy();
  template = await privateDir();
  await writeCorpus(template, 0, 3);
  await activateIndexed(template);
  await rm(path.join(template, SCALE_RECORD_FILE));
  owner.mockRestore();
}, CASE_TIMEOUT_MS);
beforeEach(() => {
  spies.push(ownPidSerializeOwnerSpy());
  const recover = spyOn(journal, "recoverJournalBeforeCompile");
  const settle = spyOn(preparations, "settlePreparationHandoffsLocked");
  spies.push(recover, settle);
  seams = { journal: recover, handoffs: settle };
});
afterEach(() => { restoreAll(spies); });
afterAll(cleanup);

/** A fresh copy of the record-less indexed project. */
async function lostAuthority(): Promise<string> {
  const root = path.join(await privateDir(), "wiki");
  await cp(template, root, { recursive: true });
  return root;
}

/** Every regular file (inode and bytes) and every entry name under `root`: the witnesses a refused update must keep. */
async function projectState(root: string): Promise<Record<string, string>> {
  const state: Record<string, string> = {};
  for (const name of await readdir(root, { recursive: true })) {
    const file = path.join(root, name);
    const info = await lstat(file, { bigint: true });
    state[name] = info.isFile() ? `${info.ino}:${createHash("sha256").update(await readFile(file)).digest("hex")}` : "entry";
  }
  return state;
}

/** Require a typed refusal that changed nothing, released the lock and left ordinary admission refusing. */
async function expectRefusedUnchanged(root: string, before: Record<string, string>, code: Promise<string>): Promise<void> {
  expect(await code).toBe("scale_state_unreadable");
  expect(await projectState(root)).toEqual(before);
  expect(before[SCALE_RECORD_FILE]).toBeUndefined();
  expect(before[".llmwiki/lock"]).toBeUndefined();
  expect(await scaleGateRefusal(root)).toMatchObject({ block: "scale-state-unreadable" });
  await expect(routedListPages(root)).rejects.toMatchObject({ block: "scale-state-unreadable" });
}

describe("a lost scale record with retained indexed stores is never relabelled", () => {
  it("keeps genuine indexed and stale incumbent witnesses in the fixture", async () => {
    const state = await projectState(await lostAuthority());
    expect(Object.keys(state)).toEqual(expect.arrayContaining([".llmwiki/indexed/catalog/manifest.json", "sources/src-00000.md", "sources/src-00002.md"]));
    expect(state[SCALE_RECORD_FILE]).toBeUndefined();
  }, CASE_TIMEOUT_MS);

  it("the public disk scale set refuses typed and writes nothing", async () => {
    const root = await lostAuthority();
    const before = await projectState(root);
    await expectRefusedUnchanged(root, before, refusalCodeOf(setExpectedScale(root, SET)));
    expect(lockOwner.serializeOwner).toHaveBeenCalledWith(process.pid);
  }, CASE_TIMEOUT_MS);

  it("the SDK scale set refuses typed and writes nothing", async () => {
    const root = await lostAuthority();
    const before = await projectState(root);
    const sdk = buildScaleFacade(root, (fn) => fn());
    await expectRefusedUnchanged(root, before, refusalCodeOf(sdk.set({ documents: 100, expectedRevision: 0 })));
  }, CASE_TIMEOUT_MS);

  it("the preview refuses instead of promising a new record", async () => {
    const root = await lostAuthority();
    const before = await projectState(root);
    await expectRefusedUnchanged(root, before, refusalCodeOf(previewScaleTransition(root, { documents: 100 })));
  }, CASE_TIMEOUT_MS);

  it("the quickstart estimate step stops with the typed code and writes nothing", async () => {
    const root = await lostAuthority();
    const before = await projectState(root);
    const failure = quickstartScaleSetup(root, { expectedDocuments: "100" }).then((result) => result?.error.code ?? "accepted");
    await expectRefusedUnchanged(root, before, failure);
  }, CASE_TIMEOUT_MS);

  it("an unreadable record refuses before any mutating recovery leg runs", async () => {
    const root = await lostAuthority();
    await writeFile(path.join(root, SCALE_RECORD_FILE), "{ not a scale record");
    const before = await projectState(root);
    expect(await refusalCodeOf(setExpectedScale(root, SET))).toBe("scale_state_unreadable");
    expect([seams.journal.mock.calls.length, seams.handoffs.mock.calls.length]).toEqual([0, 0]);
    expect(await projectState(root)).toEqual(before);
  }, CASE_TIMEOUT_MS);
});

describe("legitimate updates still proceed", () => {
  it("a clean project with no record and no indexed stores gets its first standard record", async () => {
    const root = await privateDir();
    const report = await setExpectedScale(root, SET);
    expect(report).toMatchObject({ readiness: "ready", record: { revision: 1, active: { architecture: "local-standard" } } });
    expect(seams.journal.mock.calls.length).toBeGreaterThan(0);
  }, CASE_TIMEOUT_MS);

  it("a pending local-indexed transition whose stores exist is still superseded under its revision", async () => {
    const root = await privateDir();
    await writeCorpus(root, 0, 1);
    await prepareIndexedActivation(root);
    const report = await setExpectedScale(root, { request: { documents: 100 }, expectedRevision: 1, prepare: false });
    expect(report.record).toMatchObject({ revision: 2 });
  }, CASE_TIMEOUT_MS);

  it("an unavailable estimate is still recorded and then lowered", async () => {
    const root = await privateDir();
    expect((await setExpectedScale(root, { request: { sizeBytes: parseSizeBytes("2TB") } })).record?.pending).toMatchObject({ kind: "unavailable" });
    expect((await setExpectedScale(root, { request: { documents: 100 }, expectedRevision: 1 })).record).toMatchObject({ revision: 2, pending: null });
  }, CASE_TIMEOUT_MS);
});
