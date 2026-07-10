/**
 * @file src/workflows/events.ts
 * @description The pure in-record workflow event-append helper.
 *
 * A {@link WorkflowRun} carries an append-only `events` audit trail. This module
 * owns the ONE pure transform that appends to it: {@link appendRunEvent}. It
 * performs NO I/O and NEVER mutates its input — it returns a fresh run with the
 * event appended, the before/after state versions stamped, `stateVersion` bumped,
 * and `updatedAt` set to the event's timestamp. Persisting the result is the
 * caller's job (via the confined store); state-machine logic belongs elsewhere.
 *
 * NON-TERMINAL appends ({@link appendRunEvent}) fail CLOSED at
 * {@link MAX_WORKFLOW_RUN_EVENTS}: an audit event is never silently dropped, so the
 * helper raises {@link WorkflowEventOverflowError} rather than truncating the trail
 * (back-pressure on growth).
 *
 * TERMINAL appends ({@link appendTerminalEvent}) must ALWAYS succeed — a cap bounds
 * GROWTH, never blocks TERMINATION, so a run at the cap can never become an
 * un-retireable zombie. When the cap would be breached it first COMPACTS the trail
 * to a bounded tail (genesis + a single `events-truncated` marker + the recent
 * events) so the audit trail degrades GRACEFULLY (never silently), then appends.
 */

import { MAX_WORKFLOW_RUN_EVENTS } from "../utils/constants.js";
import type { WorkflowEvent, WorkflowRun } from "./types.js";

/**
 * Raised when appending an event would exceed {@link MAX_WORKFLOW_RUN_EVENTS}.
 * Fail closed — an audit event is never silently dropped. A typed error (not a
 * generic `Error`) so callers can catch it distinctly.
 */
export class WorkflowEventOverflowError extends Error {
  constructor(cap: number) {
    super(`workflow run event log is full: at the cap of ${cap} events`);
    this.name = "WorkflowEventOverflowError";
  }
}

/**
 * Return a NEW run with `event` appended to its audit trail.
 *
 * Stamps `stateVersionBefore = run.stateVersion` and `stateVersionAfter =
 * run.stateVersion + 1` on the event, bumps `run.stateVersion`, and sets
 * `run.updatedAt = event.at`. Pure: the input run is never mutated — the result
 * is a shallow clone with fresh `events` and `satisfiedGates` arrays.
 *
 * @param run - The run to append to (left untouched).
 * @param event - The event to append, sans its before/after state versions
 *   (stamped here from `run.stateVersion`).
 * @returns A new run with the event appended and state advanced.
 * @throws {WorkflowEventOverflowError} When `run.events` is already at the cap.
 */
export function appendRunEvent(
  run: WorkflowRun,
  event: Omit<WorkflowEvent, "stateVersionBefore" | "stateVersionAfter">,
): WorkflowRun {
  if (run.events.length >= MAX_WORKFLOW_RUN_EVENTS) {
    throw new WorkflowEventOverflowError(MAX_WORKFLOW_RUN_EVENTS);
  }
  return appendStamped(run, event);
}

/** Append `event` to `run`, stamping the before/after versions and bumping state. */
function appendStamped(
  run: WorkflowRun,
  event: Omit<WorkflowEvent, "stateVersionBefore" | "stateVersionAfter">,
): WorkflowRun {
  const stateVersionBefore = run.stateVersion;
  const stateVersionAfter = stateVersionBefore + 1;
  const stamped: WorkflowEvent = { ...event, stateVersionBefore, stateVersionAfter };
  return {
    ...run,
    stateVersion: stateVersionAfter,
    updatedAt: event.at,
    events: [...run.events, stamped],
    satisfiedGates: [...run.satisfiedGates],
  };
}

/**
 * Compact `run.events` to a bounded tail so that appending ONE more event still
 * fits within {@link MAX_WORKFLOW_RUN_EVENTS}. Preserves the genesis (`events[0]`,
 * the `workflow-start`), inserts ONE synthetic `events-truncated` marker naming how
 * many middle events were dropped, then keeps the most-recent tail. The marker's
 * `stateVersionBefore/After` straddle the gap (genesis-after → first-kept-before) so
 * the version bookkeeping stays monotone and the truncation is auditable, never
 * silent. Pure: returns a fresh run; the input is untouched.
 *
 * @param run - The run whose trail to compact (left untouched).
 * @param at - ISO-8601 timestamp for the synthetic marker.
 * @returns A new run whose `events` is genesis + marker + recent tail.
 */
function compactEvents(run: WorkflowRun, at: string): WorkflowRun {
  const genesis = run.events[0];
  // Reserve 2 slots (genesis + marker) and 1 for the about-to-be-appended terminal event.
  const tailSize = Math.max(0, MAX_WORKFLOW_RUN_EVENTS - 3);
  const tail = run.events.slice(run.events.length - tailSize);
  const droppedCount = run.events.length - 1 - tail.length;
  const marker: WorkflowEvent = {
    type: "events-truncated", at, actorKind: "system",
    detail: `${droppedCount} earlier events compacted`,
    stateVersionBefore: genesis.stateVersionAfter,
    stateVersionAfter: tail.length > 0 ? tail[0].stateVersionBefore : run.stateVersion,
  };
  return { ...run, events: [genesis, marker, ...tail] };
}

/**
 * Append a TERMINAL `event` to `run`, ALWAYS succeeding even at the event cap.
 *
 * If appending would breach {@link MAX_WORKFLOW_RUN_EVENTS}, the trail is first
 * {@link compactEvents}-ed (genesis + an `events-truncated` marker + the recent
 * tail) so the terminal status flip can ALWAYS persist — a run is never a
 * permanent, un-retireable zombie. Otherwise it appends like {@link appendRunEvent}.
 * Pure: the input run is never mutated.
 *
 * @param run - The run to terminate (left untouched).
 * @param event - The terminal event to record (sans before/after versions).
 * @returns A new run with the (possibly compacted) trail and the terminal event.
 */
export function appendTerminalEvent(
  run: WorkflowRun,
  event: Omit<WorkflowEvent, "stateVersionBefore" | "stateVersionAfter">,
): WorkflowRun {
  const base = run.events.length >= MAX_WORKFLOW_RUN_EVENTS ? compactEvents(run, event.at) : run;
  return appendStamped(base, event);
}
