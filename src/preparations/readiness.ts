/**
 * @file src/preparations/readiness.ts
 * @description The drive-time readiness deriver (Chunk 3 unit D). A phase is
 * READY when every phase it depends on has settled successfully — the union of
 * its explicit `dependsOn` edges and the source phases of its `phase-output`
 * input bindings. The runner drives a preparation SEQUENTIALLY, so a
 * topological schedule (predecessors always before dependents) is exactly the
 * order in which every phase becomes ready the moment it is reached; this
 * module turns the graph's validated topological ranks into that schedule.
 *
 * The point is graph SHAPE: a linear plan schedules in any order, but a diamond
 * (a fan-in phase depending on two independent predecessors) must run its
 * fan-in phase only after BOTH arms complete. Driving in author array order
 * would trust the pack to pre-sort; deriving the schedule from readiness makes
 * the order a property of the graph, not of how the pack happened to list
 * phases. Pure over its inputs — this reads the plan only, never durable state.
 */

import { PreparationPlanError } from "./problems.js";
import type { NormalizedPhaseV1 } from "./plan-types.js";

/** Every phase id one phase depends on: its `dependsOn` plus each output source. */
export function phasePredecessors(phase: NormalizedPhaseV1): ReadonlySet<string> {
  const predecessors = new Set<string>(phase.dependsOn);
  for (const binding of phase.inputBindings) {
    if (binding.sourceKind === "phase-output" && binding.sourcePhaseId !== undefined) {
      predecessors.add(binding.sourcePhaseId);
    }
  }
  return predecessors;
}

/** Whether every one of a phase's predecessors has succeeded. */
export function phaseIsReady(phase: NormalizedPhaseV1, succeededPhaseIds: ReadonlySet<string>): boolean {
  for (const predecessor of phasePredecessors(phase)) {
    if (!succeededPhaseIds.has(predecessor)) return false;
  }
  return true;
}

/**
 * Order the plan's phases so every phase's predecessors precede it — the
 * sequential runner's ready schedule. Built by repeatedly appending the
 * FIRST (author-order) phase whose predecessors are all already scheduled, so
 * the result is a deterministic topological order independent of how the pack
 * listed phases. Assumes an acyclic graph (the plan passed graph validation at
 * parse); a validated plan always has a ready phase until all are scheduled.
 *
 * @param phases - The plan's phases, in authoring order.
 * @returns The phases in ready (topological) drive order.
 * @throws PreparationPlanError if no phase is ready while some remain — a cycle,
 *   which a validated plan cannot contain.
 */
export function readyPhaseSchedule(phases: readonly NormalizedPhaseV1[]): readonly NormalizedPhaseV1[] {
  const scheduled: NormalizedPhaseV1[] = [];
  const scheduledIds = new Set<string>();
  const remaining = [...phases];
  while (remaining.length > 0) {
    const readyIndex = remaining.findIndex((phase) => phaseIsReady(phase, scheduledIds));
    if (readyIndex === -1) throw new PreparationPlanError("readiness schedule found no ready phase (cycle)");
    const [phase] = remaining.splice(readyIndex, 1);
    scheduled.push(phase);
    scheduledIds.add(phase.logicalPhaseId);
  }
  return scheduled;
}
