/**
 * @file test/preparations/schedule.test.ts
 * @description Exercises deterministic ready-instance ordering and the closed
 * six-condition readiness gate. Ordering never depends on arrival or wall time;
 * a phase instance is ready only when every condition holds.
 */

import { describe, expect, it } from "vitest";
import type { PhaseInstanceId } from "../../src/preparations/ids.js";
import {
  isPhaseInstanceReady, orderReadyInstances, type PhaseReadinessSignals,
  type SchedulableInstance,
} from "../../src/preparations/schedule.js";

const instance = (rank: number, phase: string, expansion: string, id: string): SchedulableInstance => ({
  topologicalRank: rank, logicalPhaseId: phase, expansionIdentity: expansion,
  phaseInstanceId: `phi_${id.padEnd(64, "0")}` as PhaseInstanceId,
});

const READY: PhaseReadinessSignals = {
  requiredDependenciesSettled: true, optionalAbsenceHasDisposition: true,
  inputSetImmutableAndVerified: true, expansionIdentityDurable: true,
  authoritiesAndBoundsMatch: true, noBlockingObligation: true,
};

describe("deterministic scheduling order", () => {
  const arrival = [
    instance(2, "join", "single", "d"), instance(1, "expand", "map-b", "b"),
    instance(1, "expand", "map-a", "a"), instance(0, "collect", "single", "c"),
  ];

  it("orders by rank, then phase, then expansion, then instance id", () => {
    const ordered = orderReadyInstances(arrival).map((item) => item.logicalPhaseId + "/" + item.expansionIdentity);
    expect(ordered).toEqual(["collect/single", "expand/map-a", "expand/map-b", "join/single"]);
  });

  it("is stable regardless of arrival order and never mutates the input", () => {
    const shuffled = [arrival[2], arrival[0], arrival[3], arrival[1]];
    expect(orderReadyInstances(shuffled)).toEqual(orderReadyInstances(arrival));
    expect(arrival[0].logicalPhaseId).toBe("join");
  });
});

describe("closed readiness gate", () => {
  it("is ready only when every condition holds", () => {
    expect(isPhaseInstanceReady(READY)).toBe(true);
    for (const key of Object.keys(READY) as Array<keyof PhaseReadinessSignals>) {
      expect(isPhaseInstanceReady({ ...READY, [key]: false })).toBe(false);
    }
  });
});
