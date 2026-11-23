/**
 * @file test/segments/retire-barrier-recovery.test.ts
 * @description An interrupted retirement-barrier publication (IDX-1, slice 1)
 * through the PUBLIC run-report reader and a FRESH retirement preview and
 * apply, in this process.
 *
 * READER: a visible F+R whose owner is positively stale (signal 0 ESRCH)
 * passes an ordinary report read and is left untouched; one whose owner is
 * this live process without an identity still refuses
 * `indexed_retirement_in_progress`.
 *
 * RETIREMENT (an active `local-indexed` record and an indexed directory with
 * no run stores, so the plan has no candidate and the apply isolates the
 * barrier): each stale state the writer
 * can leave (complete W, W+R, R, R+F) leaves the preview admissible (the
 * public preview carries no stale flag), and the apply clears exactly those names, publishes and releases
 * its own barrier, and leaves all three reserved names absent. Every other
 * group refuses before any publication and keeps the exact names, bytes,
 * modes and inodes: a truncated W, a wrong mode, a foreign inode or a third
 * link, F beside W, non-canonical bytes, a foreign host, and owners that are
 * uncertain (live, no identity) or unprovable (EPERM).
 *
 * FIXTURES. The report project is built once (a durable run) in a template
 * and copied; the copy drops the template's own reader leases so this process
 * never registered on the copied root. The retirement roots are never read by
 * this process before the apply, so it is an admissible collector there.
 *
 * LABELLED SEAM: `serializeOwner` is spied to a deterministic own-PID record
 * (the `test/portable/scale-first-open.test.ts` seam) for the raw lock, the
 * reader lease and the published barrier; no native start-time probe runs.
 * The stale owner's ESRCH is a real kernel answer.
 */

import { describe, expect, it, afterAll, beforeAll } from "bun:test";
import { readReport, report } from "../../src/compiler/batch/report.js";
import { applyRunRetirement, previewRunRetirement } from "../../src/indexed/run-retire.js";
import * as lockOwner from "../../src/utils/lock-owner.js";
import { newScratchBatchRun } from "../batch/scratch-run.js";
import { copyProjectTemplate, ownPidOwnerSeamPerTest, ownPidSerializeOwnerSpy, privateRoots } from "../fixtures/scoped-test-roots.js";
import {
  activeIndexedProject, barrierBytes, barrierNameState, DENIED_OWNER, NO_BARRIER_NAMES, plantBarrier, STALE_OWNER, UNCERTAIN_OWNER, type PlantedState,
} from "./barrier-publication-fixture.js";

/** Durable commits on the test volume. */
const CASE_TIMEOUT_MS = 120_000;
const { privateDir, cleanup } = privateRoots("llmwiki-barrier-recovery-");
let template = "";
let runId = "";

beforeAll(async () => {
  const owner = ownPidSerializeOwnerSpy();
  template = await privateDir();
  const run = await newScratchBatchRun(template);
  await report(run, { kind: "compiled", file: "kept.md" });
  await run.advance("done");
  runId = run.runId;
  owner.mockRestore();
}, CASE_TIMEOUT_MS);
ownPidOwnerSeamPerTest();
afterAll(cleanup);

/** A copy of the report project this process never registered on. */
const reportProject = (): Promise<string> => copyProjectTemplate(template, privateDir);

/** An active indexed project with no run stores (a retirement plan with no candidate). */
const retirementProject = (): Promise<string> => activeIndexedProject(privateDir);

/** The refusal code of `work`, or `accepted`. */
function codeOf(work: Promise<unknown>): Promise<string> {
  return work.then(() => "accepted", (error: { code?: string }) => error.code ?? String(error));
}

describe("an ordinary report read and an interrupted barrier", () => {
  it("passes a positively stale F+R pair and leaves it untouched", async () => {
    const root = await reportProject();
    await plantBarrier(root, "RF", barrierBytes(STALE_OWNER));
    const before = await barrierNameState(root);
    expect((await readReport(root, runId)).lines).toEqual([{ kind: "compiled", file: "kept.md" }]);
    expect(await barrierNameState(root)).toEqual(before);
    expect(lockOwner.serializeOwner).toHaveBeenCalledWith(process.pid);
  }, CASE_TIMEOUT_MS);

  it("still refuses an F+R pair whose owner is live but unidentifiable", async () => {
    const root = await reportProject();
    await plantBarrier(root, "RF", barrierBytes(UNCERTAIN_OWNER));
    const before = await barrierNameState(root);
    expect(await codeOf(readReport(root, runId))).toBe("indexed_retirement_in_progress");
    expect(await barrierNameState(root)).toEqual(before);
  }, CASE_TIMEOUT_MS);
});

describe("a fresh retirement apply clears exactly a stale interrupted barrier", () => {
  for (const state of ["W", "WR", "R", "RF"] as const) {
    it(`clears a stale ${state} group, publishes and releases its own barrier`, async () => {
      const root = await retirementProject();
      await plantBarrier(root, state, barrierBytes(STALE_OWNER));
      const preview = await previewRunRetirement(root, { keepFinished: 0 });
      expect([preview.admissible, preview.blockers]).toEqual([true, []]);
      expect(await applyRunRetirement(root, preview.plan, { readersOffline: true })).toMatchObject({ retired: [], cleaned: 0 });
      expect(await barrierNameState(root)).toEqual(NO_BARRIER_NAMES);
    }, CASE_TIMEOUT_MS);
  }
});

/** The refused layouts: [label, state, bytes, mode]. */
const REFUSED: readonly (readonly [string, PlantedState, string, number])[] = [
  ["a truncated W", "W", barrierBytes(STALE_OWNER).slice(0, 40), 0o600],
  ["a wrong-mode R", "R", barrierBytes(STALE_OWNER), 0o644],
  ["a foreign-inode R+F", "RF-foreign-inode", barrierBytes(STALE_OWNER), 0o600],
  ["a third link on R+F", "RF-third-link", barrierBytes(STALE_OWNER), 0o600],
  ["F beside W", "FW", barrierBytes(STALE_OWNER), 0o600],
  ["non-canonical R bytes", "R", barrierBytes(STALE_OWNER).replace("\n", " \n"), 0o600],
  ["a foreign-host R", "R", barrierBytes(STALE_OWNER, { host: "ffffffff" }), 0o600],
  ["an uncertain-owner R", "R", barrierBytes(UNCERTAIN_OWNER), 0o600],
  ["an EPERM-owner R", "R", barrierBytes(DENIED_OWNER), 0o600],
];

describe("anything else refuses before publication and keeps every name", () => {
  for (const [label, state, bytes, mode] of REFUSED) {
    it(`refuses ${label}`, async () => {
      const root = await retirementProject();
      await plantBarrier(root, state, bytes, mode);
      const before = await barrierNameState(root);
      const preview = await previewRunRetirement(root, { keepFinished: 0 });
      expect(preview.admissible).toBe(false);
      expect(await codeOf(applyRunRetirement(root, preview.plan, { readersOffline: true }))).toBe("indexed_runs_blocked");
      expect(await barrierNameState(root)).toEqual(before);
    }, CASE_TIMEOUT_MS);
  }
});
