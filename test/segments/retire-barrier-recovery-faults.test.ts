/**
 * @file test/segments/retire-barrier-recovery-faults.test.ts
 * @description Two root findings on the IDX-1 slice 1 barrier recovery,
 * reproduced through the public paths.
 *
 * IDX1-ROOT-1 (partial effects): a fresh retirement apply discarding a stale
 * W+R (or R+F) group whose directory sync fails IMMEDIATELY after the first
 * successful unlink must stop at once and report exactly the removed name:
 * the predecessor is gone, the survivor keeps its bytes and inode, nothing
 * later is unlinked, and no new barrier is published.
 *
 * IDX1-ROOT-2 (canonical epoch): the writer records `unix:<n>` from a number,
 * so its identity never carries leading zeros. A writer-shaped barrier whose
 * owner is present (labelled seam) with a recorded `unix:0123` while the
 * current identity reads `unix:123` names the SAME epoch: it must not pass an
 * ordinary report read, nor be cleared by a retirement, and nothing may
 * change.
 *
 * BAR-3 / BAR-4 (independent review): a BOM-prefixed stale R must not be
 * cleared, a BOM-prefixed stale R+F must not pass a report read or the
 * retirement inventory, and a valid stale single-link F beside an
 * independent R or W must not pass a report read; nothing may change and no
 * new barrier may appear. A sync failure after the SECOND unlink reports both
 * removals. Through the owner seam, a canonical equal or an unknown current
 * identity refuses, while a distinct canonical one permits the recovery.
 *
 * LABELLED SEAMS, each scoped to its test and restored in `finally`:
 * `serializeOwner` (own-PID record, raw lock, lease and barrier); a
 * call-through `fsyncDirectoryChain` that throws once, at the first sync after
 * the first unlink; and `ownerObservation` (present pid, chosen current
 * identity). No native start-time probe runs.
 */

import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { readReport, report } from "../../src/compiler/batch/report.js";
import { applyRunRetirement, previewRunRetirement } from "../../src/indexed/run-retire.js";
import * as barrierModule from "../../src/segments/retire-barrier.js";
import { newScratchBatchRun } from "../batch/scratch-run.js";
import { copyProjectTemplate, privateRoots, withOwnPidOwnerSeam as withOwnerSeam } from "../fixtures/scoped-test-roots.js";
import { failDirectorySyncWhen } from "../fixtures/sync-fault.js";
import { activeIndexedProject, BARRIER_NAMES, barrierBytes, barrierNameState, plantBarrier, STALE_OWNER } from "./barrier-publication-fixture.js";

/** Durable commits on the test volume. */
const CASE_TIMEOUT_MS = 120_000;
const INJECTED = "injected directory sync failure after the first unlink";
/** A present owner whose recorded epoch is zero-padded (no writer produces this). */
const PADDED_OWNER = { pid: 4242, identity: "unix:0123" };
const { privateDir, cleanup } = privateRoots("llmwiki-barrier-faults-");
let template = "";
let runId = "";

beforeAll(() => withOwnerSeam(async () => {
  template = await privateDir();
  const run = await newScratchBatchRun(template);
  await report(run, { kind: "compiled", file: "kept.md" });
  await run.advance("done");
  runId = run.runId;
}), CASE_TIMEOUT_MS);
afterAll(cleanup);

/** An active indexed project with no run stores (a retirement plan with no candidate). */
const retirementProject = (): Promise<string> => activeIndexedProject(privateDir);

/** A copy of the report project this process never registered on. */
const reportProject = (): Promise<string> => copyProjectTemplate(template, privateDir);

/** The refusal of `work`: its code and message (`accepted` when it did not refuse). */
function refusalOf(work: Promise<unknown>): Promise<{ code: string; message: string }> {
  return work.then(() => ({ code: "accepted", message: "" }), (error: { code?: string; message?: string }) => ({ code: error.code ?? String(error), message: error.message ?? "" }));
}

/** Fail the first directory sync once every `gone` name is absent and every `kept` one present; otherwise call through. */
const failSyncWhen = (root: string, gone: readonly string[], kept: readonly string[]): { mockRestore(): void } => failDirectorySyncWhen(root, gone, kept, INJECTED);

/** Apply a retirement of `root` with the sync fault armed for `gone`/`kept`; returns the refusal. */
async function applyWithSyncFault(root: string, gone: readonly string[], kept: readonly string[]): Promise<{ code: string; message: string }> {
  const preview = await previewRunRetirement(root, { keepFinished: 0 });
  const fault = failSyncWhen(root, gone, kept);
  try { return await refusalOf(applyRunRetirement(root, preview.plan, { readersOffline: true })); } finally { fault.mockRestore(); }
}

describe("a sync failure right after the first unlink reports exactly what was removed", () => {
  for (const [state, gone, kept] of [["WR", "W", "R"], ["RF", "R", "F"]] as const) {
    it(`stops a stale ${state} discard after removing only ${gone}`, () => withOwnerSeam(async () => {
      const root = await retirementProject();
      await plantBarrier(root, state, barrierBytes(STALE_OWNER));
      const before = await barrierNameState(root);
      const refused = await applyWithSyncFault(root, [BARRIER_NAMES[gone]], [BARRIER_NAMES[kept]]);
      expect(refused.message).toContain(INJECTED);
      expect(refused.message).toContain(`removed before stopping: ${gone}`);
      const after = await barrierNameState(root);
      expect([after[gone], after[kept]?.split(":").slice(2).join(":")]).toEqual([null, before[kept]?.split(":").slice(2).join(":")]);
      expect(after[kept]?.split(":")[0]).toBe(before[kept]?.split(":")[0]);
    }), CASE_TIMEOUT_MS);
  }

  it("reports both removals when the sync after the second unlink fails", () => withOwnerSeam(async () => {
    const root = await retirementProject();
    await plantBarrier(root, "WR", barrierBytes(STALE_OWNER));
    const refused = await applyWithSyncFault(root, [BARRIER_NAMES.W, BARRIER_NAMES.R], []);
    expect(refused.message).toContain("removed before stopping: W, R");
    expect(await barrierNameState(root)).toEqual({ F: null, R: null, W: null });
  }), CASE_TIMEOUT_MS);
});

/** Run `body` with the labelled owner seam answering `present` and current identity `current`, restored afterwards. */
async function withPresentOwner<T>(body: () => Promise<T>, current: string | null = "unix:123"): Promise<T> {
  const signal = spyOn(barrierModule.ownerObservation, "signal").mockImplementation(() => "present");
  const identity = spyOn(barrierModule.ownerObservation, "startIdentity").mockImplementation(() => current);
  try { return await body(); } finally { signal.mockRestore(); identity.mockRestore(); }
}

/** Require a retirement of `root` to be refused before publication with every reserved name unchanged. */
async function expectRetirementRefused(root: string): Promise<void> {
  const before = await barrierNameState(root);
  const preview = await previewRunRetirement(root, { keepFinished: 0 });
  expect(preview.admissible).toBe(false);
  expect((await refusalOf(applyRunRetirement(root, preview.plan, { readersOffline: true }))).code).toBe("indexed_runs_blocked");
  expect(await barrierNameState(root)).toEqual(before);
}

/** Require an ordinary report read of `root` to refuse while a retirement is in progress, changing no barrier name. */
async function expectReportRefused(root: string): Promise<void> {
  const before = await barrierNameState(root);
  expect((await refusalOf(readReport(root, runId))).code).toBe("indexed_retirement_in_progress");
  expect(await barrierNameState(root)).toEqual(before);
}

describe("an equivalent zero-padded epoch never proves a present owner stale", () => {
  it("an ordinary report read still refuses the F+R pair and changes nothing", () => withOwnerSeam(() => withPresentOwner(async () => {
    const root = await reportProject();
    await plantBarrier(root, "RF", barrierBytes(PADDED_OWNER));
    await expectReportRefused(root);
  })), CASE_TIMEOUT_MS);

  it("a retirement refuses the R group and changes nothing", () => withOwnerSeam(() => withPresentOwner(async () => {
    const root = await retirementProject();
    await plantBarrier(root, "R", barrierBytes(PADDED_OWNER));
    await expectRetirementRefused(root);
  })), CASE_TIMEOUT_MS);

  for (const [label, current] of [["a canonical equal", "unix:123"], ["an unknown", null]] as const) {
    it(`${label} current identity refuses the retirement of a present owner's R`, () => withOwnerSeam(() => withPresentOwner(async () => {
      const root = await retirementProject();
      await plantBarrier(root, "R", barrierBytes({ pid: 4242, identity: "unix:123" }));
      await expectRetirementRefused(root);
    }, current)), CASE_TIMEOUT_MS);
  }

  it("a distinct canonical current identity permits the recovery of the R group", () => withOwnerSeam(() => withPresentOwner(async () => {
    const root = await retirementProject();
    await plantBarrier(root, "R", barrierBytes({ pid: 4242, identity: "unix:100" }));
    const preview = await previewRunRetirement(root, { keepFinished: 0 });
    expect(await refusalOf(applyRunRetirement(root, preview.plan, { readersOffline: true }))).toEqual({ code: "accepted", message: "" });
    expect(await barrierNameState(root)).toEqual({ F: null, R: null, W: null });
  }, "unix:123")), CASE_TIMEOUT_MS);
});

/** Bytes the writer never emits: an otherwise exact stale barrier behind a UTF-8 byte order mark. */
const BOM_STALE = `\uFEFF${barrierBytes(STALE_OWNER)}`;

describe("bytes the writer never emitted and visible ambiguous aliases refuse (BAR-3, BAR-4)", () => {
  for (const [label, state] of [["a BOM-prefixed stale R", "R"], ["a BOM-prefixed stale R+F", "RF"]] as const) {
    it(`${label} blocks the retirement and changes nothing`, () => withOwnerSeam(async () => {
      const root = await retirementProject();
      await plantBarrier(root, state, BOM_STALE);
      await expectRetirementRefused(root);
    }), CASE_TIMEOUT_MS);
  }

  const READER_CASES = [["a BOM-prefixed stale R+F", "RF", BOM_STALE], ["a stale F beside an independent R", "RF-foreign-inode", barrierBytes(STALE_OWNER)], ["a stale F beside an independent W", "FW", barrierBytes(STALE_OWNER)]] as const;
  for (const [label, state, bytes] of READER_CASES) {
    it(`an ordinary report read refuses ${label} and changes nothing`, () => withOwnerSeam(async () => {
      const root = await reportProject();
      await plantBarrier(root, state, bytes);
      await expectReportRefused(root);
    }), CASE_TIMEOUT_MS);
  }
});
