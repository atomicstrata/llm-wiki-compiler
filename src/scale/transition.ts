/**
 * @file src/scale/transition.ts
 * @description Setting, preparing and reporting a project's expected scale.
 *
 * SET. The estimate is validated and planned BEFORE the lock, so invalid input
 * changes nothing. Under the project mutation lock (intent `scale`) the record
 * is re-read: an unreadable record refuses (no automatic repair), and a stated
 * `expectedRevision` that differs refuses as a conflict. Otherwise exactly one
 * new revision is written:
 * - an estimate the active architecture already serves (including a SMALLER
 *   one: a larger active setup is a compatible superset and is never
 *   downgraded) is ready at once;
 * - a larger local estimate records a `prepare` transition, which then runs
 *   unless the caller deferred it;
 * - an estimate beyond the local envelope is RECORDED as `unavailable`, with
 *   the bounds it exceeds and the backends it would need. The active local
 *   architecture and all data stay as they are, and dependent work blocks
 *   until the estimate is lowered. It is never activated.
 * A new request supersedes whatever was pending.
 *
 * PREPARE. Every step runs again and checks reality, whatever the record says,
 * and the architecture is activated in ONE atomic replacement, the last write.
 * On a project already `local-indexed` with no pending transition, a needed
 * capability (version 3) not yet held is added `preparing`, and every
 * preparing capability is prepared by its own step and published `ready` in
 * one last write (`runCapabilityUpgrade`); until then status reports
 * `preparing` and the gate blocks dependent work.
 * A parked step leaves the transition in place and dependent work blocked. An
 * `unavailable` record returns the same honest result and writes nothing.
 *
 * INTERRUPTION. The durable record is always the previous one, the new one
 * with its transition, a later step checkpoint, or the activated one. Ordinary
 * local reads of current content keep working throughout (registered portable
 * steps, reads included, refuse until it settles); `prepare` resumes.
 *
 * ONE BODY. {@link setExpectedScaleWith}, {@link prepareExpectedScaleWith} and
 * {@link scaleStatusFrom} take injected steps and no project root;
 * {@link diskScaleTransitionSteps} is the local binding.
 */

import { isDeepStrictEqual } from "node:util";
import { acquireMutationLockBlocking } from "../operation-bundles/lock-gate.js";
import { releaseLock } from "../utils/lock.js";
import { SCALE_NOTICE, ScaleRefusalError, type ScaleRequest } from "./contracts.js";
import { CAPABILITIES_V3, type CapabilityNameV3, type CapabilityV3, type IneligibleReason, type ScalePlanV2, type ScaleRecord } from "./contracts-v2.js";
import { diskScaleCapabilities, diskScaleEligibility } from "./eligibility.js";
import { observeScaleRecord, scaleGateRefusalFrom, type ScaleGateBlock, type ScaleGateError } from "./gate.js";
import { nextRecord, requireRequestedHeld } from "./next-record.js";
import { indexedPreflightRequiredBytes, planRecordedV2, planScaleV2 } from "./plan-v2.js";
import { preflightRequiredBytes } from "./plan.js";
import { diskScaleRecordIo, readScaleRecordFrom, writeScaleRecordFrom, type ScaleRecordIo, type ScaleRecordRead } from "./record.js";
import {
  capacityPreflightFrom, diskEmbeddingContainerIo, diskPreflightIo, prepareEmbeddingContainerFrom,
  type EmbeddingContainerIo, type PreflightIo, type StepOutcome,
} from "./steps.js";
import { diskIndexedPreparation, type IndexedPreparation } from "./steps-indexed.js";

export { nextRecord } from "./next-record.js";

/** A durable checkpoint a test may interrupt at: after the request, or after each named step is recorded. */
export type ScaleCheckpoint = "after-request" | `after-${string}`;

/** What a transition runs over. No member takes a project root. */
export interface ScaleTransitionSteps {
  /** Take the gated project mutation lock at intent `scale`, waiting for it. */
  acquire(): Promise<void>;
  /** Release the project lock. */
  release(): Promise<void>;
  readonly record: ScaleRecordIo;
  readonly preflight: PreflightIo;
  readonly container: EmbeddingContainerIo;
  /** The project's eligibility blocks for `local-indexed`, checked under the lock. Absent: eligible. */
  eligibility?(): Promise<IneligibleReason[]>;
  /** The version 3 capabilities an indexed layout of this project needs (a custom profile: the typed entity catalog), under the lock. Absent: none. */
  capabilities?(): Promise<CapabilityNameV3[]>;
  /** The `local-indexed` preparation steps. Absent: an indexed target parks at its first indexed step. */
  readonly indexed?: IndexedPreparation;
  /** TEST SEAM: runs after each durable checkpoint. Absent locally. */
  checkpoint?(stage: ScaleCheckpoint): Promise<void>;
}

/**
 * Where the project stands. `unconfigured` is a project with no record:
 * today's behaviour. Disk status also reports what admission observes:
 * `downgrading` while a scale-down needs same-plan recovery (even when the
 * record has no pending field), `unreadable` when the record is unreadable or
 * missing beside indexed stores, and `restoring` while an indexed-authority
 * restore holds the project (`restoring` is new in this candidate: a consumer
 * closed over the previous union must accept it). Status is advisory and
 * authorizes nothing.
 */
export type ScaleReadiness = "unconfigured" | "ready" | "preparing" | "parked" | "unavailable" | "downgrading" | "unreadable" | "restoring";

/** The answer of every scale operation. */
export interface ScaleReport {
  readonly readiness: ScaleReadiness;
  readonly record: ScaleRecord | null;
  /** The current policy's (`local-v2`) plan for the recorded estimate, or `null` without a readable record. */
  readonly plan: ScalePlanV2 | null;
  /** Whether this request replaced a pending transition or unavailable estimate. */
  readonly superseded: boolean;
  /**
   * True when a recorded unavailable estimate would now plan differently (a
   * version 1 record under the newer policy): `scale prepare` or `scale set`
   * re-plans it explicitly. Status never re-plans.
   */
  readonly replanAvailable?: boolean;
  /** Why the project is blocked when admission decides it (unreadable, missing authority, downgrading, restoring); absent otherwise. */
  readonly reason?: string;
  readonly notice: string;
}

/** A request to change the expected scale. */
export interface SetScaleInput {
  readonly request: ScaleRequest;
  /** Run the preparation now (default) or leave it pending, blocking dependent work. */
  readonly prepare?: boolean;
  /** Refuse unless the current record revision is exactly this (0 for no record). */
  readonly expectedRevision?: number;
  /** Version 3 capabilities to hold beyond the ones the project needs (`segmented-compile-state-1`), prepared before they are `ready`. */
  readonly capabilities?: readonly CapabilityNameV3[];
}

/** A request to resume, re-verify or upgrade the preparation. */
export interface PrepareScaleInput {
  /** Version 3 capabilities to hold beyond the ones the project needs; on an active indexed project they are prepared as an upgrade. */
  readonly capabilities?: readonly CapabilityNameV3[];
}

/** The readiness a readable record implies. */
function readinessOf(record: ScaleRecord): ScaleReadiness {
  const pending = record.pending;
  if (pending === null) return capabilitiesPreparing(record).length > 0 ? "preparing" : "ready";
  if (pending.kind === "unavailable") return "unavailable";
  if (pending.kind === "downgrade") return "downgrading";
  return pending.steps.some((step) => step.status === "parked") ? "parked" : "preparing";
}

/** Build the report for `record`. */
function reportOf(record: ScaleRecord | null, superseded = false): ScaleReport {
  if (record === null) return { readiness: "unconfigured", record: null, plan: null, superseded, notice: SCALE_NOTICE };
  const plan = planRecordedV2(record.requested);
  const replanAvailable = record.version === 1 && record.pending?.kind === "unavailable" && plan.architecture !== "unavailable";
  return { readiness: readinessOf(record), record, plan, superseded, ...(replanAvailable ? { replanAvailable } : {}), notice: SCALE_NOTICE };
}

/**
 * The current record for an update; an unreadable one refuses, and nothing is
 * written. So does a scale-down in progress: neither `set` nor `prepare` may
 * supersede it, only resuming that scale-down settles it.
 */
async function readForUpdate(io: ScaleRecordIo): Promise<ScaleRecord | null> {
  return recordForUpdateFrom(await readScaleRecordFrom(io));
}

/** {@link readForUpdate} over one record observation `read`. Pure. */
export function recordForUpdateFrom(read: ScaleRecordRead): ScaleRecord | null {
  if (read.kind === "unreadable") throw new ScaleRefusalError("scale_state_unreadable", `${read.reason}; restore it by hand`);
  if (read.kind === "ok" && read.record.pending?.kind === "downgrade") {
    throw new ScaleRefusalError("scale_downgrade_pending", `a scale-down to ${read.record.pending.target} is in progress; resume it with \`llmwiki scale downgrade --apply\` and the same plan`);
  }
  return read.kind === "ok" ? read.record : null;
}

/** `record` with step `at` replaced by `outcome`. */
function withStep(record: ScaleRecord, at: number, outcome: StepOutcome): ScaleRecord {
  if (record.pending?.kind !== "prepare") return record;
  const steps = record.pending.steps.map((step, index) => (index === at ? { name: step.name, ...outcome } : step));
  return { ...record, pending: { ...record.pending, steps } } as ScaleRecord;
}

/** Persist one step's outcome and announce its checkpoint. */
async function recordStep(steps: ScaleTransitionSteps, record: ScaleRecord, at: number, outcome: StepOutcome): Promise<ScaleRecord> {
  const next = withStep(record, at, outcome);
  await writeScaleRecordFrom(steps.record, next, record);
  const name = next.pending?.kind === "prepare" ? next.pending.steps[at]!.name : String(at);
  await steps.checkpoint?.(`after-${name}`);
  return next;
}

/** The outcome of an indexed step this binding cannot run. */
async function noIndexedBinding(): Promise<StepOutcome> {
  return { status: "parked", detail: "this binding provides no local-indexed preparation" };
}

/** Capabilities the indexed steps themselves prepare (the catalog build projects the typed rows). */
const BUILT_BY_STEPS: ReadonlySet<CapabilityNameV3> = new Set(["typed-entity-catalog-1"]);

/**
 * The `history-import` step of an indexed preparation: the incumbent history
 * imports, then the import of every other `preparing` capability (the
 * compile state), so it is verified by `activation-verify` before activation.
 */
async function importsThenCapabilities(indexed: IndexedPreparation, record: ScaleRecord): Promise<StepOutcome> {
  const histories = await indexed.historyImport();
  if (histories.status === "parked") return histories;
  for (const name of capabilitiesPreparing(record).filter((capability) => !BUILT_BY_STEPS.has(capability))) {
    const outcome = await indexed.capability(name);
    if (outcome.status === "parked") return outcome;
  }
  return histories;
}

/** The step bodies of `record`'s pending target, in order. */
function runnersFor(steps: ScaleTransitionSteps, record: ScaleRecord): Array<() => Promise<StepOutcome>> {
  const target = record.pending?.kind === "prepare" ? record.pending.target : "local-large";
  if (target === "local-large") {
    return [() => capacityPreflightFrom(steps.preflight, preflightRequiredBytes(record.requested)), () => prepareEmbeddingContainerFrom(steps.container)];
  }
  const indexed = steps.indexed;
  return [
    () => capacityPreflightFrom(steps.preflight, indexedPreflightRequiredBytes(record.requested)),
    indexed === undefined ? noIndexedBinding : () => indexed.catalogBuild(),
    indexed === undefined ? noIndexedBinding : () => importsThenCapabilities(indexed, record),
    indexed === undefined ? noIndexedBinding : () => indexed.vectorShards(),
    indexed === undefined ? noIndexedBinding : () => indexed.activationVerify(),
  ];
}

/** Run every step against reality, then activate the target in one atomic replacement, the last write. */
async function runPreparation(steps: ScaleTransitionSteps, record: ScaleRecord): Promise<ScaleRecord> {
  if (record.pending?.kind !== "prepare") return record;
  const target = record.pending.target;
  let current = record;
  const runners = runnersFor(steps, record);
  for (let at = 0; at < runners.length; at += 1) {
    const outcome = await runners[at]!();
    current = await recordStep(steps, current, at, outcome);
    if (outcome.status === "parked") return current;
  }
  const activated = { ...current, active: { architecture: target, sinceRevision: current.revision }, pending: null, ...readyCapabilities(current) } as ScaleRecord;
  await writeScaleRecordFrom(steps.record, activated, current);
  return activated;
}

/** Refuse a malformed compare-and-swap token before anything is read. */
function checkedRevision(expected: number | undefined): number | undefined {
  if (expected !== undefined && (!Number.isSafeInteger(expected) || expected < 0)) {
    throw new ScaleRefusalError("scale_invalid_request", "expectedRevision must be a non-negative safe integer");
  }
  return expected;
}

/** The capabilities of `record` as the activation that verified their preparation publishes them: every one `ready`. */
function readyCapabilities(record: ScaleRecord): { capabilities?: CapabilityV3[] } {
  if (record.version === 1 || record.capabilities === undefined) return {};
  return { capabilities: record.capabilities.map((capability) => ({ ...capability, status: "ready" as const })) };
}

/** The names of `record`'s capabilities still `preparing`. */
function capabilitiesPreparing(record: ScaleRecord): CapabilityNameV3[] {
  return record.version === 1 ? [] : (record.capabilities ?? []).filter((capability) => capability.status === "preparing").map((capability) => capability.name);
}

/**
 * THE CAPABILITY UPGRADE of an ACTIVE indexed project (no pending
 * transition): each preparing capability's step runs against reality, then
 * full activation verification; every capability is published `ready` in one
 * compare-and-swap write, the last. A parked step writes nothing: the record
 * stays `preparing` (dependent work stays blocked) and `prepare` resumes it.
 */
async function runCapabilityUpgrade(steps: ScaleTransitionSteps, record: ScaleRecord): Promise<ScaleRecord> {
  const preparing = capabilitiesPreparing(record);
  if (record.pending !== null || preparing.length === 0) return record;
  const indexed = steps.indexed;
  const runners = indexed === undefined ? [noIndexedBinding] : [...preparing.map((name) => () => indexed.capability(name)), () => indexed.activationVerify()];
  for (const run of runners) if ((await run()).status === "parked") return record;
  const upgraded = { ...record, ...readyCapabilities(record) } as ScaleRecord;
  await writeScaleRecordFrom(steps.record, upgraded, record);
  return upgraded;
}

/**
 * The record an ACTIVE indexed project's `prepare` acts on: a needed
 * capability not yet held is added `preparing` (one new revision,
 * compare-and-swap) when the re-plan otherwise changes nothing.
 */
async function withNeededCapabilities(steps: ScaleTransitionSteps, current: ScaleRecord, requested: readonly CapabilityNameV3[]): Promise<ScaleRecord> {
  const candidate = nextRecord(current, planRecordedV2(current.requested), await eligibilityOf(steps), await capabilitiesOf(steps, requested));
  if (candidate.pending !== null || isDeepStrictEqual(capabilityNames(candidate), capabilityNames(current))) return requireRequestedHeld(current, requested);
  await writeScaleRecordFrom(steps.record, requireRequestedHeld(candidate, requested), current);
  await steps.checkpoint?.("after-request");
  return candidate;
}

/** Refuse a requested capability this build does not know, before anything is read. */
export function checkedCapabilities(requested: readonly CapabilityNameV3[] | undefined): readonly CapabilityNameV3[] {
  const known: readonly string[] = CAPABILITIES_V3;
  const unknown = (requested ?? []).find((name) => !known.includes(name));
  if (unknown !== undefined) throw new ScaleRefusalError("scale_invalid_request", `unknown capability ${String(unknown).slice(0, 80)}; known: ${CAPABILITIES_V3.join(", ")}`);
  return requested ?? [];
}

/** The capabilities `steps` say an indexed layout needs, under the lock, then the `requested` ones, each once. */
async function capabilitiesOf(steps: ScaleTransitionSteps, requested: readonly CapabilityNameV3[] = []): Promise<CapabilityNameV3[]> {
  return [...new Set([...(await steps.capabilities?.() ?? []), ...requested])];
}

/** The eligibility blocks `steps` report, under the lock. */
function eligibilityOf(steps: ScaleTransitionSteps): Promise<IneligibleReason[]> {
  return steps.eligibility?.() ?? Promise.resolve([]);
}

/** Set the expected scale over `steps`: THE ONE BODY. */
export async function setExpectedScaleWith(steps: ScaleTransitionSteps, input: SetScaleInput): Promise<ScaleReport> {
  const plan = planScaleV2(input.request);
  const expected = checkedRevision(input.expectedRevision);
  const requested = checkedCapabilities(input.capabilities);
  await steps.acquire();
  try {
    const current = await readForUpdate(steps.record);
    if (expected !== undefined && (current?.revision ?? 0) !== expected) {
      throw new ScaleRefusalError("scale_revision_conflict", `the record is at revision ${current?.revision ?? 0}, not ${expected}`);
    }
    // An explicit capability must be held by the record about to be stored, before the first write.
    const next = requireRequestedHeld(nextRecord(current, plan, await eligibilityOf(steps), await capabilitiesOf(steps, requested)), requested);
    await writeScaleRecordFrom(steps.record, next, current);
    await steps.checkpoint?.("after-request");
    if (input.prepare === false) return reportOf(next, (current?.pending ?? null) !== null);
    const prepared = next.pending?.kind === "prepare" ? await runPreparation(steps, next) : await runCapabilityUpgrade(steps, next);
    return reportOf(prepared, (current?.pending ?? null) !== null);
  } finally {
    await steps.release();
  }
}

/**
 * The record `prepare` should act on: an unavailable estimate, or an indexed
 * transition whose project became ineligible, is RE-PLANNED explicitly under
 * the current policy (one new revision, compare-and-swap under the lock); an
 * unchanged outcome writes nothing.
 */
async function replanned(steps: ScaleTransitionSteps, current: ScaleRecord, requested: readonly CapabilityNameV3[]): Promise<ScaleRecord> {
  const indexedTarget = isIndexedPreparation(current.pending);
  if (current.pending?.kind !== "unavailable" && !indexedTarget) return requireRequestedHeld(current, requested);
  const candidate = nextRecord(current, planRecordedV2(current.requested), await eligibilityOf(steps), await capabilitiesOf(steps, requested));
  if (replanUnchanged(candidate, current, indexedTarget)) return requireRequestedHeld(current, requested);
  await writeScaleRecordFrom(steps.record, requireRequestedHeld(candidate, requested), current);
  await steps.checkpoint?.("after-request");
  return candidate;
}

/** Whether re-planning changed nothing to write: the same outcome (or a still-preparing indexed target) and the same capabilities. */
function replanUnchanged(candidate: ScaleRecord, current: ScaleRecord, indexedTarget: boolean): boolean {
  const sameCapabilities = isDeepStrictEqual(capabilityNames(candidate), capabilityNames(current));
  return sameCapabilities && (sameOutcome(candidate, current) || (indexedTarget && candidate.pending?.kind === "prepare"));
}

/** The capability names a record holds (none for version 1 or 2). */
function capabilityNames(record: ScaleRecord): string[] {
  return record.version === 1 ? [] : (record.capabilities ?? []).map((capability) => capability.name);
}

/** Whether `pending` is a preparation toward `local-indexed`. */
function isIndexedPreparation(pending: ScaleRecord["pending"]): boolean {
  return pending?.kind === "prepare" && pending.target === "local-indexed";
}

/** Whether a re-plan reaches the same outcome as the current record (same version and pending apart from its revision). */
function sameOutcome(candidate: ScaleRecord, current: ScaleRecord): boolean {
  return candidate.version === current.version && isDeepStrictEqual({ ...candidate.pending, revision: 0 }, { ...current.pending, revision: 0 });
}

/** Resume, re-verify or explicitly re-plan the pending transition over `steps`: THE ONE BODY. */
export async function prepareExpectedScaleWith(steps: ScaleTransitionSteps, input: PrepareScaleInput = {}): Promise<ScaleReport> {
  const requested = checkedCapabilities(input.capabilities);
  await steps.acquire();
  try {
    const current = await readForUpdate(steps.record);
    if (current === null) return reportOf(requireRequestedHeld(current, requested));
    if (current.pending === null) {
      const upgrade = current.active.architecture === "local-indexed" ? await withNeededCapabilities(steps, current, requested) : requireRequestedHeld(current, requested);
      return reportOf(await runCapabilityUpgrade(steps, upgrade), upgrade !== current);
    }
    const next = await replanned(steps, current, requested);
    return reportOf(await runPreparation(steps, next), next !== current);
  } finally {
    await steps.release();
  }
}

/** Report the expected scale over `io`, lock-free and read-only: THE ONE BODY. */
export async function scaleStatusFrom(io: ScaleRecordIo): Promise<ScaleReport> {
  return reportOfRead(await readScaleRecordFrom(io));
}

/** The record-derived report of one observation `read`. Pure. */
function reportOfRead(read: ScaleRecordRead): ScaleReport {
  if (read.kind !== "unreadable") return reportOf(read.kind === "ok" ? read.record : null);
  return { readiness: "unreadable", record: null, plan: null, superseded: false, reason: read.reason, notice: SCALE_NOTICE };
}

/** The readiness each admission block reports; any other block leaves the record-derived readiness. */
const ADMISSION_READINESS: Partial<Record<ScaleGateBlock, ScaleReadiness>> = {
  "scale-restore-in-progress": "restoring", "scale-downgrade-pending": "downgrading", "scale-state-unreadable": "unreadable",
};

/** `report` with the admission `refusal` overlaid (record and plan kept); an unreadable record keeps its own bounded fault. Pure. */
function withAdmission(report: ScaleReport, refusal: ScaleGateError | null): ScaleReport {
  const readiness = refusal === null ? undefined : ADMISSION_READINESS[refusal.block];
  if (readiness === undefined || (readiness === "unreadable" && report.readiness === "unreadable")) return report;
  return { ...report, readiness, reason: refusal!.message };
}

/** The disk status of `root` from ONE observation `read`: the record-derived report with the gate's admission overlaid. Read-only. */
export async function scaleStatusObserved(root: string, read: ScaleRecordRead): Promise<ScaleReport> {
  return withAdmission(reportOfRead(read), await scaleGateRefusalFrom(root, read));
}

/** LOCAL DISK. The gated lock, the record, the preflight, the container step and the indexed steps for `root`. */
export function diskScaleTransitionSteps(root: string): ScaleTransitionSteps {
  return {
    acquire: () => acquireMutationLockBlocking(root, "scale"),
    release: () => releaseLock(root),
    record: diskScaleRecordIo(root),
    preflight: diskPreflightIo(root),
    container: diskEmbeddingContainerIo(root),
    eligibility: () => diskScaleEligibility(root),
    capabilities: () => diskScaleCapabilities(root),
    indexed: diskIndexedPreparation(root),
  };
}

/** Set the expected scale of the project at `root`. */
export function setExpectedScale(root: string, input: SetScaleInput): Promise<ScaleReport> {
  return setExpectedScaleWith(diskScaleTransitionSteps(root), input);
}

/** Resume or re-verify the pending transition of the project at `root` (or upgrade its capabilities). */
export function prepareExpectedScale(root: string, input: PrepareScaleInput = {}): Promise<ScaleReport> {
  return prepareExpectedScaleWith(diskScaleTransitionSteps(root), input);
}

/** Report the expected scale of the project at `root`. */
export async function scaleStatus(root: string): Promise<ScaleReport> {
  return scaleStatusObserved(root, await observeScaleRecord(root));
}
