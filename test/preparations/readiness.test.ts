/**
 * @file test/preparations/readiness.test.ts
 * @description The drive-time readiness deriver (Chunk 3 unit D): a phase's
 * predecessors are its dependsOn edges unioned with its phase-output binding
 * sources; a phase is ready once all predecessors have succeeded; and the ready
 * schedule is a deterministic topological order — proven with a DIAMOND
 * (A → {B, C} → D) whose fan-in phase D must follow both arms regardless of the
 * pack's authoring order. A cyclic plan (impossible after graph validation) is
 * refused rather than looped.
 */

import { describe, expect, it } from "vitest";
import {
  phaseIsReady, phasePredecessors, readyPhaseSchedule,
} from "../../src/preparations/readiness.js";
import type { NormalizedPhaseV1 } from "../../src/preparations/plan-types.js";

/** A phase carrying only the fields the readiness deriver reads. */
function phase(logicalPhaseId: string, dependsOn: string[] = [], outputSources: string[] = []): NormalizedPhaseV1 {
  const inputBindings = outputSources.map((sourcePhaseId, index) => ({
    bindingId: `bind-${index}`, sourceKind: "phase-output" as const, sourcePhaseId,
  }));
  return { logicalPhaseId, dependsOn, inputBindings } as unknown as NormalizedPhaseV1;
}

/** The scrambled diamond: fan-in D listed FIRST, root A listed LAST. */
const DIAMOND: NormalizedPhaseV1[] = [
  phase("D", ["B", "C"]), phase("C", ["A"]), phase("B", ["A"]), phase("A"),
];

describe("phasePredecessors", () => {
  it("unions dependsOn edges with phase-output binding sources", () => {
    const predecessors = phasePredecessors(phase("E", ["dep"], ["out"]));
    expect([...predecessors].sort()).toEqual(["dep", "out"]);
  });
});

describe("phaseIsReady", () => {
  it("holds the fan-in phase back until BOTH arms have succeeded", () => {
    const fanIn = phase("D", ["B", "C"]);
    expect(phaseIsReady(fanIn, new Set(["B"]))).toBe(false);
    expect(phaseIsReady(fanIn, new Set(["B", "C"]))).toBe(true);
  });
});

describe("readyPhaseSchedule", () => {
  it("orders a scrambled diamond so both arms precede the fan-in", () => {
    const order = readyPhaseSchedule(DIAMOND).map((p) => p.logicalPhaseId);
    expect(order[0]).toBe("A");
    expect(order[3]).toBe("D");
    expect(new Set(order.slice(1, 3))).toEqual(new Set(["B", "C"]));
  });

  it("refuses a cyclic plan rather than looping forever", () => {
    const cyclic = [phase("X", ["Y"]), phase("Y", ["X"])];
    expect(() => readyPhaseSchedule(cyclic)).toThrow(/cycle/);
  });
});
