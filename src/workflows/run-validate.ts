/**
 * @file src/workflows/run-validate.ts
 * @description Deep, fail-closed shape + version-chain validation for run records.
 *
 * The run record AUTHORIZES live wiki writes and gate satisfaction, so a forged or
 * corrupt record must NEVER read `ok`. This module is the rigor behind that: it
 * deep-validates EVERY field and array ELEMENT of a parsed (untrusted) record — not
 * merely that the array fields are arrays — and verifies the event version chain so
 * a forged/rewound `stateVersion` is detected.
 *
 * The two entry points the store calls:
 *  - {@link hasValidRunShape} — every field/element well-formed (`stageLog` entries,
 *    `satisfiedGates` gate grammar, `knownStageIds` slugs, `events`, the 64-hex
 *    digests, object `inputs`/`outputs`, non-empty timestamps, the safe-int
 *    `stateVersion`, the `pendingOutput` marker). A miss → the record is `schema`.
 *  - {@link hasMonotonicVersionChain} — the genesis/monotone/anchor invariant. A miss
 *    → the record is `version-chain` (surfaced distinctly so a forged version is
 *    legible). Kept separate from the shape check so the store can map the two to
 *    different fail-closed reasons.
 */

import { isSlugSafe } from "../profile/identity.js";
import { isWellFormedGate } from "./gates.js";
import {
  WORKFLOW_RUN_STATUSES,
  STAGE_STATUSES,
  type StageStatus,
  type WorkflowEvent,
  type WorkflowRunStatus,
} from "./types.js";

/** The run fields that MUST each be a JSON array for the record to be trusted. */
const RUN_ARRAY_FIELDS = ["stageLog", "events", "satisfiedGates", "knownStageIds"] as const;

/** A 64-char lowercase-hex digest (a SHA-256 hex), the shape both run digests carry. */
const HEX_DIGEST_PATTERN = /^[0-9a-f]{64}$/;

/** True only when every {@link RUN_ARRAY_FIELDS} entry on `run` is an array. */
function hasValidRunArrays(run: Record<string, unknown>): boolean {
  return RUN_ARRAY_FIELDS.every((field) => Array.isArray(run[field]));
}

/** True only when `run.stateVersion` is a SAFE, non-negative integer. */
function hasValidStateVersion(run: Record<string, unknown>): boolean {
  return typeof run.stateVersion === "number" && Number.isSafeInteger(run.stateVersion) && run.stateVersion >= 0;
}

/** True only when `value` is a 64-char lowercase-hex digest. */
function isHexDigest(value: unknown): boolean {
  return typeof value === "string" && HEX_DIGEST_PATTERN.test(value);
}

/** True only when `value` is a plain object (not an array, not null, not a scalar). */
function isPlainObject(value: unknown): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** True only when `value` is a non-empty string (an ISO-ish timestamp floor). */
function isNonEmptyString(value: unknown): boolean {
  return typeof value === "string" && value.length > 0;
}

/** True only when `entry` is a `{ stageId: slug-safe, status: StageStatus }` object. */
function isValidStageLogEntry(entry: unknown): boolean {
  if (!isPlainObject(entry)) return false;
  const e = entry as Record<string, unknown>;
  return (
    typeof e.stageId === "string" &&
    isSlugSafe(e.stageId) &&
    STAGE_STATUSES.includes(e.status as StageStatus)
  );
}

/** True only when every `stageLog` entry is a well-shaped stage-log entry. */
function isValidStageLog(run: Record<string, unknown>): boolean {
  return (run.stageLog as unknown[]).every(isValidStageLogEntry);
}

/** True only when every `satisfiedGates` entry matches the shared gate grammar. */
function isValidGateList(run: Record<string, unknown>): boolean {
  return (run.satisfiedGates as unknown[]).every(
    (gate) => typeof gate === "string" && isWellFormedGate(gate),
  );
}

/** True only when every `knownStageIds` entry is a slug-safe string. */
function isValidKnownStageIds(run: Record<string, unknown>): boolean {
  return (run.knownStageIds as unknown[]).every(
    (id) => typeof id === "string" && isSlugSafe(id),
  );
}

/**
 * True only when the typed scalar fields are well-formed: the two digests are
 * 64-hex, `inputs`/`outputs` are plain objects, and the timestamps are non-empty
 * strings. Factored out of {@link hasValidRunShape} to keep each function focused.
 */
function hasValidRunScalars(run: Record<string, unknown>): boolean {
  return (
    isHexDigest(run.workflowDigest) &&
    isHexDigest(run.profileDigest) &&
    isPlainObject(run.inputs) &&
    isPlainObject(run.outputs) &&
    isNonEmptyString(run.startedAt) &&
    isNonEmptyString(run.updatedAt)
  );
}

/**
 * True when the advisory `owner` (M1) is ABSENT or a string. Present-but-non-string
 * rejects the whole record closed so the ownership check never compares against a
 * malformed value. An absent `owner` is valid (legacy/pre-M1 records are unrestricted).
 */
function hasValidOwner(run: Record<string, unknown>): boolean {
  return run.owner === undefined || typeof run.owner === "string";
}

/**
 * True when `pendingOutput` is ABSENT or a well-shaped intent marker (an object
 * with string `stageId`/`opId`). A malformed marker would otherwise corrupt the
 * crash-recovery gate, so a non-conforming value rejects the whole record closed.
 */
function hasValidPendingOutput(run: Record<string, unknown>): boolean {
  const pending = run.pendingOutput;
  if (pending === undefined) return true;
  if (typeof pending !== "object" || pending === null) return false;
  const p = pending as Record<string, unknown>;
  return typeof p.stageId === "string" && typeof p.opId === "string";
}

/**
 * True only when `event` is an object with a string `type` and INTEGER
 * `stateVersionBefore`/`stateVersionAfter`. A malformed `events` element (a bare
 * string, a missing/NaN version) would otherwise parse `ok` and corrupt the audit
 * trail / version bookkeeping; this rejects the whole record fail-closed instead.
 */
function isValidRunEvent(event: unknown): boolean {
  if (typeof event !== "object" || event === null) return false;
  const e = event as Record<string, unknown>;
  return (
    typeof e.type === "string" &&
    Number.isInteger(e.stateVersionBefore) &&
    Number.isInteger(e.stateVersionAfter)
  );
}

/**
 * True only for a record-shaped object whose EVERY field/element is well-formed.
 * Deep-validates each array's ELEMENTS (not merely that the field is an array):
 * `stageLog` entries, `satisfiedGates` gate strings, `knownStageIds` slugs, and
 * `events` ({@link isValidRunEvent}); the typed scalars ({@link hasValidRunScalars}
 * — 64-hex digests, object `inputs`/`outputs`, non-empty timestamps); the safe-int
 * `stateVersion`; the advisory `owner` (absent or a string); and the `pendingOutput`
 * marker. Any miss fails the record CLOSED
 * — a forged-but-array-shaped record can no longer read `ok`. The event version
 * chain is checked SEPARATELY ({@link hasMonotonicVersionChain}) so a forged/rewound
 * `stateVersion` surfaces as the distinct `version-chain` reason.
 *
 * @param run - The parsed (untrusted) top-level record object.
 * @returns Whether every field/element is well-formed.
 */
export function hasValidRunShape(run: Record<string, unknown>): boolean {
  return (
    typeof run.workflowId === "string" &&
    WORKFLOW_RUN_STATUSES.includes(run.status as WorkflowRunStatus) &&
    (run.currentStage === null || typeof run.currentStage === "string") &&
    hasValidRunArrays(run) &&
    (run.events as unknown[]).every(isValidRunEvent) &&
    isValidStageLog(run) &&
    isValidGateList(run) &&
    isValidKnownStageIds(run) &&
    hasValidRunScalars(run) &&
    hasValidStateVersion(run) &&
    hasValidOwner(run) &&
    hasValidPendingOutput(run)
  );
}

/**
 * Verify the event version chain — the FIX-3 detection close on a forged/rewound
 * `stateVersion`. Requires:
 *
 *  - GENESIS: `events[0]` is `workflow-start` with `stateVersionBefore === 0` (a run
 *    is born at version 0; a record without that genesis is forged).
 *  - PER-EVENT: each event's `stateVersionAfter >= stateVersionBefore`.
 *  - MONOTONE: the chain is non-decreasing across whatever events remain
 *    (`events[i].stateVersionBefore >= events[i-1].stateVersionAfter`). This holds
 *    across the no-event awaiting-gate PARK (a writeRun without an appended event
 *    leaves the chain unchanged) and across an R1 compaction marker (a compacted log
 *    has a by-design GAP, so PRE-compaction contiguity is NOT required — only that
 *    the markers' own before/after stay monotone over the surviving events).
 *  - ANCHOR: `run.stateVersion === events[last].stateVersionAfter`. The documented
 *    park does not bump, so the run's version still equals the last event's after.
 *
 * An empty `events` array cannot satisfy the genesis requirement → rejected. CAS on
 * write (threading an expected version through every op) remains the durable
 * lost-update fix; this chain check closes the fail-closed DETECTION gap.
 *
 * @param run - The parsed record (its `events`/`stateVersion` already array-shaped).
 * @returns Whether the version chain is consistent.
 */
export function hasMonotonicVersionChain(run: Record<string, unknown>): boolean {
  const events = run.events as WorkflowEvent[];
  if (events.length === 0) return false;
  const genesis = events[0];
  if (genesis.type !== "workflow-start" || genesis.stateVersionBefore !== 0) return false;
  for (let i = 0; i < events.length; i++) {
    if (events[i].stateVersionAfter < events[i].stateVersionBefore) return false;
    if (i > 0 && events[i].stateVersionBefore < events[i - 1].stateVersionAfter) return false;
  }
  return run.stateVersion === events[events.length - 1].stateVersionAfter;
}
