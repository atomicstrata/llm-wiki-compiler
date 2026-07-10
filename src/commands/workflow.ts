/**
 * @file src/commands/workflow.ts
 * @description Commander actions for the core `llmwiki workflow` lifecycle group:
 * `list`, `start`, `status`, `advance`, `gate approve`, `cancel`, `resume`, and
 * `submit` over a profile's declared workflows.
 *
 * Each action resolves `process.cwd()`, calls the matching core workflow
 * operation, and prints human-readable output. `list` and `status` are read-only;
 * the lifecycle ops take the project lock inside the core operation. The `adapt`
 * and `project` commands live in `./workflow-adapt.js`; the `action` discovery +
 * run commands live in `./workflow-action.js`; the shared input parsers + run
 * renderers live in `./workflow-shared.js`. The moved command functions (and the
 * `parseJsonObject` helper) are RE-EXPORTED here so `cli.ts` and the existing
 * tests keep importing them from `./commands/workflow.js` unchanged.
 *
 * Exit semantics: `list` always returns 0; `status` returns a NON-zero code when
 * ANY result carries a `problem` or is `blocked-by-config`, so a malformed or
 * unknown run is observable in scripts. `start` lets `UnknownWorkflowError` /
 * `LockBusyError` propagate to the cli.ts action wrapper (which prints + exits 1),
 * and exits 1 itself only on a malformed `--input` pair.
 */

import * as output from "../utils/output.js";
import { MAX_WORKFLOW_SUBMIT_FILE_BYTES } from "../utils/constants.js";
import { readCappedNoFollow } from "../utils/confined-read.js";
import { assertInputDepthWithinBounds, WorkflowInputBoundsError } from "../workflows/input-bounds.js";
import { listWorkflows } from "../workflows/list.js";
import { showWorkflow, type WorkflowStageDetail } from "../workflows/show.js";
import { listRunEvents } from "../workflows/run-events.js";
import { startWorkflow } from "../workflows/start.js";
import { workflowStatus } from "../workflows/status.js";
import { advanceWorkflow } from "../workflows/advance.js";
import { approveGate, resolveGateKind } from "../workflows/gate.js";
import { confirmHumanGateInteractively } from "../workflows/human-gate-confirm.js";
import { cancelWorkflow } from "../workflows/cancel.js";
import { failWorkflow } from "../workflows/fail.js";
import { resumeWorkflow } from "../workflows/resume.js";
import { submitStageOutput, type StageOutput } from "../workflows/stage-output.js";
import {
  parseInputsOrExit,
  parkedOutputMessage,
  printRunStatus,
  printRunPosition,
  isProblematic,
  processHumanGateIo,
  type WorkflowStartOptions,
} from "./workflow-shared.js";
import type { WorkflowActorKind, WorkflowRun } from "../workflows/types.js";
import type { AppendRelationInput } from "../relations/store.js";

export { parseJsonObject } from "./workflow-shared.js";
export type { WorkflowStartOptions };
export { workflowAdaptCommand, workflowProjectCommand } from "./workflow-adapt.js";
export {
  workflowActionListCommand,
  workflowActionShowCommand,
  workflowActionRunCommand,
} from "./workflow-action.js";

/**
 * The actor kinds `gate approve --actor` accepts, for fail-closed validation.
 * `human` is DELIBERATELY excluded (C1): a `human` actor is producible ONLY by the
 * interactive TTY proof, never by a self-asserted flag. The flag asserts `agent` (the
 * default for the non-interactive/agent path) or `system`.
 */
const ACTOR_KINDS: readonly WorkflowActorKind[] = ["agent", "system"];

/** The `--kind` values `workflow submit` accepts, for fail-closed validation. */
const STAGE_OUTPUT_KINDS: ReadonlySet<string> = new Set(["page", "relation", "lifecycle-transition", "artifact"]);

/** Options accepted by `workflow submit` — the union of every kind's flags. */
export interface WorkflowSubmitOptions {
  /** The output kind: `page`, `relation`, `lifecycle-transition`, or `artifact` (required). */
  kind?: string;
  /** Target entity type (for `page`/`lifecycle-transition`). */
  entityType?: string;
  /** Target artifact type (for `artifact`). */
  artifactType?: string;
  /** Target entity slug (for `page`/`lifecycle-transition`/`artifact`). */
  slug?: string;
  /** Path to the page body file (for `page`/`artifact`). */
  bodyFile?: string;
  /** Target lifecycle state (for `lifecycle-transition`). */
  toState?: string;
  /** Path to a JSON evidence file (optional, for `lifecycle-transition`). */
  evidenceFile?: string;
  /** Path to a JSON `AppendRelationInput` file (for `relation`). */
  outputFile?: string;
}

/** Options accepted by `workflow gate approve` (the approving actor's kind + label). */
export interface WorkflowGateApproveOptions {
  /**
   * The approving actor kind for a NON-human gate (`agent` default, or `system`).
   * `human` is NOT accepted as a flag value (C1) — a human gate is approved only via
   * the interactive TTY proof, never a self-asserted `--actor human`.
   */
  actor?: string;
  /** Optional human-readable label identifying the actor. */
  actorLabel?: string;
}

/**
 * Print each declared workflow and its stage ids. A project that declares no
 * workflows (e.g. the default profile) prints a clear notice. Always returns 0.
 *
 * @returns The process exit code (always 0).
 */
export async function workflowListCommand(): Promise<number> {
  const summaries = await listWorkflows(process.cwd());
  if (summaries.length === 0) {
    output.status("·", "No workflows declared.");
    return 0;
  }
  output.header("Workflows");
  for (const summary of summaries) {
    console.log(`${summary.workflowId}: ${summary.stageIds.join(", ")}`);
  }
  return 0;
}

/** Print one stage's declared contract (reads/writes/gate/previousIds). */
function printStageDetail(stage: WorkflowStageDetail): void {
  console.log(`- ${stage.id}`);
  console.log(`    reads:  ${stage.reads.join(", ") || "(none)"}`);
  console.log(`    writes: ${stage.writes.join(", ") || "(none)"}`);
  if (stage.gate !== undefined) console.log(`    gate:   ${stage.gate}`);
  if (stage.previousIds !== undefined) console.log(`    previousIds: ${stage.previousIds.join(", ")}`);
}

/**
 * Show ONE declared workflow's stages (reads/writes/gate/previousIds), its
 * `projectionFile`, and the actions targeting it. Read-only. An unknown workflow id
 * propagates `UnknownWorkflowError` to the cli.ts action wrapper (printed + exit 1).
 *
 * @param workflowId - The declared workflow to show.
 * @returns The process exit code (0; an unknown id throws).
 */
export async function workflowShowCommand(workflowId: string): Promise<number> {
  const detail = await showWorkflow(process.cwd(), workflowId);
  output.header(`Workflow ${detail.workflowId}`);
  if (detail.projectionFile !== undefined) console.log(`projectionFile: ${detail.projectionFile}`);
  if (detail.actions.length > 0) console.log(`actions: ${detail.actions.join(", ")}`);
  console.log("stages:");
  for (const stage of detail.stages) printStageDetail(stage);
  return 0;
}

/**
 * Print one run's recorded audit events, in append order — the run's `events[]`
 * audit trail (type/at/actorKind/stageId/gateId/decision/detail + state versions).
 * Read-only and fail-visible: an absent/unavailable/unknown run propagates
 * `RunUnavailableError` to the cli.ts action wrapper (printed + exit 1).
 *
 * @param runId - The run id whose audit trail to print.
 * @returns The process exit code (0; an unavailable run throws).
 */
export async function workflowEventsCommand(runId: string): Promise<number> {
  const events = await listRunEvents(process.cwd(), runId);
  output.header(`Workflow run events ${runId}`);
  if (events.length === 0) {
    output.status("·", "No events recorded.");
    return 0;
  }
  for (const event of events) {
    const scope = [event.stageId && `stage=${event.stageId}`, event.gateId && `gate=${event.gateId}`, event.decision && `decision=${event.decision}`]
      .filter(Boolean)
      .join(" ");
    console.log(`${event.at}  ${event.type}  ${event.actorKind}${scope ? `  ${scope}` : ""}  v${event.stateVersionBefore}→${event.stateVersionAfter}`);
    if (event.detail) console.log(`    ${event.detail}`);
  }
  return 0;
}

/**
 * Start a new run of the named workflow with any `--input key=value` pairs.
 * `UnknownWorkflowError` / `LockBusyError` propagate to the cli.ts action wrapper
 * (printed + exit 1). A malformed `--input` pair prints an error and exits 1.
 *
 * @param workflowId - The declared workflow to start.
 * @param options - Parsed command options (repeatable `--input`).
 */
export async function workflowStartCommand(
  workflowId: string,
  options: WorkflowStartOptions,
): Promise<void> {
  const inputs = parseInputsOrExit(options.input ?? []);
  const run = await startWorkflow(process.cwd(), workflowId, inputs);
  output.status("+", output.success(`Started run ${run.runId}`));
  console.log(`status:       ${run.status}`);
  console.log(`currentStage: ${run.currentStage ?? "(none)"}`);
}

/**
 * Print the status of one run (by id) or of all runs, classified against the
 * active profile. Returns a NON-zero exit code when ANY result carries a problem
 * or is `blocked-by-config`, so malformed/unknown runs are observable in scripts.
 *
 * @param runId - When given, report on just this run; otherwise report on all.
 * @returns 0 when every run is actionable, 1 when any has a problem / is blocked.
 */
export async function workflowStatusCommand(runId: string | undefined): Promise<number> {
  const statuses = await workflowStatus(process.cwd(), runId);
  if (statuses.length === 0) {
    output.status("·", "No workflow runs.");
    return 0;
  }
  output.header("Workflow runs");
  for (const status of statuses) printRunStatus(status);
  return statuses.some(isProblematic) ? 1 : 0;
}

/**
 * Advance an active run by one stage, printing the outcome + new position. The
 * typed lifecycle errors (`RunNotActiveError`/`RunUnavailableError`/`LockBusyError`)
 * propagate to the cli.ts action wrapper.
 *
 * @param runId - The run id to advance.
 * @returns The process exit code (always 0; failures throw).
 */
export async function workflowAdvanceCommand(runId: string): Promise<number> {
  const { run, outcome } = await advanceWorkflow(process.cwd(), runId);
  output.status("→", output.info(`outcome: ${outcome}`));
  printRunPosition(run);
  return 0;
}

/**
 * Validate the NON-human `actor` (default `"agent"`) is an accepted actor kind, or
 * print an error and exit 1. `human` is NOT an accepted flag value (C1): it is
 * producible only by the interactive proof, so passing `--actor human` is rejected
 * here and a human gate is approved via the interactive path instead.
 *
 * @param actor - The raw `--actor` value (undefined defaults to `"agent"`).
 * @returns The validated non-human actor kind (never returns on an unaccepted kind).
 */
function actorKindOrExit(actor: string | undefined): WorkflowActorKind {
  const kind = actor ?? "agent";
  if (!ACTOR_KINDS.includes(kind as WorkflowActorKind)) {
    console.error(`\x1b[31mError:\x1b[0m --actor ${JSON.stringify(kind)} cannot satisfy a gate (expected agent|system; a human gate is approved via interactive confirmation)`);
    process.exit(1);
  }
  return kind as WorkflowActorKind;
}

/**
 * Approve a `human:` gate via the INTERACTIVE TTY proof (C1), or exit 1. A human
 * gate is satisfiable ONLY by an interactive operator retyping the echoed token; a
 * non-interactive (piped/redirected) subprocess — the agent case — fails closed
 * here with NO approval. Only on a confirmed proof does this call `approveGate` with
 * the `human` actor kind.
 */
async function approveHumanGateInteractively(runId: string, gateId: string, actorLabel?: string): Promise<void> {
  const confirmed = await confirmHumanGateInteractively(gateId, processHumanGateIo());
  if (!confirmed) {
    console.error(`\x1b[31mError:\x1b[0m human gate ${JSON.stringify(gateId)} was not interactively confirmed; nothing approved`);
    process.exit(1);
  }
  const run = await approveGate(process.cwd(), runId, gateId, { actorKind: "human", actorLabel });
  output.status("+", output.success(`Approved gate ${gateId} (${run.satisfiedGates.join(", ")})`));
  console.log(`currentStage: ${run.currentStage ?? "(none)"}`);
}

/**
 * Approve a gate on a run's current stage. A `human:` gate routes through the
 * INTERACTIVE TTY proof (C1) — a non-interactive subprocess fails closed, never via
 * a self-asserted flag. A non-human gate validates the `--actor` kind (`agent`
 * default, or `system`; `human` is rejected as a flag value) and approves directly.
 * The gate errors (`GateActorMismatchError`/`UnknownGateError`/`TrustGateNotHereError`/
 * `RunNotActiveError`/`RunUnavailableError`) propagate to the cli.ts action wrapper.
 *
 * @param runId - The run id to approve a gate on.
 * @param gateId - The id of the current stage's gate to satisfy.
 * @param options - The approving actor's kind (non-human) and optional label.
 */
export async function workflowGateApproveCommand(
  runId: string,
  gateId: string,
  options: WorkflowGateApproveOptions,
): Promise<void> {
  if ((await resolveGateKind(process.cwd(), runId, gateId)) === "human") {
    return approveHumanGateInteractively(runId, gateId, options.actorLabel);
  }
  const actorKind = actorKindOrExit(options.actor);
  const run = await approveGate(process.cwd(), runId, gateId, { actorKind, actorLabel: options.actorLabel });
  output.status("+", output.success(`Approved gate ${gateId} (${run.satisfiedGates.join(", ")})`));
  console.log(`currentStage: ${run.currentStage ?? "(none)"}`);
}

/**
 * Cancel an active run (move it to terminal `cancelled`). `RunNotActiveError`/
 * `RunUnavailableError`/`LockBusyError` propagate to the cli.ts action wrapper.
 *
 * @param runId - The run id to cancel.
 */
export async function workflowCancelCommand(runId: string): Promise<void> {
  const run = await cancelWorkflow(process.cwd(), runId);
  output.status("✗", output.warn(`Cancelled run ${run.runId}`));
}

/** Options accepted by `workflow fail` (the recorded failure reason). */
export interface WorkflowFailOptions {
  /** Human-readable reason recorded on the `run-failed` event (capped). */
  detail?: string;
}

/**
 * Fail an active run (move it to terminal `failed`), recording `--detail` as the
 * reason. Owner-enforced + lock-guarded inside {@link failWorkflow}; the typed
 * errors (`RunNotActiveError`/`RunUnavailableError`/`RunOwnerMismatchError`/
 * `WorkflowFieldTooLongError`/`LockBusyError`) propagate to the cli.ts action
 * wrapper. A run made `failed` here is retryable via `workflow resume`.
 *
 * @param runId - The run id to fail.
 * @param options - The recorded failure reason (`--detail`, default empty).
 */
export async function workflowFailCommand(runId: string, options: WorkflowFailOptions): Promise<void> {
  const run = await failWorkflow(process.cwd(), runId, options.detail ?? "");
  output.status("✗", output.warn(`Failed run ${run.runId}`));
  printRunPosition(run);
}

/**
 * Resume a `failed` run (retry), or report an already-active run's position.
 * `RunNotActiveError`/`RunUnavailableError`/`LockBusyError` propagate to the
 * cli.ts action wrapper.
 *
 * @param runId - The run id to resume.
 */
export async function workflowResumeCommand(runId: string): Promise<void> {
  const run = await resumeWorkflow(process.cwd(), runId);
  output.status("→", output.info(`Resumed run ${run.runId}`));
  printRunPosition(run);
}

/**
 * Print an error and exit 1 — the shared fatal-on-bad-flag tail for `submit`'s
 * pre-core validation (bad `--kind`, missing required flag, unreadable file). All
 * exit BEFORE any core call so a malformed invocation never touches the run.
 */
function failSubmit(message: string): never {
  console.error(`\x1b[31mError:\x1b[0m ${message}`);
  process.exit(1);
}

/**
 * Read a UTF-8 submit file (`--body-file`/`--evidence-file`/`--output-file`) through
 * the shared HANDLE-BOUND capped reader, or fail the submit (exit 1).
 *
 * Reuses {@link readCappedNoFollow}: it opens `O_RDONLY | O_NOFOLLOW | O_NONBLOCK`,
 * `fstat`s the HANDLE to require a REGULAR file within
 * {@link MAX_WORKFLOW_SUBMIT_FILE_BYTES}, and reads the bytes FROM THAT SAME HANDLE.
 * This closes the prior check-then-open gap (a separate `stat` then `readFile`): a
 * planted FIFO/named pipe can no longer HANG the CLI (`O_NONBLOCK` + the regular-file
 * gate), a symlinked leaf is rejected (`O_NOFOLLOW`), and a swap between sizing and
 * reading can no longer make the read object differ from the capped one (the cap is
 * measured on the opened handle, not a separate path `stat`). A missing, symlinked,
 * non-regular, or oversize file all exit 1.
 */
async function readFileOrExit(filePath: string, label: string): Promise<string> {
  const read = await readCappedNoFollow(filePath, MAX_WORKFLOW_SUBMIT_FILE_BYTES);
  if (read.kind === "ok") return read.body;
  if (read.kind === "absent") return failSubmit(`cannot read ${label} ${JSON.stringify(filePath)}`);
  return failSubmit(
    `cannot read ${label} ${JSON.stringify(filePath)}: not a regular file, a symlink, or larger than ${MAX_WORKFLOW_SUBMIT_FILE_BYTES} bytes`,
  );
}

/**
 * Read + parse a JSON file (`--evidence-file`/`--output-file`), or fail the submit
 * (exit 1) on a read/parse/over-deep error. The parsed value is DEPTH-bounded (the
 * same R7 guard the action/MCP/`--input-json` surfaces enforce) BEFORE it is used,
 * so a deeply-nested evidence/output object cannot drive a downstream stringify into
 * stack-overflow. The raw file size is already capped by {@link readFileOrExit}.
 */
async function readJsonFileOrExit(filePath: string, label: string): Promise<unknown> {
  const text = await readFileOrExit(filePath, label);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return failSubmit(`invalid JSON in ${label} ${JSON.stringify(filePath)}`);
  }
  try {
    assertInputDepthWithinBounds(parsed as Record<string, unknown>);
  } catch (err) {
    if (err instanceof WorkflowInputBoundsError) failSubmit(`${label} ${JSON.stringify(filePath)} is too deeply nested: ${err.message}`);
    throw err;
  }
  return parsed;
}

/** Require an option, or fail the submit (exit 1) naming the missing flag. */
function requireOption(value: string | undefined, flag: string): string {
  if (value === undefined) return failSubmit(`missing required ${flag}`);
  return value;
}

/** Build a `page` output from the validated flags (reads `--body-file`). */
async function buildPageOutput(options: WorkflowSubmitOptions): Promise<StageOutput> {
  const entityType = requireOption(options.entityType, "--entity-type");
  const slug = requireOption(options.slug, "--slug");
  const body = await readFileOrExit(requireOption(options.bodyFile, "--body-file"), "--body-file");
  return { kind: "page", entityType, slug, body };
}

/** Build a `lifecycle-transition` output from the validated flags (optional `--evidence-file`). */
async function buildLifecycleOutput(options: WorkflowSubmitOptions): Promise<StageOutput> {
  const entityType = requireOption(options.entityType, "--entity-type");
  const slug = requireOption(options.slug, "--slug");
  const toState = requireOption(options.toState, "--to-state");
  const evidence = options.evidenceFile
    ? (await readJsonFileOrExit(options.evidenceFile, "--evidence-file") as Record<string, unknown>)
    : undefined;
  return { kind: "lifecycle-transition", entityType, slug, toState, evidence };
}

/** Build a `relation` output from `--output-file` (a JSON `AppendRelationInput`). */
async function buildRelationOutput(options: WorkflowSubmitOptions): Promise<StageOutput> {
  const input = await readJsonFileOrExit(requireOption(options.outputFile, "--output-file"), "--output-file");
  return { kind: "relation", input: input as AppendRelationInput };
}

/** Build an `artifact` output from the validated flags (reads `--body-file`). */
async function buildArtifactOutput(options: WorkflowSubmitOptions): Promise<StageOutput> {
  const artifactType = requireOption(options.artifactType, "--artifact-type");
  const slug = requireOption(options.slug, "--slug");
  const body = await readFileOrExit(requireOption(options.bodyFile, "--body-file"), "--body-file");
  return { kind: "artifact", artifactType, slug, body };
}

/**
 * Build the discriminated {@link StageOutput} for `--kind`, or fail the submit
 * (exit 1) on an unknown kind or a bad flag combo — all validation runs BEFORE
 * any core call.
 */
async function buildStageOutput(options: WorkflowSubmitOptions): Promise<StageOutput> {
  const kind = requireOption(options.kind, "--kind");
  if (!STAGE_OUTPUT_KINDS.has(kind)) failSubmit(`unknown --kind ${JSON.stringify(kind)} (expected page|relation|lifecycle-transition|artifact)`);
  if (kind === "page") return buildPageOutput(options);
  if (kind === "lifecycle-transition") return buildLifecycleOutput(options);
  if (kind === "artifact") return buildArtifactOutput(options);
  return buildRelationOutput(options);
}

/**
 * Submit a typed stage output (`page`/`relation`/`lifecycle-transition`) for the
 * run's current write-declaring stage. Bad flags / unreadable files fail with
 * exit 1 BEFORE any core call; the typed scope/denial/lifecycle errors from
 * `submitStageOutput` propagate to the cli.ts action wrapper (printed + exit 1).
 *
 * @param runId - The run id to submit against.
 * @param options - The submit flags (validated per `--kind`).
 */
export async function workflowSubmitCommand(runId: string, options: WorkflowSubmitOptions): Promise<void> {
  const stageOutput = await buildStageOutput(options);
  const { applied, decision } = await submitStageOutput(process.cwd(), runId, stageOutput);
  if (applied) {
    output.status("+", output.success(`applied (${stageOutput.kind}, decision: ${decision})`));
    return;
  }
  // HONESTY: a non-applied workflow output is PARKED — the run event records the
  // decision, but NO `.llmwiki/candidates` review item exists on this path, so
  // `review list`/`approve` cannot see it. The message branches on WHY it parked
  // (a trust-downgrade the grant lifts vs. a planner block it does not), so a
  // quarantined output is never told to "set LLMWIKI_TRUSTED_WRITE to apply".
  output.status("·", output.info(parkedOutputMessage(stageOutput.kind, decision)));
}
