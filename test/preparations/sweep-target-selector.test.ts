/**
 * @file test/preparations/sweep-target-selector.test.ts
 * @description The shared sweep-target selector, tested as the pure function it
 * is — the ONE primitive the mutation gate and the sweep executor both read.
 *
 * WHY A UNIT TEST HERE IS NOT THE "FIXTURES SUPPLY THE SHAPE" HAZARD. Its input
 * is the exact type `projectPendingUnits` returns, and the end-to-end suites
 * drive that projection from real crashed operations. What those suites CANNOT
 * reach is the orderings: unit ids are digests with fixed prefixes, so a
 * blocking `prn-` unit always sorts ahead of a `swp-` one and no fixture can put
 * them the other way round. The selector must not depend on that accident — it
 * is a property of the scanner, not of this rule — and this is the only place
 * the independence can be shown.
 */

import { describe, expect, it } from "vitest";
import { selectSweepTargetUnit } from "../../src/preparations/lifecycle-snapshot/sweep-target.js";
import type { LifecyclePendingUnitV1 } from "../../src/preparations/lifecycle-snapshot/compat.js";

/** One pending unit, named the way the projection names them. */
function unit(
  registry: "quarantine" | "prune",
  operation: LifecyclePendingUnitV1["operation"],
  unitId: string,
): LifecyclePendingUnitV1 {
  return { registry, operation, unitId };
}

const SWEEP = unit("prune", "orphan-sweep", "swp-aaa");
const PRUNE = unit("prune", "run-prune", "prn-bbb");
const UNKNOWN = unit("prune", null, "prn-ccc");

describe("selecting the unit a sweep may resume", () => {
  it("answers a null target for an empty pending set", () => {
    expect(selectSweepTargetUnit([])).toEqual({ status: "ok", unitId: null });
  });

  it("answers the unfinished sweep when one is pending", () => {
    expect(selectSweepTargetUnit([SWEEP])).toEqual({ status: "ok", unitId: "swp-aaa" });
  });

  it("ignores the sibling registry entirely", () => {
    // Cross-registry ordering is the gate's owner rule, which sees both. A
    // second copy of it here would be two rules that have to agree.
    const quarantine = unit("quarantine", "per-run-quarantine", "qtn-ddd");
    const reset = unit("quarantine", "project-key-reset", "qtn-eee");
    expect(selectSweepTargetUnit([quarantine, reset, SWEEP]))
      .toEqual({ status: "ok", unitId: "swp-aaa" });
  });
});

describe("a unit that is not a sweep BLOCKS rather than being skipped", () => {
  it("blocks on an unfinished prune", () => {
    expect(selectSweepTargetUnit([PRUNE])).toMatchObject({
      status: "blocked", unitId: "prn-bbb",
    });
  });

  it("blocks on a unit whose provenance is unknown, naming it as unknown", () => {
    // `null` must not read as a named operation: it is the one class nothing
    // can resume, so a message calling it a prune would send an operator to a
    // verb that cannot help.
    expect(selectSweepTargetUnit([UNKNOWN])).toMatchObject({
      status: "blocked", detail: expect.stringContaining("unfinished unknown operation"),
    });
  });

  it("blocks wherever the blocking unit sits in the list", () => {
    // THE ORDERING PROPERTY. Scanning only the first entry gives the same answer
    // as scanning all of them for every ordering a real scan can produce, so
    // this is the only case that separates the two — and a selector that
    // depended on the scan order would resume a sweep with another operation's
    // bytes staged beneath it the day that order changed.
    expect(selectSweepTargetUnit([SWEEP, PRUNE])).toMatchObject({
      status: "blocked", unitId: "prn-bbb",
    });
    expect(selectSweepTargetUnit([PRUNE, SWEEP])).toMatchObject({
      status: "blocked", unitId: "prn-bbb",
    });
  });
});
