/**
 * @file src/preparations/schedule.ts
 * @description Deterministic ready-instance scheduling (design section 10.5).
 * Readiness is a closed six-condition gate; ordering is a stable canonical sort
 * by normalized topological rank, then logical phase id, then expansion
 * identity, then phase-instance id. Wall-clock completion order never
 * influences ordering, so a run replays identically across processes.
 */

import type { PhaseInstanceId } from "./ids.js";

/** One materialized phase instance eligible for deterministic ordering. */
export interface SchedulableInstance {
  phaseInstanceId: PhaseInstanceId;
  logicalPhaseId: string;
  expansionIdentity: string;
  topologicalRank: number;
}

/** The six closed readiness conditions of design section 10.5. */
export interface PhaseReadinessSignals {
  requiredDependenciesSettled: boolean;
  optionalAbsenceHasDisposition: boolean;
  inputSetImmutableAndVerified: boolean;
  expansionIdentityDurable: boolean;
  authoritiesAndBoundsMatch: boolean;
  noBlockingObligation: boolean;
}

/** A phase instance is ready only when every closed condition holds. */
export function isPhaseInstanceReady(signals: PhaseReadinessSignals): boolean {
  return (
    signals.requiredDependenciesSettled &&
    signals.optionalAbsenceHasDisposition &&
    signals.inputSetImmutableAndVerified &&
    signals.expansionIdentityDurable &&
    signals.authoritiesAndBoundsMatch &&
    signals.noBlockingObligation
  );
}

/** Compare two ready instances by the exact canonical scheduling order. */
function compareInstances(a: SchedulableInstance, b: SchedulableInstance): number {
  if (a.topologicalRank !== b.topologicalRank) return a.topologicalRank - b.topologicalRank;
  if (a.logicalPhaseId !== b.logicalPhaseId) return a.logicalPhaseId < b.logicalPhaseId ? -1 : 1;
  if (a.expansionIdentity !== b.expansionIdentity) return a.expansionIdentity < b.expansionIdentity ? -1 : 1;
  if (a.phaseInstanceId === b.phaseInstanceId) return 0;
  return a.phaseInstanceId < b.phaseInstanceId ? -1 : 1;
}

/**
 * Order ready instances by the canonical scheduling key. The input is copied so
 * the caller's array is never mutated; identical inputs always yield identical
 * output regardless of arrival order.
 */
export function orderReadyInstances(instances: readonly SchedulableInstance[]): SchedulableInstance[] {
  return [...instances].sort(compareInstances);
}
