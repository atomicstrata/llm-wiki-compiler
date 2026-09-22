/**
 * @file src/local-workflows/adapt.ts
 * @description The PURE workflow-adaptation plan, the read-only `adapt --dry-run`,
 * and the under-lock `adaptApply` that re-anchors a run to the changed def.
 *
 * When a workflow definition evolves, an in-flight run pinned to the OLD def may
 * sit on a stage id that has since been RENAMED. A renamed stage declares its old
 * id(s) under {@link WorkflowStageDef.previousIds}, so an old id can be mapped to
 * the new one rather than blocking the run. This module computes that mapping:
 *
 *  - {@link mapStageId} — pure + total: an id that is still a stage maps to itself;
 *    else an id named in some stage's `previousIds` maps to that stage's id; else
 *    `null` (unmappable).
 *  - {@link computeAdaptationPlan} — pure (no I/O): builds the per-run plan of every
 *    stage id the run references, partitioned into a `stageMapping` (old→new, identity
 *    included) and an `unmappable` list, with the old/new digests and a `lossless` flag.
 *  - {@link adaptDryRun} — READ-ONLY: loads the profile, resolves the run(s), and
 *    returns a plan per run. It takes NO lock and performs NO write (no `writeRun`):
 *    it is a preview only. For a caller-NAMED id, an unresolvable id AND a
 *    resolvable-but-unreadable leaf are BOTH fail-visible throws (a named run never
 *    vanishes as `[]`). For the bulk (all-runs) path, an individual unreadable leaf
 *    is skipped (skip-malformed). An UNAVAILABLE run store is surfaced as a throw on
 *    both paths (never silently treated as "no runs").
 *  - {@link adaptApply} — UNDER THE PROJECT LOCK (fail-closed read): re-anchors a
 *    run to the active def. A lossless adapt remaps the current stage + stage log
 *    and re-anchors the digest (so the run then classifies `current`); a lossy
 *    adapt fails closed unless `confirm` (a confirmed unmappable current stage
 *    cancels the run, the drop recorded on the `workflow-adapted` event).
 */

import type { LocalWorkflowHost } from "@atomicstrata/llmwiki-core/local-workflow-contracts";
import { workflowDefDigest } from "@atomicstrata/llmwiki-core/local-workflow-contracts";
import { lookupWorkflowDef } from "@atomicstrata/llmwiki-core/local-workflow-contracts";
import { UnknownWorkflowError } from "./start-operation.js";
import { appendRunEvent } from "./events.js";
import { withHostRunLock, isTerminalStatus } from "./with-lock.js";
import { mapStageId } from "@atomicstrata/llmwiki-core/local-workflow-contracts";
export { mapStageId } from "@atomicstrata/llmwiki-core/local-workflow-contracts";
import { projectWithHost } from "./execution-context.js";
import { AdaptationRequiresConfirmError, AlreadyCurrentError, RunNotActiveError } from "./errors.js";
import type { PendingStageOutput, WorkflowRun, WorkflowEvent } from "@atomicstrata/llmwiki-core/local-workflow-contracts";
import type { WorkflowDef } from "@atomicstrata/llmwiki-core/local-workflow-contracts";

/**
 * Raised when remapping a run's `outputs` keys (or any stage-id-keyed field) onto
 * the active def would map two DISTINCT old keys to the SAME new key — an
 * ambiguous merge that would silently clobber one recorded output. Fail closed:
 * the adapt aborts, the run is left byte-unchanged on disk.
 */
export class AdaptationKeyCollisionError extends Error {
  constructor(
    /** The new stage id two old keys both mapped to. */
    readonly newId: string,
  ) {
    super(`adaptation maps two distinct outputs keys to the same stage id ${JSON.stringify(newId)}`);
    this.name = "AdaptationKeyCollisionError";
  }
}

/** A read-only adaptation preview for ONE run against the current workflow def. */
export interface AdaptationPlan {
  /** The run this plan reports on. */
  runId: string;
  /** The workflow the run executes. */
  workflowId: string;
  /** Digest of the def the run was started against. */
  oldDigest: string;
  /** Digest of the CURRENT def the run would be adapted to. */
  newDigest: string;
  /** Every mappable stage id the run references (old→new; identity included). */
  stageMapping: { from: string; to: string }[];
  /** Stage ids the run references that map to `null` (unmappable). */
  unmappable: string[];
  /**
   * Wiki page refs (`<entityType>/<slug>`) recorded under an UNMAPPABLE output key
   * that a confirmed lossy adapt would DROP — leaving the page ORPHANED (the run no
   * longer references it). Reported (not auto-deleted) so an operator can clean it.
   */
  orphanedOutputs: string[];
  /** True when no referenced stage id is unmappable. */
  lossless: boolean;
}

/**
 * The distinct stage ids one run references in its OPERATIONAL state — the fields
 * the state machine reads to decide progress: its current stage, every logged
 * stage, every recorded `outputs` key (an output is keyed by stage id, and
 * `advance` gates a write-declaring stage on `outputs[stage.id]`), AND the
 * `pendingOutput` crash marker's stage (the applied-once gate compares
 * `pendingOutput.stageId === stage.id`). Including the output keys and the pending
 * marker here is what makes a value recorded under a now-unmappable stage a LOSSY
 * plan rather than a silently dropped output OR a disarmed re-apply guard.
 */
function referencedStageIds(run: WorkflowRun): string[] {
  const ids = new Set<string>();
  if (run.currentStage !== null) ids.add(run.currentStage);
  for (const entry of run.stageLog) ids.add(entry.stageId);
  for (const key of Object.keys(run.outputs)) ids.add(key);
  if (run.pendingOutput !== undefined) ids.add(run.pendingOutput.stageId);
  return [...ids];
}

/**
 * The wiki page ref (`<entityType>/<slug>`) recorded under one output key, or
 * `null` when the recorded output is not a page (a relation/lifecycle output, or a
 * shape without both fields). A page output ref carries `entityType` + `slug`
 * strings (see {@link projectAppliedRun}); a dropped page output is the only kind
 * that orphans an authored wiki PAGE the operator may need to clean.
 */
function pageRefOfOutput(value: unknown): string | null {
  if (value === null || typeof value !== "object") return null;
  const ref = value as Record<string, unknown>;
  if (typeof ref.entityType === "string" && typeof ref.slug === "string") {
    return `${ref.entityType}/${ref.slug}`;
  }
  return null;
}

/**
 * The wiki page refs that a confirmed lossy adapt would ORPHAN: for each UNMAPPABLE
 * stage id that ALSO keys a recorded `outputs` entry holding a page ref, the
 * `<entityType>/<slug>` of that dropped page. Pure: derived from the run's
 * `outputs` and the unmappable set, sorted for deterministic reporting.
 */
function orphanedOutputRefs(run: WorkflowRun, unmappable: string[]): string[] {
  const refs: string[] = [];
  for (const key of unmappable) {
    if (!Object.hasOwn(run.outputs, key)) continue;
    const ref = pageRefOfOutput(run.outputs[key]);
    if (ref !== null) refs.push(ref);
  }
  return refs.sort((a, b) => a.localeCompare(b));
}

/**
 * Compute the {@link AdaptationPlan} for one run against the current def. PURE (no
 * I/O): partitions every referenced stage id into `stageMapping` (mappable, via
 * {@link mapStageId}) or `unmappable` (maps to `null`), pins the old/new digests,
 * records the page refs a lossy drop would ORPHAN, and sets `lossless` when nothing
 * is unmappable.
 *
 * @param run - The run record to plan an adaptation for.
 * @param def - The CURRENT workflow definition.
 * @returns The read-only adaptation plan.
 */
export function computeAdaptationPlan(run: WorkflowRun, def: WorkflowDef): AdaptationPlan {
  const stageMapping: { from: string; to: string }[] = [];
  const unmappable: string[] = [];
  for (const from of referencedStageIds(run)) {
    const to = mapStageId(from, def);
    if (to === null) unmappable.push(from);
    else stageMapping.push({ from, to });
  }
  return {
    runId: run.runId,
    workflowId: run.workflowId,
    oldDigest: run.workflowDigest,
    newDigest: workflowDefDigest(def),
    stageMapping,
    unmappable,
    orphanedOutputs: orphanedOutputRefs(run, unmappable),
    lossless: unmappable.length === 0,
  };
}

/**
 * A plan for a run whose workflow was REMOVED from the profile (or a run that is
 * otherwise unplannable against a def): empty mapping, nothing unmappable, and
 * `lossless` true — there is no def to adapt to, so the run is read-only history.
 */
function noDefPlan(run: WorkflowRun): AdaptationPlan {
  return {
    runId: run.runId,
    workflowId: run.workflowId,
    oldDigest: run.workflowDigest,
    newDigest: "",
    stageMapping: [],
    unmappable: [],
    orphanedOutputs: [],
    lossless: true,
  };
}

/** The optional `workflows` block a profile carries. */
type ProfileWorkflows = Record<string, WorkflowDef> | undefined;

/** Raised when `adaptDryRun` cannot resolve a requested run, or the run store is unavailable. */
export class AdaptDryRunError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdaptDryRunError";
  }
}

/**
 * Read one run and plan it (or yield a no-def plan). Returns `null` when the leaf
 * is unreadable AND `failOnUnreadable` is false (the BULK path's intended
 * skip-malformed behavior). When `failOnUnreadable` is true (a caller-NAMED id,
 * already confirmed present by `resolveRunId`), an `unavailable`/`absent` read is
 * surfaced as an {@link AdaptDryRunError} rather than vanishing as `[]` — the
 * "unavailable-reads-as-empty" class is a fail-visible problem for a named run.
 */
async function planForRun(
  host: LocalWorkflowHost,
  root: string,
  runId: string,
  workflows: ProfileWorkflows,
  failOnUnreadable: boolean,
): Promise<AdaptationPlan | null> {
  const read = await host.history.read(root, runId);
  if (read.status !== "ok") {
    if (failOnUnreadable) {
      const detail = read.status === "unavailable" ? read.detail : read.status;
      throw new AdaptDryRunError(`run record could not be read (${detail}): ${JSON.stringify(runId)}`);
    }
    return null;
  }
  const def = lookupWorkflowDef(workflows, read.run.workflowId);
  return def === undefined ? noDefPlan(read.run) : computeAdaptationPlan(read.run, def);
}

/** Resolve the run ids `adaptDryRun` should plan: one named id, or every readable run. */
async function resolveRunIds(host: LocalWorkflowHost, root: string, runId?: string): Promise<string[]> {
  if (runId !== undefined) {
    const resolved = await host.history.resolve(root, runId);
    if (resolved.status === "unavailable") throw new AdaptDryRunError(`run store unavailable: ${resolved.detail}`);
    if (resolved.status === "not-found") throw new AdaptDryRunError(`unknown or invalid run id: ${JSON.stringify(runId)}`);
    return [resolved.runId];
  }
  const list = await host.history.list(root);
  if (list.status === "unavailable") throw new AdaptDryRunError(`run store unavailable: ${list.detail}`);
  return list.runIds;
}

/** Preview adaptation through passive host reads without a mutation transaction. */
export async function adaptDryRunWithHost(host: LocalWorkflowHost, root: string, runId?: string): Promise<AdaptationPlan[]> {
  const { profile } = await host.profiles.load(root);
  const runIds = await resolveRunIds(host, root, runId);
  const failOnUnreadable = runId !== undefined;
  const plans: AdaptationPlan[] = [];
  for (const id of runIds) {
    const plan = await planForRun(host, root, id, profile.workflows, failOnUnreadable);
    if (plan !== null) plans.push(plan);
  }
  return plans;
}

/**
 * A short `oldDigest→newDigest` detail for the adapt event, recording any dropped
 * stage ids AND any wiki page refs that a confirmed lossy drop ORPHANS — so the
 * orphaned content is REPORTED in the audit trail, not silently left behind (the
 * page itself is NOT auto-deleted; this is the operator's signal to clean it).
 */
function adaptDetail(plan: AdaptationPlan): string {
  const drift = `${plan.oldDigest.slice(0, 8)}→${plan.newDigest.slice(0, 8)}`;
  const parts = [drift];
  if (plan.unmappable.length) parts.push(`dropped: ${plan.unmappable.join(",")}`);
  if (plan.orphanedOutputs.length) parts.push(`orphaned: ${plan.orphanedOutputs.join(",")}`);
  return parts.join("; ");
}

/**
 * Remap the `outputs` KEYS onto the active def: each mappable key `k` becomes
 * `mapStageId(k, def)`; an UNMAPPABLE key (only reachable on a CONFIRMED lossy
 * path) is DROPPED (already reflected in `plan.unmappable`). FAILS CLOSED with
 * {@link AdaptationKeyCollisionError} when two distinct old keys map to the SAME
 * new key — an ambiguous merge that would silently clobber a recorded output.
 */
function remapOutputs(outputs: Record<string, unknown>, def: WorkflowDef): Record<string, unknown> {
  const remapped: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(outputs)) {
    const to = mapStageId(key, def);
    if (to === null) continue;
    if (Object.hasOwn(remapped, to)) throw new AdaptationKeyCollisionError(to);
    remapped[to] = value;
  }
  return remapped;
}

/**
 * Best-effort remap of each event's `stageId` onto the active def, for CONSISTENCY
 * — a renamed stage's historical events now reference its new id. An UNMAPPABLE
 * event `stageId` is left AS-IS (it is historical audit of a removed stage, not
 * operational state; events never affect the lossless/lossy decision).
 */
function remapEventStageIds(events: WorkflowEvent[], def: WorkflowDef): WorkflowEvent[] {
  return events.map((event) => {
    if (event.stageId === undefined) return event;
    const to = mapStageId(event.stageId, def);
    return to === null ? event : { ...event, stageId: to };
  });
}

/**
 * Re-anchor `run` to `def` per `plan` (PURE — no I/O, input untouched). EVERY
 * stage-id-keyed/bearing field is remapped via {@link mapStageId}: the current
 * stage, the stage-log entries, the `outputs` KEYS ({@link remapOutputs}, which
 * fails closed on a key collision), and — best-effort, for audit consistency —
 * the existing events' `stageId`s ({@link remapEventStageIds}). An UNMAPPABLE id
 * (only reachable on a CONFIRMED lossy path) is dropped from the operational
 * fields and, if it was the current stage, CANCELS the run. `knownStageIds` is
 * reset to the new def's stages and `workflowDigest` re-anchored. A
 * `workflow-adapted` event records the lossless/lossy decision + digest drift.
 */
function remapRun(run: WorkflowRun, def: WorkflowDef, plan: AdaptationPlan): WorkflowRun {
  const remappedStage = run.currentStage === null ? null : mapStageId(run.currentStage, def);
  const cancelled = run.currentStage !== null && remappedStage === null;
  const outputs = remapOutputs(run.outputs, def);
  const pendingOutput = remapPending(run.pendingOutput, def);
  const stageLog = run.stageLog
    .map((entry) => ({ entry, to: mapStageId(entry.stageId, def) }))
    .filter((m) => m.to !== null)
    .map((m) => ({ ...m.entry, stageId: m.to as string }));
  const withRemappedEvents = { ...run, events: remapEventStageIds(run.events, def) };
  const adapted = appendRunEvent(withRemappedEvents, {
    type: "workflow-adapted", at: new Date().toISOString(), actorKind: "system",
    decision: plan.lossless ? "lossless" : "lossy", detail: adaptDetail(plan),
  });
  const { pendingOutput: _dropped, ...rest } = adapted;
  return {
    ...rest,
    ...(pendingOutput ? { pendingOutput } : {}),
    status: cancelled ? "cancelled" : adapted.status,
    currentStage: cancelled ? null : remappedStage,
    stageLog, outputs,
    knownStageIds: def.stages.map((stage) => stage.id),
    workflowDigest: plan.newDigest,
  };
}

/**
 * Re-anchor the `pendingOutput` crash marker to `def`: its `stageId` follows a
 * rename (keeping the applied-once gate armed on the new stage id), and a marker
 * whose stage was REMOVED is dropped — reachable only on a CONFIRMED-lossy plan
 * ({@link referencedStageIds} counts it, so removal forces confirm). The `opId`
 * (the in-flight write's identity) is preserved.
 */
function remapPending(pending: PendingStageOutput | undefined, def: WorkflowDef): PendingStageOutput | undefined {
  if (pending === undefined) return undefined;
  const mapped = mapStageId(pending.stageId, def);
  return mapped === null ? undefined : { ...pending, stageId: mapped };
}

/** Apply the existing adaptation policy using host-owned reads and transaction-bound persistence. */
export async function adaptApplyWithHost(host: LocalWorkflowHost, root: string, runId: string,
  opts?: { confirm?: boolean }): Promise<WorkflowRun> {
  const remapped = await withHostRunLock(host, root, runId, async (run, context) => {
    if (isTerminalStatus(run.status)) throw new RunNotActiveError(runId, run.status);
    const { profile } = await host.profiles.load(root);
    const def = lookupWorkflowDef(profile.workflows, run.workflowId);
    if (def === undefined) throw new UnknownWorkflowError(run.workflowId);
    const plan = computeAdaptationPlan(run, def);
    if (plan.newDigest === run.workflowDigest) throw new AlreadyCurrentError(runId);
    if (!plan.lossless && !opts?.confirm) throw new AdaptationRequiresConfirmError(runId, plan.unmappable, plan.orphanedOutputs);
    const adapted = remapRun(run, def, plan);
    await host.records.write(context.transaction, root, adapted);
    return adapted;
  });
  await projectWithHost(host, root, remapped);
  return remapped;
}
