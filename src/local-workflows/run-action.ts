/**
 * @file src/local-workflows/run-action.ts
 * @description `runAction` — execute a declarative workflow action UNDER the
 * composed authority, then dispatch to the existing run-lifecycle op.
 *
 * This is the SECURITY-CRITICAL execution core. It adds NO new write path: every
 * mutation flows through an EXISTING op ({@link startWorkflow} / {@link
 * resumeWorkflow} / {@link advanceWorkflow} / {@link cancelWorkflow} / {@link
 * approveGate} / {@link workflowStatus}), each of which keeps its own project
 * lock and Trust Guard. `runAction` only (1) validates inputs against the action's
 * `inputSchema` (PURE, fail-closed), (2) composes the EFFECTIVE permission =
 * `min(profile request, local grant, surface cap)`, (3) ENFORCES the operation's
 * required capability against that effective permission — RANKED on the ordinal
 * {@link CAPABILITY_ORDER}, never string-compared — and (4) dispatches.
 *
 * The op→capability contract enforced here:
 *  - `status`  → read-only
 *  - `start` / `resume` / `advance` / `cancel` → staged-write
 *  - `gate` (human) → cli surface ONLY, operator-enabled, AND the INTERACTIVE TTY
 *    proof (the same one the direct `gate approve` uses) — never satisfiable on a
 *    PROGRAMMATIC surface (sdk/mcp/viewer)
 *  - `gate` (agent) → staged-write
 *
 * A `disabled` effective permission denies EVERY operation. An effective permission
 * below the required rank is refused with {@link ActionDeniedError} BEFORE any op
 * runs. A `human:` gate is denied here on any non-cli surface, and at dispatch unless
 * the interactive proof passes — so there is EXACTLY ONE way to satisfy a human gate
 * (an interactive cli confirmation), whether reached via `gate approve` or `action
 * run`. The action surface never calls `approveGate(actorKind:"human")` without it.
 *
 * On top of authority, a MUTATING runId-bearing op (resume/advance/cancel/gate)
 * enforces run OWNERSHIP (M1) via the SHARED {@link assertRunOwnership} — the same
 * guard the direct ops run under their lock — so caller B cannot mutate caller A's run
 * on ANY surface. A read-only by-id `status` is NOT owner-gated (cross-owner reads are
 * permitted observability).
 */

import type { LocalWorkflowHost } from "@atomicstrata/llmwiki-core/local-workflow-contracts";
import { actionLabelForPresentation } from "@atomicstrata/llmwiki-core/local-workflow-contracts";
import { effectivePermission, canSatisfyHumanGate, CAPABILITY_ORDER } from "@atomicstrata/llmwiki-core/local-workflow-contracts";
import { validateActionInputs } from "./action-input.js";
import { parseGate } from "@atomicstrata/llmwiki-core/local-workflow-contracts";
import { lookupAction } from "./actions.js";
import { ActionDeniedError, ActionInputError, ActionRunWorkflowMismatchError, RunUnavailableError } from "./errors.js";
import { assertRunOwnership } from "./with-lock.js";
import { captureActionInputValues } from "./action-input-snapshot.js";
import {
  nonInteractiveHumanGateIo,
  type HumanGateIo,
} from "@atomicstrata/llmwiki-core/local-workflow-contracts";
import { startWorkflowWithHost } from "./start-operation.js";
import { resumeWorkflowWithHost } from "./resume.js";
import { advanceWorkflowWithHost } from "./advance.js";
import { cancelWorkflowWithHost } from "./cancel.js";
import { failWorkflowWithHost } from "./fail.js";
import { approveGateWithHost, resolveGateChallengeWithHost } from "./gate.js";
import { submitStageOutputWithHost } from "./stage-output.js";
import { buildActionStageOutput } from "./action-stage-output.js";
import type { WorkflowArtifactOrigin } from "./artifact-output.js";
import type { CapabilityClass, ActionSurface, WorkflowActionDef } from "@atomicstrata/llmwiki-core/local-workflow-contracts";
import type { WorkflowRun } from "@atomicstrata/llmwiki-core/local-workflow-contracts";

/** The capability a non-`gate` operation requires (`gate` is enforced specially). */
const REQUIRED_CAPABILITY: Record<"status" | "start" | "resume" | "advance" | "cancel" | "fail" | "submit", CapabilityClass> = {
  status: "read-only",
  start: "staged-write",
  resume: "staged-write",
  advance: "staged-write",
  cancel: "staged-write",
  fail: "staged-write",
  submit: "staged-write",
};

/** The result of executing a workflow action under the composed authority. */
export interface ActionRunResult {
  /** The declared action id that was executed. */
  actionId: string;
  /** The workflow operation the action resolved to. */
  operation: string;
  /** The COMPOSED effective permission the action ran under. */
  effectivePermission: CapabilityClass;
  /** The underlying run-lifecycle op's result. */
  result: unknown;
}

/** Ordinal rank of a capability on {@link CAPABILITY_ORDER} (never string-compare). */
function rank(c: CapabilityClass): number {
  return CAPABILITY_ORDER.indexOf(c);
}

/** True when `effective` ranks at or above `required` on the capability ordinal. */
function meetsCapability(effective: CapabilityClass, required: CapabilityClass): boolean {
  return rank(effective) >= rank(required);
}

/** Resolve a non-`start`/non-optional run id from normalized inputs, failing closed. */
function requireRunId(def: WorkflowActionDef, normalized: Record<string, unknown>): string {
  const runId = normalized.runId;
  if (typeof runId !== "string") {
    throw new ActionInputError(def.label, `operation '${def.operation}' requires a string 'runId' input`);
  }
  return runId;
}

/**
 * Enforce the action's DECLARED workflow scope on a runId-bearing op: the target
 * run's stored `workflowId` MUST equal `def.workflow`. The op grants authority on
 * the action's OWN workflow, but the `runId` is caller-supplied, so a
 * `build`-scoped action handed a `secret` run must be refused BEFORE dispatch.
 *
 * A run's `workflowId` is IMMUTABLE after creation, so this unlocked pre-read is
 * sound even though the op re-reads under its own lock (no TOCTOU on an immutable
 * field). FAILS CLOSED on a non-readable target: an `absent`/`unavailable` run
 * cannot be scope-verified, so the op is refused ({@link RunUnavailableError})
 * rather than dispatched. Only a readable, in-scope run proceeds.
 *
 * @throws {ActionRunWorkflowMismatchError} When the run belongs to another workflow.
 * @throws {RunUnavailableError} When the target run is absent or unreadable.
 * @returns The readable, in-scope run (so the caller can enforce ownership on it).
 */
async function assertRunInScope(host: LocalWorkflowHost, root: string, def: WorkflowActionDef, runId: string): Promise<WorkflowRun> {
  const read = await host.history.read(root, runId);
  if (read.status === "absent") throw new RunUnavailableError(runId, "absent");
  if (read.status === "unavailable") throw new RunUnavailableError(runId, read.detail);
  if (read.run.workflowId !== def.workflow) {
    throw new ActionRunWorkflowMismatchError(def.label, def.workflow, read.run.workflowId);
  }
  return read.run;
}

/** The deny-with-`ActionDeniedError` closure shared by the authority checks. */
type DenyFn = (reason: string) => never;

/**
 * Enforce the STATIC authority for a `gate` action (the dynamic interactive proof is
 * applied later, at dispatch). A `human:` gate is satisfiable ONLY on the `cli`
 * surface AND when operator-enabled — so sdk/mcp/viewer (every PROGRAMMATIC surface)
 * deny here, BEFORE any IO. An `agent:` gate demands staged-write. A malformed gate
 * denies. Throws via `deny` fail-closed.
 */
async function enforceGateAuthority(host: LocalWorkflowHost, root: string, def: WorkflowActionDef, effective: CapabilityClass, surface: ActionSurface, deny: DenyFn): Promise<void> {
  const parsed = def.gate === undefined ? null : parseGate(def.gate);
  if (parsed === null) return void deny("malformed gate");
  if (parsed.kind !== "human") {
    if (!meetsCapability(effective, "staged-write")) deny("agent gate requires staged-write");
    return;
  }
  if (surface !== "cli") deny("a human gate is satisfiable only via interactive cli confirmation");
  const enabled = await host.authority.humanGateEnabled(root, def.gate as string);
  if (!canSatisfyHumanGate(effective, surface, true, enabled)) deny("human gate not satisfiable");
}

/**
 * Enforce the COMPOSED authority for one action invocation. A `disabled` effective
 * permission denies everything. A `gate` operation routes through
 * {@link enforceGateAuthority}; every other operation demands its
 * {@link REQUIRED_CAPABILITY}. Throws {@link ActionDeniedError} fail-closed.
 */
async function enforceAuthority(host: LocalWorkflowHost, root: string, def: WorkflowActionDef, effective: CapabilityClass, surface: ActionSurface): Promise<void> {
  const deny: DenyFn = (reason) => {
    throw new ActionDeniedError(def.label, surface, reason);
  };
  if (effective === "disabled") deny("disabled");
  if (def.operation === "gate") return enforceGateAuthority(host, root, def, effective, surface, deny);
  if (!meetsCapability(effective, REQUIRED_CAPABILITY[def.operation])) deny(`requires ${REQUIRED_CAPABILITY[def.operation]}`);
}

/**
 * Dispatch a `gate` action to {@link approveGate}. An `agent:` gate approves with an
 * `agent` actor. A `human:` gate routes through the SAME interactive TTY proof as the
 * direct `gate approve` command ({@link confirmHumanGateInteractively}) — the ONLY way
 * to produce a `human` actor — and is DENIED fail-closed when the proof does not pass
 * (a non-interactive/piped invocation, or a non-cli surface whose default IO is
 * {@link nonInteractiveHumanGateIo}). So `action run` can NEVER satisfy a human gate
 * non-interactively, on any surface. The target `runId` is SCOPE- and OWNER-checked
 * ({@link scopedRunId}).
 */
async function dispatchGate(host: LocalWorkflowHost, root: string, def: WorkflowActionDef, normalized: Record<string, unknown>, io: HumanGateIo): Promise<unknown> {
  const parsed = parseGate(def.gate as string);
  if (parsed === null) throw new ActionDeniedError(def.label, "cli", "malformed gate");
  const runId = await scopedRunId(host, root, def, normalized, true);
  if (parsed.kind === "human") {
    if (!io.stdinIsTty || !io.stdoutIsTty) {
      await host.terminal.confirmHumanGate(parsed.id, io);
      throw new ActionDeniedError(def.label, "cli", "human gate not interactively confirmed");
    }
    const challenge = await resolveGateChallengeWithHost(host, root, runId, parsed.id);
    if (!(await host.terminal.confirmHumanGate(parsed.id, io, challenge.subjectDigest))) {
      throw new ActionDeniedError(def.label, "cli", "human gate not interactively confirmed");
    }
    return approveGateWithHost(host, root, runId, parsed.id, {
      actorKind: "human", expectedSubjectDigest: challenge.subjectDigest,
    });
  }
  return approveGateWithHost(host, root, runId, parsed.id, { actorKind: "agent" });
}

/**
 * Resolve a runId-bearing op's `runId`, enforce the action's declared workflow scope
 * ({@link assertRunInScope}), and — for a MUTATING op (`enforceOwner`) — enforce run
 * OWNERSHIP ({@link assertRunOwnership}) BEFORE dispatch. Centralizes the
 * require-then-scope(-then-owner) check so `resume`/`advance`/`cancel`/`gate` cannot
 * skip either guard. The read-only by-id `status` passes `enforceOwner=false` (a
 * cross-owner READ is permitted observability; only MUTATIONS are owner-gated).
 */
async function scopedRunId(
  host: LocalWorkflowHost,
  root: string,
  def: WorkflowActionDef,
  normalized: Record<string, unknown>,
  enforceOwner: boolean,
): Promise<string> {
  const runId = requireRunId(def, normalized);
  const run = await assertRunInScope(host, root, def, runId);
  if (enforceOwner) assertRunOwnership(run);
  return runId;
}

/**
 * The `status` op under the action's workflow scope. A by-id status is
 * scope-checked like any runId-bearing op (a cross-workflow id is refused). A
 * no-runId status reports on ALL runs but is object-scope-FILTERED via
 * {@link workflowStatusForWorkflow} to this workflow's READABLE runs — while
 * PRESERVING every fail-visible problem row (a store-unavailable/escape row, or a
 * malformed run whose workflow can't be determined), so a `build`-scoped status
 * action surfaces only `build` runs yet still reports a broken store rather than
 * reading it as a clean empty.
 */
async function dispatchStatus(host: LocalWorkflowHost, root: string, def: WorkflowActionDef, normalized: Record<string, unknown>): Promise<unknown> {
  if (typeof normalized.runId === "string") {
    return host.history.status(root, await scopedRunId(host, root, def, normalized, false));
  }
  return host.history.statusForWorkflow(root, def.workflow);
}

/** The `detail` input for a `fail` op (a non-string/absent input → empty reason). */
function failDetail(normalized: Record<string, unknown>): string {
  return typeof normalized.detail === "string" ? normalized.detail : "";
}

/**
 * The harness-stamped artifact origin for a submit action, DERIVED FROM the invoking
 * `surface` — never a caller input. An MCP-triggered action is attributed distinctly
 * as `"workflow-mcp"`; every other surface (cli/sdk) stamps `"workflow"` (F2
 * granularity). Because it is set from the surface param the MCP tool HARDCODES
 * (`src/mcp/workflow-action-tools.ts`), an adversary can never spoof it to cli/sdk.
 *
 * @param surface - The surface the action is invoked through.
 * @returns The provenance origin to stamp on the artifact write.
 */
function artifactOriginForSurface(surface: ActionSurface): WorkflowArtifactOrigin {
  return surface === "mcp" ? "workflow-mcp" : "workflow";
}

/** Carry a declared start workspace into the product-process start seam. */
function startProcessOptions(normalized: Record<string, unknown>): { workspaceId?: string } {
  return typeof normalized.workspaceId === "string" ? { workspaceId: normalized.workspaceId } : {};
}

/**
 * Dispatch the action to its EXISTING run-lifecycle op. `start` mints a run from
 * the normalized inputs; `resume`/`advance`/`cancel`/`fail`/`gate` act on the inputs'
 * `runId` — each SCOPE-CHECKED ({@link scopedRunId}) so the caller-supplied target
 * must belong to `def.workflow` AND OWNER-checked (the run is mutating); `status`
 * reports on an OPTIONAL `runId` (absent → all runs, filtered to `def.workflow`).
 * `fail` records the action's `detail` input (default empty) on the `run-failed`
 * event. Adds no privileged write — each op keeps its own lock and Trust Guard.
 */
async function dispatchOperation(host: LocalWorkflowHost, root: string, def: WorkflowActionDef, normalized: Record<string, unknown>, io: HumanGateIo, surface: ActionSurface): Promise<unknown> {
  switch (def.operation) {
    case "start":
      return startWorkflowWithHost(host, {
        root, workflowId: def.workflow, inputs: normalized, processOptions: startProcessOptions(normalized),
      });
    case "resume":
      return resumeWorkflowWithHost(host, root, await scopedRunId(host, root, def, normalized, true));
    case "advance":
      return advanceWorkflowWithHost(host, root, await scopedRunId(host, root, def, normalized, true));
    case "cancel":
      return cancelWorkflowWithHost(host, root, await scopedRunId(host, root, def, normalized, true));
    case "fail":
      return failWorkflowWithHost(host, root, await scopedRunId(host, root, def, normalized, true), failDetail(normalized));
    case "gate":
      return dispatchGate(host, root, def, normalized, io);
    case "submit":
      return submitStageOutputWithHost(host, root, await scopedRunId(host, root, def, normalized, true), buildActionStageOutput(def, normalized), { origin: artifactOriginForSurface(surface) });
    case "status":
      return dispatchStatus(host, root, def, normalized);
  }
}

/** Execute the original action authority and dispatch protocol against one supplied compiler host. */
export async function runActionWithHost(host: LocalWorkflowHost, root: string, actionId: string,
  inputs: Record<string, unknown>, surface: ActionSurface,
  humanGateIo: HumanGateIo = nonInteractiveHumanGateIo()): Promise<ActionRunResult> {
  const captured = captureActionInputValues(actionId, inputs);
  const { profile } = await host.profiles.load(root);
  const declared = lookupAction(profile, actionId);
  const def = { ...declared, label: actionLabelForPresentation(profile, declared.label) };
  const normalized = validateActionInputs(declared, captured);
  const effective = effectivePermission(def.permissions[surface], await host.authority.localGrant(root, surface), surface);
  await enforceAuthority(host, root, def, effective, surface);
  const result = await dispatchOperation(host, root, def, normalized, humanGateIo, surface);
  return { actionId, operation: def.operation, effectivePermission: effective, result };
}
