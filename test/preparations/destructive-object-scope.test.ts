/**
 * @file test/preparations/destructive-object-scope.test.ts
 * @description The invariant that makes the completeness gate OBJECT-SCOPED.
 *
 * `unit-unavailable` is deliberately excluded from `REGISTRY_COMPLETENESS_PROBLEMS`,
 * and Task 9D decision D60 recorded that exclusion as a live relaxation: a
 * destructive plan proceeds over a quarantine registry holding an unreadable unit.
 *
 * Measured, that is correct rather than relaxed — but only because of an invariant
 * nothing asserted: NO destructive plan's object set ever contains a leaf from the
 * quarantine registry.
 *
 * WHAT GUARANTEES IT, precisely, because a first version of this test asserted the
 * right property for the wrong reason. It is not the `kind !== "quarantine"` filter
 * in `ownedRunLeaves`; it is that the destructive scan enumerates ACTIVE STORAGE
 * only (`scanActivePreparationStore`) and never walks the quarantine registry at
 * all. A quarantined unit's bytes are already in custody, and the operations that
 * plan destruction plan over live state.
 *
 * So an unreadable unit cannot make any plan's object set incomplete, because
 * nothing in that registry was ever eligible to be in one. That is the difference
 * between "the gate ignores a problem" and "the problem is outside the gate's
 * object scope", and it is why prune and sweep can stop refusing on it.
 *
 * That is the whole difference between "the gate ignores a problem" and "the
 * problem is outside the gate's object scope", and it is the reason prune and
 * sweep can stop refusing on it without losing anything. Pinned here so the
 * reasoning cannot rot: if a future change lets quarantine bytes into a
 * destructive plan, the exclusion becomes a real relaxation and this goes red.
 */

import { existsSync } from "node:fs";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { useTempRoot } from "../fixtures/temp-root.js";
import { withPreparationLifecycleRead } from "../../src/preparations/lifecycle-snapshot/read.js";
import {
  enumerateProjectScope, enumerateRunScope, scanForDestructivePlan,
} from "../../src/preparations/quarantine.js";
import { driveToFailed, stagePreparation } from "./lifecycle-fixture.js";

/**
 * Plant TWO quarantine units: one readable with bytes, one unreadable.
 *
 * The readable one is what makes this test able to fail. A first version planted
 * only the unreadable unit -- and mutation-testing showed the assertions held even
 * with the `kind !== "quarantine"` filter DELETED, because a `0o000` unit's leaves
 * are invisible to the scan regardless of any filter. The fixture could not
 * contain the failure it was written to detect.
 */
async function plantQuarantineUnits(root: string): Promise<string> {
  const registry = path.join(root, ".llmwiki", "preparation-quarantine");
  const readable = path.join(registry, "qtn-readable", "bytes");
  await mkdir(readable, { recursive: true });
  await writeFile(path.join(readable, "object-000000"), "quarantined bytes");
  const unit = path.join(registry, "qtn-blocked");
  await mkdir(unit, { recursive: true });
  await writeFile(path.join(unit, "marker"), "quarantined bytes");
  await chmod(unit, 0o000);
  return unit;
}

describe("a destructive plan's object set never reaches the quarantine registry", () => {
  const root = useTempRoot();

  it("excludes quarantine leaves from BOTH scopes while reporting the problem", async () => {
    const { binding } = await stagePreparation(root.dir);
    await driveToFailed(root.dir, binding);
    const unit = await plantQuarantineUnits(root.dir);
    try {
      const measured = await withPreparationLifecycleRead(root.dir, async (read) => {
        if (read.status !== "ok") throw new Error("capture unavailable");
        const scan = await scanForDestructivePlan(root.dir, read);
        return {
          // The problem IS observed -- the gate is not blind to it, it is scoped.
          problems: read.snapshot.problems.map((problem) => `${problem.registry}/${problem.code}`),
          readableUnitBytesExist: existsSync(
            path.join(root.dir, ".llmwiki", "preparation-quarantine", "qtn-readable", "bytes", "object-000000")),
          visibleQuarantineLeaves: scan.leaves.filter((leaf) =>
            leaf.relativePath.includes("preparation-quarantine")).length,
          quarantineLeaves: scan.leaves.filter((leaf) => leaf.kind === "quarantine").length,
          runScope: (await enumerateRunScope(root.dir, binding, read)).map((o) => o.logicalPath),
          projectScope: (await enumerateProjectScope(root.dir, read)).map((o) => o.logicalPath),
        };
      });
      expect(measured.problems).toContain("quarantine/unit-unavailable");
      // The readable unit's bytes exist ON DISK -- so a scan that walked the
      // registry would surface them -- and appear in NEITHER scope. Without the
      // readable unit this is vacuous: a 0o000 unit is invisible to any scan, which
      // is how the first version of this test passed with the filter deleted.
      expect(measured.readableUnitBytesExist).toBe(true);
      expect(measured.visibleQuarantineLeaves).toBe(0);
      expect(measured.quarantineLeaves).toBe(0);
      // Neither scope names anything under the quarantine registry.
      const underQuarantine = (paths: string[]) =>
        paths.filter((p) => p.includes("preparation-quarantine"));
      expect(underQuarantine(measured.runScope)).toEqual([]);
      expect(underQuarantine(measured.projectScope)).toEqual([]);
      // Negative control: the scopes are not simply empty, or the assertions
      // above would hold against a planner that enumerated nothing at all.
      expect(measured.projectScope.length).toBeGreaterThan(0);
    } finally {
      await chmod(unit, 0o700);
    }
  });
});
