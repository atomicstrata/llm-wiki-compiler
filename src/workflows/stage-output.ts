/**
 * @file src/workflows/stage-output.ts
 * @description Scope-gated PAGE stage-output submission — the seam that wires a
 * write-declaring workflow stage into the planner→executor write path.
 *
 * A stage that declares a non-empty `writes` set does NOT advance on its own
 * (that is `advance`'s read-only/gate-only job): it advances when the caller
 * SUBMITS a typed output for it. This module handles four output kinds — `page`,
 * `relation`, `lifecycle-transition`, and `artifact` — each routed through the
 * planner→executor seam under the same scope guard + lock discipline. The
 * `artifact` kind is scope-gated on the stage's `artifactWrites` and stamps a
 * harness-controlled {@link WorkflowArtifactOrigin} the caller can never forge.
 *
 * SECURITY MODEL (two load-bearing invariants):
 *
 * 1. SCOPE. A stage may write ONLY the entity types it declares in `writes`. The
 *    scope guard runs BEFORE any planning or I/O: an output naming an entity type
 *    outside the current stage's `writes` is refused with {@link StageWriteScopeError}
 *    and the run is left byte-unchanged. (A traversal-bearing slug never reaches
 *    the planner's slug-safe floor when its type is out of scope — the scope guard
 *    short-circuits first; an in-scope traversal slug is still rejected by the
 *    planner's identity floor as a decision, never a thrown exception.) For a
 *    `relation` output the scope unit is the endpoint entity TYPES (the `<type>`
 *    half of each `<type>/<slug>` endpoint EntityId): BOTH must be in `writes`. For
 *    a `lifecycle-transition` output the scope unit is the target `entityType`.
 *
 * RELATION/LIFECYCLE APPLY (no pre-decision). Unlike the page path — which plans a
 * decision the seam then branches on — the relation and lifecycle kinds route to
 * the executor's UNDER-LOCK authority ({@link applyApprovedMutationsLocked}), which
 * re-loads the profile, re-plans, re-composes the decision, and EITHER applies
 * (success) OR THROWS a denial ({@link RelationWriteDeniedError} /
 * {@link LifecycleTransitionError}). There is no staged/`deny` branch here: a
 * thrown denial propagates with the run byte-unchanged and NO gate satisfied; a
 * successful apply records the output, satisfies a `trust:` gate, and reports the
 * REAL decision the under-lock authority composed (`allow`/`allow-with-warning`),
 * threaded back through the {@link ApplyResult} rather than a hardcoded literal.
 *
 * ATOMICITY (durability boundary): an applied write is PRE-VALIDATED before the
 * external mutation runs — the projected run record (with the `stage-output` event
 * appended, enforcing the event-count cap, and sized against the run byte cap) is
 * validated FIRST, so a cap violation throws BEFORE any page/relation/lifecycle
 * write. This eliminates the silent-unaudited-write class where the live mutation
 * lands but the workflow output/gate can never be recorded.
 *
 * IDEMPOTENCY (applied-once): a stage produces its output AT MOST ONCE. Under the
 * lock, BEFORE dispatch, the seam refuses a re-submission whose output is already
 * recorded ({@link StageOutputAlreadyAppliedError}) — no second external write. To
 * make a crash between the external apply and the output record VISIBLE rather than
 * a silent orphan, an INTENT marker (`run.pendingOutput`) is persisted BEFORE the
 * apply and CLEARED in the record-output write; a fresh submit that finds an
 * un-cleared marker for the current stage fails closed ({@link StageOutputPendingError})
 * so an operator reconciles whether the prior write landed, never an auto re-apply.
 * (The full cross-store op-id journal that would AUTO-reconcile is a documented
 * residual; this makes the orphan non-silent and blocks the auto-duplicate.)
 *
 * 2. NO PRIVILEGED CHANNEL. The write is planned with `reviewRouted:true` and
 *    `origin:"workflow"` — a stage output is NOT a trusted write channel. A
 *    BLOCKED write is PARKED (recorded as `stage-for-review`) rather than
 *    landing, never silently applying. `stage-for-review`/`quarantine` stay
 *    blocked (the gate is NOT satisfied) and `deny` writes nothing at all
 *    ({@link StageWriteDeniedError}).
 *
 *    TRUST-GATE SAFETY (C3). A `trust:` stage gate means "trusted review
 *    required", NOT "well-formed ⇒ live". For a `trust:`-gated PAGE stage WITHOUT
 *    an out-of-band operator grant ({@link isTrustedWriteGranted} —
 *    `LLMWIKI_TRUSTED_WRITE`), even a clean `allow` is DOWNGRADED to PARKED: the
 *    write does NOT go live and the trust gate is NOT satisfied. The gate is
 *    satisfied ONLY when the operator grant auto-applies the write (their explicit
 *    out-of-band choice). HONESTY: parking records ONLY a run event — it creates
 *    NO `.llmwiki/candidates` review item, so `review list`/`approve` cannot see
 *    or promote a workflow-parked output (wiring a real review-promotion path
 *    that also satisfies the gate is a deferred capability); today a parked trust
 *    output leaves the stage blocked until the operator grant re-applies it. This
 *    closes the "any valid markdown auto-satisfies a trust gate" exploit. A
 *    non-`trust:` stage keeps the normal apply-on-`allow` behavior.
 *
 *    The RELATION and LIFECYCLE kinds are not parked at all. For a `trust:`-gated
 *    relation/lifecycle stage WITHOUT the grant, the write is REFUSED outright
 *    ({@link TrustGateRequiresGrantError}): nothing is written, the gate is NOT
 *    satisfied, the run is byte-unchanged. The operator grant is the ONLY way
 *    such a write proceeds. So on ALL three kinds, a clean well-formed output can
 *    NEVER auto-satisfy a trust gate without the grant — pages PARK (not
 *    applied), relation/lifecycle REFUSE.
 *
 * The whole read→scope-guard→plan→apply→writeRun sequence runs under ONE
 * bounded-blocking project lock (released in `finally`), mirroring the relation
 * write seam — so a concurrent writer serializes rather than tearing this run.
 *
 * KNOWN LIMITATION — ONE output per stage. A recorded output is keyed by STAGE ID
 * (`outputs[stage.id]`; see {@link projectAppliedRun}), and `advance` gates a
 * write-declaring stage on that single key being present. So a stage that declares
 * MULTIPLE distinct `writes` entity types records only the FIRST submitted output
 * and advances on it — it cannot emit one durable output ref per declared write.
 * Per-write output keying (e.g. `outputs[stage.id][entityType]`) is a documented
 * FUTURE enhancement; today a stage produces a single output ref. See
 * {@link WorkflowRun.outputs}.
 */

import { acquireLockBlocking, releaseLock } from "../utils/lock.js";
import { planPageMutation, type PlanResult } from "../trust/planner.js";
import type { RelationPlannedMutation, LifecycleTransitionPlannedMutation } from "../trust/planner.js";
import { applyApprovedMutationsLocked } from "../trust/executor.js";
import { validateLiveTypedPage } from "../trust/typed-page-validate.js";
import { loadNonDefaultProfile } from "../profile/block.js";
import { parseEntityId } from "../profile/identity.js";
import { appendRunEvent } from "./events.js";
import { readRun, writeRun } from "./store.js";
import { resolveCurrentStage } from "./advance.js";
import { maybeAutoProject } from "./projection.js";
import { isTerminalStatus, assertRunOwnership } from "./with-lock.js";
import { markRunFailedLocked } from "./fail.js";
import { isHardDenial } from "./hard-denial.js";
import {
  RunUnavailableError,
  RunNotActiveError,
  StageWriteScopeError,
  StageHasNoWritesError,
  StageWriteDeniedError,
  StageOutputAlreadyAppliedError,
  StageOutputPendingError,
} from "./errors.js";
import {
  preflightApplyRecord,
  guardTrustGatedNonPageWrite,
  trustGateRequiresStaging,
  WORST_CASE_DECISION,
  type SubmitResult,
} from "./stage-output-internals.js";
import { applyArtifactOutput } from "./artifact-output.js";
import type { ArtifactStageOutput, WorkflowArtifactOrigin, SubmitStageOutputOptions } from "./artifact-output.js";
import type { TrustDecision } from "../trust/decision.js";
import type { ApplyResult } from "../trust/apply-result.js";
import type { WorkflowRun } from "./types.js";
import type { WorkflowStageDef } from "../profile/types.js";
import type { AppendRelationInput } from "../relations/store.js";
import type { EntityId } from "../profile/types.js";

/** A page output: write `body` to the entity page `entityType/slug`. */
export interface PageStageOutput {
  kind: "page";
  entityType: string;
  slug: string;
  body: string;
}

/** A relation output: create the typed relation `input` (endpoint types must be in scope). */
export interface RelationStageOutput {
  kind: "relation";
  input: AppendRelationInput;
}

/** A lifecycle-transition output: move `entityType/slug` to `toState`. */
export interface LifecycleStageOutput {
  kind: "lifecycle-transition";
  entityType: string;
  slug: string;
  toState: string;
  evidence?: Record<string, unknown>;
}

/** The typed output a caller submits to advance a write-declaring stage. */
export type StageOutput = PageStageOutput | RelationStageOutput | LifecycleStageOutput | ArtifactStageOutput;

// The artifact arm's public types live in `artifact-output.js`; `SubmitResult` and the
// shared under-lock apply engine live in `stage-output-internals.js`. `SubmitResult` is
// re-exported below so existing `from "../workflows/stage-output.js"` importers are unchanged.
export type { SubmitResult } from "./stage-output-internals.js";

/** Decisions whose write lands LIVE (and may satisfy a `trust:` gate). */
const APPLY_DECISIONS: ReadonlySet<TrustDecision> = new Set(["allow", "allow-with-warning"]);

/** True when `decision` means the write should land live. */
function isApplyDecision(decision: TrustDecision): boolean {
  return APPLY_DECISIONS.has(decision);
}

/**
 * THE scope primitive: refuse `entityType` if it is not in the current stage's
 * `writes` set, BEFORE any planning or I/O. A stage writes only what it declares;
 * an out-of-scope type fails closed with {@link StageWriteScopeError}. Every kind's
 * scope guard runs through here so the boundary is enforced in exactly one place.
 */
function requireInScope(runId: string, stage: WorkflowStageDef, entityType: string): void {
  if (!stage.writes.includes(entityType)) {
    throw new StageWriteScopeError(runId, stage.id, entityType);
  }
}

/** The entity type of an endpoint EntityId — the `<type>` half of `<type>/<slug>`. */
function endpointEntityType(endpoint: EntityId): string {
  return parseEntityId(endpoint).entityType;
}

/**
 * The relation scope guard. A relation's endpoint entity TYPES (the `<type>` half
 * of each `<type>/<slug>` endpoint EntityId — `input.from` and `input.to`) must
 * ALL be in the stage's `writes`: a stage that relates entities must declare every
 * participating entity type. Refused BEFORE any executor call; nothing is written.
 */
function scopeGuardRelation(runId: string, stage: WorkflowStageDef, input: AppendRelationInput): void {
  requireInScope(runId, stage, endpointEntityType(input.from));
  requireInScope(runId, stage, endpointEntityType(input.to));
}

/**
 * Plan the page write through the trust planner with NO privileged channel:
 * `origin:"workflow"` and `reviewRouted:true`, so a blocked write routes for
 * review (`stage-for-review`) rather than `deny`-ing or silently landing.
 */
function planStagePage(root: string, output: PageStageOutput): Promise<PlanResult> {
  return planPageMutation({
    root,
    target: { kind: "entity", entityType: output.entityType, slug: output.slug },
    body: output.body,
    origin: "workflow",
    reviewRouted: true,
  });
}

/**
 * A worst-case `relationId` placeholder length: a real id is `rel_<ULID>` (4 + 26
 * = 30 chars). 64 is a comfortable upper bound that stays ≥ any real id, so the
 * pre-validated candidate's size is a genuine upper bound on the recorded one.
 */
const WORST_CASE_RELATION_ID = "r".repeat(64);

/**
 * Run the SAME full typed-candidate validation the promote path runs — field
 * contract + lifecycle FSM(prev→next) + relation-count precondition
 * ({@link validateLiveTypedPage}) — on a workflow `page` output about to land LIVE,
 * so a stage output can never bypass the typed gates the review-approve path
 * enforces (the planner floor alone checks identity/collision/resource/frontmatter-
 * parse, NOT the typed contract). Loads the active profile UNDER the already-held
 * lock (no pre-lock TOCTOU) and validates only when the profile declares the
 * output's entity type — an undeclared type has no typed contract to enforce and
 * the planner floor already governed the write. A non-lifecycle entity simply has
 * no FSM/precondition to check; the field-contract check still runs. On any
 * violation it THROWS so the page does NOT land: the caller's auto-fail routing
 * treats a field/FSM/unmet-relation violation as a hard denial, while an
 * unverifiable relation store PARKS the run (see {@link isHardDenial}).
 */
async function validateTypedPageOutput(root: string, output: PageStageOutput): Promise<void> {
  const loaded = await loadNonDefaultProfile(root);
  const def = loaded?.profile.entities[output.entityType];
  if (!loaded || !def) return;
  await validateLiveTypedPage({
    root,
    profile: loaded.profile,
    entityType: output.entityType,
    slug: output.slug,
    body: output.body,
    def,
  });
}

/**
 * Apply an approved (`allow`/`allow-with-warning`) page write — RUNNING the full
 * typed-page validation ({@link validateTypedPageOutput}) FIRST so a typed entity
 * page cannot go live missing a required field, on an illegal FSM transition, or
 * into a gated lifecycle state without its relation precondition — then PRE-VALIDATING
 * the record before the apply. The page decision is known plan-side, so no post-apply
 * substitution is needed; the worst-case and real refs are identical here.
 */
async function applyPageOutput(
  root: string,
  run: WorkflowRun,
  stage: WorkflowStageDef,
  output: PageStageOutput,
  result: PlanResult,
): Promise<WorkflowRun> {
  await validateTypedPageOutput(root, output);
  const ref = { entityType: output.entityType, slug: output.slug, decision: result.decision };
  return preflightApplyRecord(root, run, stage, ref, async () => {
    await applyApprovedMutationsLocked(root, result.planned);
    return { decision: result.decision, outputRef: ref };
  });
}

/** The persisted relation ref + composed decision from a `relation` apply result. */
function relationApplied(results: ApplyResult[]): { id: string | undefined; decision: TrustDecision } {
  const first = results[0];
  if (first?.kind !== "relation") return { id: undefined, decision: "allow" };
  return { id: first.ref.id, decision: first.decision };
}

/**
 * Handle a `relation` output: SCOPE-GUARD the endpoint entity types (BOTH must be
 * in `writes`), then route a single {@link RelationPlannedMutation} through the
 * executor's under-lock relation authority — which decides + applies, or THROWS a
 * {@link RelationWriteDeniedError} (propagated, run byte-unchanged). The record is
 * PRE-VALIDATED (worst-case relationId/decision) BEFORE the apply, so an over-cap
 * record throws without ever appending the relation. On success records the real
 * persisted ref + composed decision + satisfies a `trust:` gate.
 *
 * TRUST-GATE SAFETY (C3): a `trust:`-gated relation stage WITHOUT the out-of-band
 * operator grant is REFUSED ({@link guardTrustGatedNonPageWrite}) before any apply —
 * relations have no staged-review path, so they fail closed rather than auto-apply.
 */
async function applyRelationOutput(
  root: string,
  runId: string,
  run: WorkflowRun,
  stage: WorkflowStageDef,
  output: RelationStageOutput,
  projectId: string,
): Promise<SubmitResult> {
  scopeGuardRelation(runId, stage, output.input);
  guardTrustGatedNonPageWrite(runId, stage, projectId, "relation");
  const mutation: RelationPlannedMutation = { kind: "relation", operation: "create", input: output.input };
  const worstRef = { relationId: WORST_CASE_RELATION_ID, type: output.input.type, decision: WORST_CASE_DECISION };
  let decision: TrustDecision = "allow";
  const recorded = await preflightApplyRecord(root, run, stage, worstRef, async () => {
    const applied = relationApplied(await applyApprovedMutationsLocked(root, [mutation]));
    decision = applied.decision;
    return { decision, outputRef: { relationId: applied.id, type: output.input.type, decision } };
  });
  return { run: recorded, applied: true, decision };
}

/**
 * Handle a `lifecycle-transition` output: SCOPE-GUARD the target `entityType`,
 * then route a single {@link LifecycleTransitionPlannedMutation} through the
 * executor's under-lock lifecycle authority — which decides + writes the page, or
 * THROWS on an illegal/unauthorized transition (propagated, page+run byte-
 * unchanged). The record is PRE-VALIDATED (worst-case decision) BEFORE the apply,
 * so an over-cap record throws without ever touching the page. On success records
 * the output + the real composed decision + satisfies a `trust:` gate.
 *
 * TRUST-GATE SAFETY (C3): a `trust:`-gated lifecycle stage WITHOUT the out-of-band
 * operator grant is REFUSED ({@link guardTrustGatedNonPageWrite}) before any apply —
 * lifecycle writes have no staged-review path, so they fail closed rather than
 * auto-apply.
 */
async function applyLifecycleOutput(
  root: string,
  runId: string,
  run: WorkflowRun,
  stage: WorkflowStageDef,
  output: LifecycleStageOutput,
  projectId: string,
): Promise<SubmitResult> {
  requireInScope(runId, stage, output.entityType);
  guardTrustGatedNonPageWrite(runId, stage, projectId, "lifecycle-transition");
  const mutation: LifecycleTransitionPlannedMutation = {
    kind: "lifecycle-transition",
    entityType: output.entityType,
    slug: output.slug,
    toState: output.toState,
    evidence: output.evidence,
  };
  const base = { entityType: output.entityType, slug: output.slug, toState: output.toState };
  let decision: TrustDecision = "allow";
  const recorded = await preflightApplyRecord(root, run, stage, { ...base, decision: WORST_CASE_DECISION }, async () => {
    const [result] = await applyApprovedMutationsLocked(root, [mutation]);
    decision = result?.kind === "lifecycle-transition" ? result.decision : "allow";
    return { decision, outputRef: { ...base, decision } };
  });
  return { run: recorded, applied: true, decision };
}

/**
 * Record a PARKED (`stage-for-review`/`quarantine`) decision on the run WITHOUT
 * applying live and WITHOUT satisfying the trust gate. HONESTY: only the run
 * event records the decision — the output is parked, nothing lands on disk, and
 * NO `.llmwiki/candidates` review item is created on this path, so `review
 * list`/`approve` cannot see it (a review-promotion path for workflow-parked
 * outputs is a deferred capability). The stage stays blocked. Returns the
 * persisted run. (`stage-for-review` remains the recorded decision value — it is
 * a persisted Phase-5 run-record enum; only the human-facing wording changed.)
 */
async function recordStaged(
  root: string,
  run: WorkflowRun,
  stage: WorkflowStageDef,
  decision: TrustDecision,
): Promise<WorkflowRun> {
  const at = new Date().toISOString();
  const recorded = appendRunEvent(run, { type: "stage-output", at, actorKind: "agent", stageId: stage.id, decision });
  await writeRun(root, recorded);
  return recorded;
}

/**
 * Submit a `page` output: SCOPE-GUARD the `entityType` before any planning, plan
 * with no privileged channel, then branch on the decision — APPLY
 * (`allow`/`allow-with-warning`) lands the write + records + satisfies a `trust:`
 * gate; PARKED (`stage-for-review`/`quarantine`) records the run event but does
 * NOT land, satisfy, or create a review candidate; DENY writes nothing and
 * throws {@link StageWriteDeniedError}.
 *
 * TRUST-GATE SAFETY (C3): for a `trust:`-gated stage WITHOUT an out-of-band
 * operator grant, even a clean `allow` is DOWNGRADED to PARKED — the write does
 * NOT go live and the trust gate is NOT satisfied. It is satisfied ONLY by the
 * operator grant's auto-apply: a parked workflow output has no review candidate
 * to promote (that promotion path is a deferred capability).
 */
async function submitPageOutput(
  root: string,
  runId: string,
  run: WorkflowRun,
  stage: WorkflowStageDef,
  output: PageStageOutput,
  projectId: string,
): Promise<SubmitResult> {
  requireInScope(runId, stage, output.entityType);
  const result = await planStagePage(root, output);
  if (isApplyDecision(result.decision) && trustGateRequiresStaging(stage, projectId)) {
    return { run: await recordStaged(root, run, stage, "stage-for-review"), applied: false, decision: "stage-for-review" };
  }
  if (isApplyDecision(result.decision)) {
    return { run: await applyPageOutput(root, run, stage, output, result), applied: true, decision: result.decision };
  }
  if (result.decision === "deny") throw new StageWriteDeniedError(runId, result.decision);
  return { run: await recordStaged(root, run, stage, result.decision), applied: false, decision: result.decision };
}

/**
 * The IDEMPOTENCY gate, run FIRST under the lock for the resolved current stage:
 *
 *  - A `pendingOutput` for THIS stage means a prior submit crashed AFTER persisting
 *    its intent but BEFORE recording the output — the external write MAY have landed
 *    un-recorded. FAIL CLOSED with {@link StageOutputPendingError} (never silently
 *    re-apply, which would duplicate the write); an operator must reconcile.
 *  - An already-recorded `outputs[stage.id]` means the stage already produced its
 *    output. A stage produces its output AT MOST ONCE, so re-submission is refused
 *    with {@link StageOutputAlreadyAppliedError} — no second external write.
 */
function assertOutputNotApplied(runId: string, run: WorkflowRun, stage: WorkflowStageDef): void {
  if (run.pendingOutput?.stageId === stage.id) {
    throw new StageOutputPendingError(runId, stage.id, run.pendingOutput.opId);
  }
  if (Object.hasOwn(run.outputs, stage.id)) {
    throw new StageOutputAlreadyAppliedError(runId, stage.id);
  }
}

/** Dispatch an output to its kind handler (all run under the held lock). */
function dispatchOutput(
  root: string,
  runId: string,
  run: WorkflowRun,
  stage: WorkflowStageDef,
  output: StageOutput,
  projectId: string,
  origin: WorkflowArtifactOrigin,
): Promise<SubmitResult> {
  if (output.kind === "page") return submitPageOutput(root, runId, run, stage, output, projectId);
  if (output.kind === "relation") return applyRelationOutput(root, runId, run, stage, output, projectId);
  if (output.kind === "lifecycle-transition") return applyLifecycleOutput(root, runId, run, stage, output, projectId);
  return applyArtifactOutput(root, runId, run, stage, output, projectId, origin);
}

/**
 * Carries the just-failed run ALONGSIDE the original denial error out of the held
 * lock, so {@link submitStageOutput} can auto-PROJECT the failed run AFTER the lock
 * is released (mirroring the success path) and then re-throw the ORIGINAL denial.
 * Internal: it is always unwrapped in {@link submitStageOutput}, so a caller only
 * ever sees the original typed denial (`StageWriteDeniedError`/`RelationWriteDeniedError`/…).
 */
class AutoFailedSubmitError extends Error {
  constructor(
    /** The original hard-denial error to re-throw to the caller. */
    readonly original: unknown,
    /** The run as persisted in terminal `failed` (to be auto-projected post-lock). */
    readonly failedRun: WorkflowRun,
  ) {
    super(original instanceof Error ? original.message : String(original));
    this.name = "AutoFailedSubmitError";
  }
}

/**
 * Dispatch the output, and on a HARD DENIAL ({@link isHardDenial}) — the executor
 * REFUSED the write, so this attempt is a dead-end — CO-COMMIT the run to terminal
 * `failed` under the SAME held lock ({@link markRunFailedLocked}, recording the
 * denial message in the `run-failed` event detail), then throw an
 * {@link AutoFailedSubmitError} carrying the failed run + the ORIGINAL error. The
 * caller (post-lock) auto-projects the failed run and re-throws the original denial,
 * so the run is left `failed` (retryable via `resume`) AND its declared
 * `projectionFile` reflects the failure (not left stale). A STAGED page write is NOT
 * a hard denial (it returns `applied:false`, not a throw) and is left parked. A
 * recoverable guard (scope/idempotency/pending/cap) propagates UNCHANGED.
 */
async function dispatchOrAutoFail(
  root: string,
  runId: string,
  run: WorkflowRun,
  stage: WorkflowStageDef,
  output: StageOutput,
  projectId: string,
  origin: WorkflowArtifactOrigin,
): Promise<SubmitResult> {
  try {
    return await dispatchOutput(root, runId, run, stage, output, projectId, origin);
  } catch (err) {
    if (!isHardDenial(err)) throw err;
    const failed = await markRunFailedLocked(root, run, err instanceof Error ? err.message : String(err));
    throw new AutoFailedSubmitError(err, failed);
  }
}

/**
 * Submit a typed output (`page`/`relation`/`lifecycle-transition`) to advance a
 * write-declaring stage, routing the write through the planner→executor seam under
 * ONE bounded-blocking project lock.
 *
 * Sequence (all under the held lock): fail-closed read ({@link RunUnavailableError}
 * on absent/unavailable, {@link RunNotActiveError} on terminal); resolve the
 * current stage; reject a no-writes stage ({@link StageHasNoWritesError}); then
 * dispatch on the output kind. The SCOPE GUARD runs FIRST in every handler, before
 * any planning/executor call, so a scope violation writes nothing. The `page` path
 * plans a decision the seam branches on (apply / stage-for-review / deny). The
 * `relation` and `lifecycle-transition` paths route to the executor's UNDER-LOCK
 * authority, which decides + applies or THROWS a denial
 * ({@link RelationWriteDeniedError} / the lifecycle handler's transition error) —
 * the denial propagates and NO gate is satisfied; a successful apply records the
 * output, satisfies a `trust:` gate, and reports the REAL composed decision
 * (`allow`/`allow-with-warning`). Every applied write is PRE-VALIDATED against the
 * event-count + run-byte caps BEFORE the external mutation, so a cap violation throws
 * with nothing written live.
 *
 * AUTO-FAIL ON HARD DENIAL: a HARD-DENIED write (the executor REFUSED it — a page
 * `deny`, a relation/lifecycle denial, or a trust-gated relation/lifecycle write
 * with no grant; see {@link isHardDenial}) is a dead-end for the attempt, so the run
 * is routed to terminal `failed` under the SAME held lock (the denial message lands
 * in the `run-failed` event detail) and the ORIGINAL denial error is re-thrown — the
 * caller still sees the denial, and the run is retryable via `resume` rather than
 * stuck `awaiting-output`. A STAGED page write (`applied:false`, not a throw) is NOT
 * a failure and is left parked; a recoverable guard (scope/idempotency/pending/cap)
 * propagates without failing the run.
 *
 * @param root - Absolute project root.
 * @param runId - The slug-safe run id to submit against.
 * @param output - The typed stage output (`page`/`relation`/`lifecycle-transition`/`artifact`).
 * @param opts - The options bag: the harness-stamped artifact `origin` (default
 *   `"workflow"`) and `lockOptions` (bounded-blocking-lock overrides, previously
 *   the positional 4th arg — now carried under `opts.lockOptions`).
 * @returns The persisted run, whether the write applied live, and the decision.
 * @throws {LockBusyError} When the project lock stays held past the timeout.
 * @throws {RunUnavailableError} When the run is absent/unavailable.
 * @throws {RunNotActiveError} When the run is terminal.
 * @throws {RunOwnerMismatchError} When the run is owned by a different caller (M1).
 * @throws {StageHasNoWritesError} When the current stage declares no writes.
 * @throws {StageOutputAlreadyAppliedError} When the stage already produced its output.
 * @throws {StageOutputPendingError} When a prior submit crashed mid-apply (un-cleared intent).
 * @throws {StageWriteScopeError} When an output entity type is out of scope.
 * @throws {StageWriteDeniedError} When the Trust Guard denied a page write.
 * @throws {RelationWriteDeniedError} When the relation authority denied the write.
 */
export async function submitStageOutput(
  root: string,
  runId: string,
  output: StageOutput,
  opts: SubmitStageOutputOptions = {},
): Promise<SubmitResult> {
  await acquireLockBlocking(root, opts.lockOptions ?? {});
  const origin = opts.origin ?? "workflow";
  let result: SubmitResult | undefined;
  let autoFailed: AutoFailedSubmitError | undefined;
  try {
    result = await submitUnderLock(root, runId, output, origin);
  } catch (err) {
    if (!(err instanceof AutoFailedSubmitError)) throw err; // recoverable guard: lock released in finally, propagate
    autoFailed = err;
  } finally {
    await releaseLock(root);
  }
  // AUTO-PROJECT after the lock is released (it takes no run lock); best-effort, a
  // projection-write failure does NOT fail the submit. The FAILED run is projected
  // too (so a hard-denied submit's projectionFile reflects the failure), then the
  // ORIGINAL denial is re-thrown to the caller.
  if (autoFailed !== undefined) {
    await maybeAutoProject(root, autoFailed.failedRun);
    throw autoFailed.original;
  }
  const committed = result as SubmitResult; // defined here: no autoFailed and no other throw
  await maybeAutoProject(root, committed.run);
  return committed;
}

/**
 * The under-lock body of {@link submitStageOutput} (the CALLER holds the project
 * lock). Fail-closed read ({@link RunUnavailableError} on absent/unavailable,
 * {@link RunNotActiveError} on terminal), M1 ownership check, current-stage resolve,
 * no-writes refusal, idempotency gate, then dispatch — which auto-fails + re-throws
 * an {@link AutoFailedSubmitError} on a hard denial (the wrapper the caller unwraps
 * to project the failed run post-lock).
 */
async function submitUnderLock(root: string, runId: string, output: StageOutput, origin: WorkflowArtifactOrigin): Promise<SubmitResult> {
  const read = await readRun(root, runId);
  if (read.status !== "ok") throw new RunUnavailableError(runId, read.status === "absent" ? "absent" : read.detail);
  assertRunOwnership(read.run); // M1: only the owning caller may submit a stage output
  if (isTerminalStatus(read.run.status)) throw new RunNotActiveError(runId, read.run.status);
  const { stage, projectId } = await resolveCurrentStage(root, read.run);
  // An artifact-only stage (no page/relation/lifecycle `writes` but a non-empty
  // `artifactWrites`) advances by submitting its artifact — so it is NOT write-less.
  if (stage.writes.length === 0 && (stage.artifactWrites ?? []).length === 0) throw new StageHasNoWritesError(runId, stage.id);
  assertOutputNotApplied(runId, read.run, stage);
  return dispatchOrAutoFail(root, runId, read.run, stage, output, projectId, origin);
}
