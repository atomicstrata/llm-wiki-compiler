/**
 * @file test/preparations/prune-sweep-authority.test.ts
 * @description The four prune/sweep behaviours the Task 9E protocol map claims
 * and nothing proved.
 *
 * Exact-head review of the map found `provingTests` citations that named real
 * frozen ids which tested something else entirely — key-unavailable prune cited
 * the happy path, the completed-receipt short circuit cited sweep's partial
 * inventory. The map's control checks only that a cited id EXISTS, not that it
 * proves the row, so a false binding certified a row while looking green.
 *
 * That is the map's whole value gone: it is C1b's preservation contract, and a
 * contract citing the wrong evidence cannot detect the regression it exists to
 * detect. These four behaviours had NO test anywhere, which is why the citations
 * were wrong rather than merely imprecise — there was nothing correct to cite.
 *
 * A separate file so `prune-sweep.test.ts` keeps its frozen `fileSha256`
 * untouched: re-freezing a pinned digest in the same commit that edits the file
 * is exactly the move the frozen-corpus rules forbid.
 */

import { chmod } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { useTempRoot } from "../fixtures/temp-root.js";
import {
  prunePreparationRunLocked, PreparationPruneError, sweepPreparationOrphansLocked,
  type LifecycleClock,
} from "../../src/preparations/retention.js";
import { pruneUnitIdFor, sweepUnitIdFor } from "../../src/preparations/prune-delete.js";
import { driveToFailed, gateDecision, LIFECYCLE_ACTOR, stagePreparation, stageAndCrashPrune } from "./lifecycle-fixture.js";

const AT = "2026-07-20T07:00:00.000Z";
const AFTER_FLOOR: LifecycleClock = { now: () => new Date("2026-07-01T00:00:00.000Z") };

/** Make the epoch key unreadable, which is the only way to fail the key read. */
async function blindTheKey(root: string): Promise<void> {
  await chmod(path.join(root, ".llmwiki", "preparation-runs.runkey"), 0o000);
}

describe("prune and sweep authority preconditions", () => {
  const root = useTempRoot();

  it("refuses a prune outright when the governing key cannot be read", async () => {
    // PLA-MAP-PRN02. The map cited the happy-path prune, which reads the key
    // successfully and therefore proves nothing about this branch.
    const { binding } = await stagePreparation(root.dir);
    await driveToFailed(root.dir, binding);
    await blindTheKey(root.dir);
    await expect(prunePreparationRunLocked(root.dir, {
      // A FRESH PRUNE OF THIS RUN: no unit is pending, so the gate authorizes with
      // a null ticket, and the target is DERIVED -- omitting it names a decision
      // the gate refuses outright.
      authorization: gateDecision("prune", pruneUnitIdFor(binding.runId)),
      target: { kind: "run" as const, binding }, actor: LIFECYCLE_ACTOR, at: AT, clock: AFTER_FLOOR,
    })).rejects.toMatchObject({ code: "key-unavailable" });
    await chmod(path.join(root.dir, ".llmwiki", "preparation-runs.runkey"), 0o600);
  });

  it("sweeps nothing at all when the key cannot classify owners", async () => {
    // PLA-MAP-SWP04. Sweep FAILS CLOSED TO ZERO deletions rather than to a
    // partial sweep — and it now says WHICH fail-closed answer this is. It used
    // to return `null`, the same value it returns for "nothing to do", so the
    // caller could not tell an empty project from an unreadable key; a surface
    // reporting the first for the second tells an operator something false.
    await stagePreparation(root.dir);
    await blindTheKey(root.dir);
    const swept = await sweepPreparationOrphansLocked(root.dir, {
      actor: LIFECYCLE_ACTOR, at: AT, authorization: gateDecision("sweep"),
    });
    expect(swept.status).toBe("key-unavailable");
    await chmod(path.join(root.dir, ".llmwiki", "preparation-runs.runkey"), 0o600);
  });

  it("returns the identical completed receipt on a repeated prune instead of re-deleting", async () => {
    // PLA-MAP-PRN05. The completed-receipt short circuit is what makes prune
    // idempotent under repetition; the map cited sweep's partial-inventory
    // refusal, which never reaches this branch.
    const { binding } = await stagePreparation(root.dir);
    await driveToFailed(root.dir, binding);
    // ONE AUTHORIZATION SERVES BOTH CALLS, and that is the property under test:
    // the first prune completes, leaving a COMPLETED receipt and no pending unit,
    // so the second is authorized identically -- fresh, same derived target. If
    // the first had left the unit pending, the second would be a resume and
    // sharing this would claim a fresh start the driver now refuses.
    const request = {
      authorization: gateDecision("prune", pruneUnitIdFor(binding.runId)),
      target: { kind: "run" as const, binding }, actor: LIFECYCLE_ACTOR, at: AT, clock: AFTER_FLOOR,
    };
    const first = await prunePreparationRunLocked(root.dir, request);
    const second = await prunePreparationRunLocked(root.dir, request);
    expect(second.kind).toBe("prune-completed");
    // Byte-identical, not merely "also completed": a re-derived receipt would
    // still say completed while attesting a freshly enumerated object set.
    expect(second).toEqual(first);
  });

  it("blocks a sweep while a genuinely unfinished prune unit is present", async () => {
    // PLA-MAP-SWP03. An unfinished PRUNE is not swept past. The map cited the
    // unreadable-owner test, which is a different refusal on a different leg.
    //
    // The unit must be a REAL unfinished prune -- a signed planned receipt with no
    // completed one. My first attempt just planted a staged file, which refuses
    // with "holds durable contents with no authenticated plan": a genuine refusal,
    // but a DIFFERENT one, and it would have certified this row while testing
    // another branch. That is the same false-binding this file exists to correct.
    await stageAndCrashPrune(root.dir, AT, "afterPlanned");
    await expect(sweepPreparationOrphansLocked(root.dir, {
      actor: LIFECYCLE_ACTOR, at: AT, authorization: gateDecision("sweep"),
    })).rejects.toThrow(/is an unfinished run-prune operation; complete it before sweeping/u);
  });

  it("derives a sweep unit id from the object SET, not the enumeration order", async () => {
    // `sweepUnitIdFor`'s docblock calls the derivation "load-bearing, not
    // cosmetic", and the sort was untested: removing it left every test green.
    // The sort is what makes the id a function of the SET rather than the
    // sequence, and SWP01's resume-before-derive design hinges on that id being
    // stable -- an id that moved with enumeration order would strand the original
    // unit with staged bytes and no completed receipt.
    const objects = [
      { sourcePath: "/b", logicalPath: "b", byteCount: 1, digest: null },
      { sourcePath: "/a", logicalPath: "a", byteCount: 1, digest: null },
    ];
    const reversed = [...objects].reverse();
    expect(sweepUnitIdFor(objects)).toBe(sweepUnitIdFor(reversed));
    // The negative control: a DIFFERENT set must still give a different id, or
    // the assertion above would also hold for a constant.
    expect(sweepUnitIdFor(objects)).not.toBe(sweepUnitIdFor([objects[0]!]));
  });
});
