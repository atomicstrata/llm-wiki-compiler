/**
 * Workflow-only SDK contract, composed by the standard distribution.
 * Core consumers do not depend on these execution methods.
 */
import type { ActionSummary, ActionDetail, WorkflowSummary, WorkflowDetail,
  AdaptationPlan, AdvanceResult, StageOutput, SubmitResult, ActionRunResult } from "@atomicstrata/llmwiki-local-workflows";
import type { WorkflowRun, WorkflowActorKind, WorkflowEvent, ProjectionResult } from "@atomicstrata/llmwiki-core/local-workflow-contracts";
import type { RunStatus } from "../workflows/status.js";

export interface WikiWorkflow {
  /**
   * @experimental
   * List the workflow ACTIONS declared in the active profile (id, label,
   * workflow, operation), sorted by id. A default-profile project (which declares
   * no actions) yields an empty array. Read-only; no LLM required.
   *
   * Foundation API — the shape may change in a future minor release.
   */
  listActions(): Promise<ActionSummary[]>;
  /**
   * @experimental
   * Show one declared workflow action with its EFFECTIVE permission per surface
   * (`min(profile request, local grant, surface hard cap)`) — so an `mcp` request
   * for `trusted-write` surfaces as `staged-write`. Resolves the id by an
   * OWN-property check; an undeclared id throws `UnknownActionError`. Read-only;
   * no LLM required.
   *
   * Foundation API — the shape may change in a future minor release.
   */
  showAction(actionId: string): Promise<ActionDetail>;
  /**
   * @experimental
   * List the workflows declared in the active profile, each with its stage ids
   * (in declared order). A default-profile project (which declares no workflows)
   * yields an empty array. Read-only; no LLM required.
   *
   * Foundation API — the shape may change in a future minor release.
   */
  listWorkflows(): Promise<WorkflowSummary[]>;
  /**
   * @experimental
   * Show ONE declared workflow's full detail: each stage's
   * `reads`/`writes`/`gate`/`previousIds`, the workflow's `projectionFile`, and the
   * ids of declared actions that target it. Resolves the id by an OWN-property
   * check; an undeclared id throws `UnknownWorkflowError`. Read-only; no LLM required.
   *
   * Foundation API — the shape may change in a future minor release.
   */
  showWorkflow(workflowId: string): Promise<WorkflowDetail>;
  /**
   * @experimental
   * List one run's recorded audit `events[]`, in append order (the genesis
   * `workflow-start`, each `stage-advanced`/`gate-approved`/`stage-output`/…, with
   * actor + stage/gate/decision/detail + state versions). Read-only and
   * fail-visible: an absent/unavailable/unknown run throws `RunUnavailableError`
   * rather than an empty list. No LLM required.
   *
   * Foundation API — the shape may change in a future minor release.
   */
  listRunEvents(runId: string): Promise<WorkflowEvent[]>;
  /**
   * @experimental
   * Start a new run of a declared workflow, recording any caller `inputs`
   * (default `{}`). Mints + persists a `pending` run under the project lock;
   * performs NO stage execution, gate evaluation, or wiki write. Throws
   * `UnknownWorkflowError` when the id is not declared and `LockBusyError` when
   * the project is locked — nothing is written in either case. No LLM required.
   *
   * Foundation API — the shape may change in a future minor release.
   */
  startWorkflow(workflowId: string, inputs?: Record<string, unknown>): Promise<WorkflowRun>;
  /**
   * @experimental
   * Report the status of one run (by id) or of all runs, classified against the
   * active profile (`current` / `historical` / `needs-adaptation` /
   * `blocked-by-config`). Read-only and fail-closed: a malformed or unknown run
   * is surfaced as a `problem`, never thrown. No LLM required.
   *
   * Foundation API — the shape may change in a future minor release.
   */
  workflowStatus(runId?: string): Promise<RunStatus[]>;
  /**
   * @experimental
   * Advance an active run by one stage. Clears the current stage and steps to the
   * next (`outcome:"advanced"`), finishes the run (`"completed"`), parks an
   * unsatisfied `human:`/`agent:` gate (`"awaiting-gate"`), or parks a
   * write-declaring / `trust:`-gated stage awaiting a `submitStageOutput`
   * (`"awaiting-output"`). A terminal run throws `RunNotActiveError`. Runs under
   * the project lock; no wiki write. No LLM required.
   *
   * Foundation API — the shape may change in a future minor release.
   */
  advanceWorkflow(runId: string): Promise<AdvanceResult>;
  /**
   * @experimental
   * Approve a `human:`/`agent:` gate on the run's current stage. Enforces the
   * security rule that an `agent` actor can never satisfy a `human:` gate
   * (`GateActorMismatchError`); rejects an unknown gate (`UnknownGateError`), a
   * `trust:` gate (`TrustGateNotHereError`), and a terminal run
   * (`RunNotActiveError`). Idempotent for an already-satisfied gate. Runs under
   * the project lock. No LLM required.
   *
   * Foundation API — the shape may change in a future minor release.
   */
  approveGate(
    runId: string,
    gateId: string,
    opts: { actorKind: WorkflowActorKind; actorLabel?: string },
  ): Promise<WorkflowRun>;
  /**
   * @experimental
   * Cancel an active run (move it to terminal `cancelled`). A terminal run throws
   * `RunNotActiveError`. Runs under the project lock. No LLM required.
   *
   * Foundation API — the shape may change in a future minor release.
   */
  cancelWorkflow(runId: string): Promise<WorkflowRun>;
  /**
   * @experimental
   * Fail an active run (move it to terminal `failed`), recording `detail` as the
   * reason on the `run-failed` event. Owner-enforced + lock-guarded; a terminal
   * run throws `RunNotActiveError` and an over-long `detail` throws
   * `WorkflowFieldTooLongError`. A run failed here is retryable via `resumeWorkflow`.
   * No LLM required.
   *
   * Foundation API — the shape may change in a future minor release.
   */
  failWorkflow(runId: string, detail: string): Promise<WorkflowRun>;
  /**
   * @experimental
   * Resume a `failed` run (retry → `running`), or return an already-active run
   * unchanged as a position report. A `completed`/`cancelled` run throws
   * `RunNotActiveError`. Runs under the project lock. No LLM required.
   *
   * Foundation API — the shape may change in a future minor release.
   */
  resumeWorkflow(runId: string): Promise<WorkflowRun>;
  /**
   * @experimental
   * Submit a typed output (`page`, `relation`, `lifecycle-transition`,
   * `artifact`, or declarative `human-input`) to a
   * run's current write-declaring stage, routing the write through the
   * scope-gated planner→executor seam under the project lock. A stage may write
   * ONLY the entity types it declares (`StageWriteScopeError` otherwise). An
   * `allow`/`allow-with-warning` lands the write live (`applied:true`) and
   * satisfies a `trust:` gate; a blocked page write stages for review
   * (`applied:false`); a `deny` / relation / lifecycle denial throws. Rejects a
   * no-output stage (`StageHasNoWritesError`) and a terminal/absent run
   * (`RunNotActiveError`/`RunUnavailableError`). No LLM required.
   *
   * Foundation API — the shape may change in a future minor release.
   */
  submitStageOutput(runId: string, output: StageOutput): Promise<SubmitResult>;
  /**
   * @experimental
   * Run a declared workflow action under the COMPOSED authority on the fixed
   * `sdk` surface (`min(profile request, local grant, sdk hard cap)`) — the
   * surface is NOT caller-overridable, so a caller cannot claim a higher-cap
   * surface. Validates `inputs` (default `{}`) against the action's
   * `inputSchema`, enforces the operation's required capability, then dispatches
   * to the existing run-lifecycle op. Throws `UnknownActionError` (undeclared
   * id), `ActionInputError` (input-schema violation), or `ActionDeniedError`
   * (effective permission cannot satisfy the op) — nothing is written in any of
   * those cases. No LLM required.
   *
   * Foundation API — the shape may change in a future minor release.
   */
  runAction(actionId: string, inputs?: Record<string, unknown>): Promise<ActionRunResult>;
  /**
   * @experimental
   * Preview the adaptation plan(s) for one run (by id) or every readable run when
   * the workflow definition has changed — READ-ONLY (no lock, no write). Each plan
   * reports the old→new digest, the per-stage old→new mapping, any unmappable
   * stage ids, and a `lossless` flag. A named-but-unreadable run / unresolvable id
   * / unavailable store throws (a named run never vanishes as `[]`). No LLM required.
   *
   * Foundation API — the shape may change in a future minor release.
   */
  adaptDryRun(runId?: string): Promise<AdaptationPlan[]>;
  /**
   * @experimental
   * Re-anchor a run to the active workflow def under the project lock. A LOSSLESS
   * adapt remaps the current stage + stage log and re-anchors the digest, so the
   * run then classifies `current`. A LOSSY adapt (an unmappable stage the run
   * references) fails closed unless `confirm` — leaving the run byte-unchanged;
   * with `confirm`, a confirmed unmappable current stage CANCELS the run, the drop
   * recorded on a `workflow-adapted` event. Throws `AlreadyCurrentError` (no-op),
   * `UnknownWorkflowError` (workflow removed), `AdaptationRequiresConfirmError`
   * (lossy + unconfirmed), `RunUnavailableError`/`LockBusyError`. No LLM required.
   *
   * Foundation API — the shape may change in a future minor release.
   */
  adaptWorkflowRun(runId: string, opts?: { confirm?: boolean }): Promise<WorkflowRun>;
  /**
   * @experimental
   * Write a run's DERIVED markdown projection to its workflow's declared
   * `projectionFile` under `wiki/`. The projection is computed FROM the run JSON
   * and is a one-way `wiki/` OUTPUT — editing it never affects run state. Returns
   * `written` with the project-relative path, `no-target` when the workflow
   * declares no `projectionFile`, or `unavailable` (fail-visible) when the run is
   * absent/unreadable or the path escapes `wiki/`. Takes NO run lock; no run
   * mutation. No LLM required.
   *
   * Foundation API — the shape may change in a future minor release.
   */
  projectWorkflowRun(runId: string): Promise<ProjectionResult>;
}
