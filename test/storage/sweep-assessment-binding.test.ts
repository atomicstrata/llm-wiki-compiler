/**
 * @file test/storage/sweep-assessment-binding.test.ts
 * @description The orphan sweep's assessment as the ONE body it already is,
 * `assessSweep` over `PruneAssessmentReads` and one lent lifecycle read, with no
 * project. The body existed before this file (it is only newly exported); this
 * file adds the memory witness it lacked.
 *
 * HOW IT IS BUILT. Hand-built lifecycle reads and memory assessment reads, each
 * call logged, pin the decision and its order: an unreadable capture and a
 * blocking prune unit refuse before the key; a pending sweep unit resumes under
 * the key without enumerating; otherwise the key is required before the orphan
 * walk, nothing to collect is its own sentinel, and the fresh plan is named by its
 * objects.
 *
 * NOT SHOWN HERE: the orphan walk, the gate re-run and the delete engine; the
 * sweep and lifecycle-driver suites show those.
 */

import { describe, expect, it } from "bun:test";
import { sweepUnitIdFor } from "../../src/preparations/prune-delete.js";
import { assessSweep, SweepUnobservableError, type PruneAssessmentReads } from "../../src/preparations/retention.js";

const KEY = { status: "ok", key: Buffer.alloc(32, 3), keyEpochId: `sha256:${"e".repeat(64)}` };
const ORPHAN = { logicalPath: "workspaces/research/runs/prr_x.json" } as never;

/** An ok capture whose prune registry holds `units` (registry/unitId/state/operation). */
const capture = (units: object[] = []) => ({
  status: "ok", snapshot: { complete: true, problems: [], units, storage: { prune: { health: "ok" }, quarantine: { health: "ok" } } },
}) as never;

/** Memory assessment reads answering `key` and `orphans`; each call logged, any other read fails the test. */
function readsOf(log: string[], key: object = KEY, orphans: object[] = [ORPHAN]): PruneAssessmentReads {
  const unasked = (name: string) => async () => { throw new Error(`unasked read ${name}`); };
  return {
    readKey: async () => { log.push("key"); return key as never; },
    enumerateSweepableOrphans: async (epoch) => { log.push(`orphans ${epoch === KEY.keyEpochId}`); return orphans as never; },
    readRun: unasked("readRun"), readBundleManifest: unasked("readBundleManifest"),
    pruneUnitStarted: unasked("pruneUnitStarted"), enumerateRunScope: unasked("enumerateRunScope"),
  };
}

/** The assessment's outcome over memory: its draft unit and object count, or the thrown class, and the log. */
async function assess(read: never, key?: object, orphans?: object[]) {
  const log: string[] = [];
  const outcome = await assessSweep(readsOf(log, key, orphans), {} as never, read).then(
    (assessment) => [assessment.draft.unitId, assessment.draft.objects.length, assessment.key?.keyEpochId],
    (error: Error) => error.constructor.name,
  );
  return [outcome, log];
}

describe("the sweep assessment over its reads and one capture", () => {
  it("W1 refuses an unreadable capture and a blocking prune unit before the key", async () => {
    const log: string[] = [];
    await expect(assessSweep(readsOf(log), {} as never, { status: "unavailable", detail: "x" } as never)).rejects.toThrow("prune registry cannot be enumerated");
    const blocked = capture([{ registry: "prune", unitId: "prn-1", state: "applying", operation: "prune" }]);
    await expect(assessSweep(readsOf(log), {} as never, blocked)).rejects.toBeInstanceOf(SweepUnobservableError);
    expect(log).toEqual([]);
  });

  it("W2 resumes a pending sweep unit under the key without walking for orphans", async () => {
    const pending = capture([{ registry: "prune", unitId: "swp-pending", state: "applying", operation: "orphan-sweep" }]);
    expect(await assess(pending)).toEqual([["swp-pending", 0, KEY.keyEpochId], ["key"]]);
  });

  it("W3 requires the key before the walk, names nothing to collect, and plans a fresh sweep named by its objects", async () => {
    expect([await assess(capture(), { status: "unavailable" }), await assess(capture(), KEY, [])]).toEqual([
      ["SweepKeyUnavailable", ["key"]], ["NothingToSweep", ["key", "orphans true"]],
    ]);
    expect(await assess(capture())).toEqual([[sweepUnitIdFor([ORPHAN]), 1, KEY.keyEpochId], ["key", "orphans true"]]);
  });
});
