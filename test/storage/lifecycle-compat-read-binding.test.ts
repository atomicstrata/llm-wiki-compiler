/**
 * @file test/storage/lifecycle-compat-read-binding.test.ts
 * @description The two Task 9D/9E compatibility wrappers' DECISIONS as pure
 * functions of one lent read, `quarantineUnitListingOf` and
 * `quarantineUnitPendingOf`, with no project at all. This file uses them, which
 * exist only after the wrappers' decisions were lifted out, so it has NO
 * before-edit run.
 *
 * HOW IT IS BUILT. Reads are built in memory: the unavailable read, and ok reads
 * over hand-built snapshots holding quarantine and prune units and a registry
 * problem. Each decision is pinned against them, including the fail-closed
 * answer to an unavailable read. The root-taking wrappers are then shown handing
 * their root to the one capture and answering through these functions.
 *
 * NOT SHOWN HERE: the capture, the scan and the 9D/9E custody they still carry;
 * those stay root-taking and are recorded debt. The lifecycle compat, snapshot
 * and read suites show the projections over real registries.
 */

import { afterEach, describe, expect, it, vi } from "bun:test";
import {
  listQuarantineUnitsFromRoot, quarantineUnitListingOf, quarantineUnitPendingFromRoot, quarantineUnitPendingOf,
} from "../../src/preparations/lifecycle-snapshot/compat.js";
import * as lifecycleRead from "../../src/preparations/lifecycle-snapshot/read.js";
import type { PreparationLifecycleReadV1 } from "../../src/preparations/lifecycle-snapshot/types.js";

afterEach(() => { vi.restoreAllMocks(); });

const UNAVAILABLE = { status: "unavailable", detail: "lifecycle read is unavailable" } as PreparationLifecycleReadV1;

/** An ok read over a snapshot of `units` (registry/unitId/state) and `problems`. */
function okRead(units: Array<[string, string, string]>, problems: object[] = []): PreparationLifecycleReadV1 {
  const snapshot = { complete: problems.length === 0, units: units.map(([registry, unitId, state]) => ({ registry, unitId, state, operation: null })), problems };
  return { status: "ok", snapshot } as never;
}

const UNITS: Array<[string, string, string]> = [["quarantine", "qtn-a", "applying"], ["quarantine", "qtn-b", "completed"], ["prune", "prn-c", "planned"]];

describe("the 9D/9E wrappers' decisions over one lent read", () => {
  it("L1 lists the quarantine registry's units only; an unavailable read or a registry-level problem lists nothing", () => {
    expect(quarantineUnitListingOf(okRead(UNITS))).toEqual({ status: "ok", unitIds: ["qtn-a", "qtn-b"] });
    expect(quarantineUnitListingOf(UNAVAILABLE)).toEqual({ status: "unavailable" });
    expect(quarantineUnitListingOf(okRead(UNITS, [{ registry: "quarantine", code: "registry-unavailable", detail: "x" }]))).toEqual({ status: "unavailable" });
  });

  it("Q1 answers pendingness by the unit's state; an unavailable read is pending, an unseen unit only behind a registry fault", () => {
    const read = okRead(UNITS);
    expect(["qtn-a", "qtn-b", "prn-c", "qtn-z"].map((unitId) => quarantineUnitPendingOf(read, unitId))).toEqual([true, false, false, false]);
    expect(quarantineUnitPendingOf(UNAVAILABLE, "qtn-b")).toBe(true);
    expect(quarantineUnitPendingOf(okRead(UNITS, [{ registry: "quarantine", code: "registry-unavailable", detail: "x" }]), "qtn-z")).toBe(true);
  });
});

describe("the root-taking wrappers", () => {
  it("R1 hand their root to the one capture and answer through the lent-read decisions", async () => {
    const capture = vi.spyOn(lifecycleRead, "withPreparationLifecycleRead").mockImplementation((async (_root: string, consume: (read: PreparationLifecycleReadV1) => unknown) => consume(UNAVAILABLE)) as never);
    expect([await listQuarantineUnitsFromRoot("/project"), await quarantineUnitPendingFromRoot("/project", "qtn-b")]).toEqual([{ status: "unavailable" }, true]);
    expect(capture.mock.calls.map((call) => call[0])).toEqual(["/project", "/project"]);
  });
});
