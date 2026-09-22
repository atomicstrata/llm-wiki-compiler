/**
 * @file test/preparations/purge-authority.test.ts
 * @description The two properties Task 9E chunk C2 adds to purge.
 *
 * A separate file so `quarantine.test.ts` keeps its frozen `fileSha256` untouched
 * — re-freezing a pinned digest in the same commit that edits the file is the move
 * the frozen-corpus rules forbid.
 */

import path from "node:path";
import { chmod, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { useTempRoot } from "../fixtures/temp-root.js";
import { preparationQuarantineUnitPaths } from "../../src/preparations/paths.js";
import {
  perRunQuarantineUnitId, purgeQuarantineUnitLocked, quarantinePreparationRunLocked,
} from "../../src/preparations/quarantine.js";
import { LIFECYCLE_ACTOR, stagePreparation, tamperRun } from "./lifecycle-fixture.js";

const AT = "2026-07-20T07:00:00.000Z";

/** Quarantine one integrity-invalid run and return its settled unit id. */
async function quarantinedUnit(root: string): Promise<string> {
  const { binding } = await stagePreparation(root);
  await tamperRun(root, binding);
  await quarantinePreparationRunLocked(root, {
    binding, actor: LIFECYCLE_ACTOR, at: AT, confirmResidualState: true,
  });
  return perRunQuarantineUnitId(binding.runId);
}

describe("purge under the driver", () => {
  const root = useTempRoot();

  it("refuses a unit holding bytes its receipt does not name", async () => {
    // Design §10.6: purge "rejects unknown unit contents instead of recursively
    // destroying them". Before C2 the destroy walked only the receipt's own list
    // and never looked at what else was there -- so an unexpected file survived
    // silently while the operation reported the unit destroyed.
    //
    // Refusing beats deleting the extra: nobody signed for those bytes, and this
    // is the one operation that cannot be undone.
    const unitId = await quarantinedUnit(root.dir);
    const paths = preparationQuarantineUnitPaths(root.dir, unitId);
    await writeFile(path.join(paths.bytesRoot, "not-in-the-receipt"), "stowaway");
    await expect(purgeQuarantineUnitLocked(root.dir, {
      unitId, actor: LIFECYCLE_ACTOR, at: AT, confirmDestroy: true,
    })).rejects.toMatchObject({ code: "unit-unavailable" });
  });

  it("still purges a unit whose contents exactly match its receipt", async () => {
    // The negative control. Without it the refusal above would also pass against
    // an implementation that refused every purge -- which is the shape of guard
    // this task has shipped before.
    const unitId = await quarantinedUnit(root.dir);
    await expect(purgeQuarantineUnitLocked(root.dir, {
      unitId, actor: LIFECYCLE_ACTOR, at: AT, confirmDestroy: true,
    })).resolves.toBeUndefined();
  });

  it("leaves the root usable for the NEXT operation after a purge refuses", async () => {
    // Routing purge through the driver put it under the root-keyed in-flight
    // guard, which is new held state for this operation. A guard that wedges the
    // system it protects is a worse defect than the one it closes, and this task
    // has built that defect twice. The guard releases in a `finally`; this is what
    // proves it, by driving a refusal and then a completing operation on one root.
    const blocked = await quarantinedUnit(root.dir);
    const paths = preparationQuarantineUnitPaths(root.dir, blocked);
    await writeFile(path.join(paths.bytesRoot, "stowaway"), "x");
    await expect(purgeQuarantineUnitLocked(root.dir, {
      unitId: blocked, actor: LIFECYCLE_ACTOR, at: AT, confirmDestroy: true,
    })).rejects.toBeTruthy();

    const next = await quarantinedUnit(root.dir);
    await expect(purgeQuarantineUnitLocked(root.dir, {
      unitId: next, actor: LIFECYCLE_ACTOR, at: AT, confirmDestroy: true,
    })).resolves.toBeUndefined();
  });

  it("refuses to destroy when the bytes root cannot be READ, rather than reading it as empty", async () => {
    // The absent-vs-unreadable split was a hollow control: collapsing it to
    // `read.kind === "entries" ? names : []` left every test green. Under that
    // mutation an unreadable bytes root reads as "nothing unknown here", the
    // destroy proceeds, and a stowaway survives while the operation reports the
    // unit destroyed -- restoring the exact pre-C2 defect through a fail-OPEN leg.
    //
    // Absent is a completed or resumed purge. Unreadable is not evidence of
    // anything, and must never be read as evidence of absence.
    const unitId = await quarantinedUnit(root.dir);
    const paths = preparationQuarantineUnitPaths(root.dir, unitId);
    await chmod(paths.bytesRoot, 0o300); // +wx, -r: readdir gives EACCES
    try {
      // The MESSAGE, not just the code. `purgeQuarantineUnitLocked` wraps every
      // failure as `unit-unavailable`, so asserting the code alone passes for any
      // reason at all -- verified: collapsing the absent/unreadable split still
      // left a code-only assertion green, which is a control that cannot witness
      // the fault it is named for.
      await expect(purgeQuarantineUnitLocked(root.dir, {
        unitId, actor: LIFECYCLE_ACTOR, at: AT, confirmDestroy: true,
      })).rejects.toThrow(/bytes are unreadable; refusing to destroy/u);
    } finally {
      await chmod(paths.bytesRoot, 0o700);
    }
  });
});
