/**
 * @file src/commands/workflow-action.ts
 * @description Commander actions for the `llmwiki workflow action` subgroup:
 * `list`, `show`, and `run` over a profile's declared workflow ACTIONS.
 *
 * `list`/`show` are read-only discovery (`show` surfaces the effective permission
 * per surface so an operator sees the clamps). `run` dispatches a declared action
 * under the COMPOSED authority on the fixed `cli` surface, merging string
 * `--input key=value` pairs with a typed `--input-json` object. Extracted from
 * `workflow.ts` (pure split, no behavior change) to keep each module under the
 * file-size budget.
 */

import * as output from "../utils/output.js";
import { listActions, showAction, type ActionDetail } from "../workflows/actions.js";
import { runAction, type ActionRunResult } from "../workflows/run-action.js";
import type { RunStatus } from "../workflows/status.js";
import {
  parseInputsOrExit,
  parseInputJsonOrExit,
  printRunStatus,
  isProblematic,
  processHumanGateIo,
  type WorkflowStartOptions,
} from "./workflow-shared.js";

/**
 * Options accepted by `workflow action run`: the repeatable string `--input
 * key=value` (every value a STRING) PLUS an optional `--input-json` carrying a
 * JSON OBJECT of TYPED inputs (`number`/`boolean`/`string[]`/`string`). The two
 * are merged with JSON values taking precedence, so an action whose `inputSchema`
 * declares a non-string type is usable from the CLI.
 */
export interface WorkflowActionRunOptions extends WorkflowStartOptions {
  /** A JSON object of typed inputs, merged over the string `--input` values. */
  inputJson?: string;
}

/**
 * Print each declared workflow action (id, label, workflow, operation). A project
 * that declares no actions (e.g. the default profile) prints a clear notice.
 * Read-only; always returns 0.
 *
 * @returns The process exit code (always 0).
 */
export async function workflowActionListCommand(): Promise<number> {
  const actions = await listActions(process.cwd());
  if (actions.length === 0) {
    output.status("·", "No workflow actions declared.");
    return 0;
  }
  output.header("Workflow actions");
  for (const action of actions) {
    console.log(`${action.actionId}: ${action.label}  (${action.workflow}/${action.operation})`);
  }
  return 0;
}

/** The minimal run-shaped fields an action result may carry, for rendering. */
interface RunLike {
  runId?: unknown;
  status?: unknown;
}

/** Render a single minted/acted-on run line (`run <id> (<status>)`), or null when not run-shaped. */
function renderRunLine(run: RunLike): string | null {
  if (typeof run.runId !== "string") return null;
  const status = typeof run.status === "string" ? ` (${run.status})` : "";
  return `run ${run.runId}${status}`;
}

/** A short, human-readable rendering of one action's underlying op result. */
function renderActionResult(result: unknown): string {
  if (Array.isArray(result)) return `${result.length} run(s)`;
  const line = result === null ? null : renderRunLine(result as RunLike);
  return line ?? "ok";
}

/**
 * Collect an `action run` invocation's inputs: the string `--input key=value`
 * pairs (every value a STRING) MERGED with the typed `--input-json` object, with
 * the JSON values taking PRECEDENCE on a key collision. Both bad-input branches
 * (malformed pair / malformed json) exit 1 BEFORE any core call.
 *
 * @param options - The parsed `action run` options.
 * @returns The merged inputs record passed to {@link runAction}.
 */
function collectActionInputs(options: WorkflowActionRunOptions): Record<string, unknown> {
  const stringInputs = parseInputsOrExit(options.input ?? []);
  const jsonInputs = parseInputJsonOrExit(options.inputJson);
  return { ...stringInputs, ...jsonInputs };
}

/**
 * For a `status` action, print each classified run row and EXIT NONZERO when any
 * carries a problem or is `blocked-by-config` — mirroring `workflowStatusCommand`,
 * so an unavailable/health-failing store surfaced through the action wrapper exits
 * 1 (not 0 / "0 run(s)"). A clean status falls through to the normal one-line
 * render. Non-`status` operations are untouched.
 */
function renderStatusOrExit(run: ActionRunResult): void {
  if (run.operation !== "status") return;
  const statuses = run.result as RunStatus[];
  for (const status of statuses) printRunStatus(status);
  if (statuses.some(isProblematic)) process.exit(1);
}

/**
 * Run a declared workflow action under the COMPOSED authority on the fixed `cli`
 * surface (a caller cannot claim a higher-cap surface). Collects inputs from the
 * string `--input key=value` pairs AND the typed `--input-json` object (json wins
 * on a collision; both bad-input branches exit 1 BEFORE the core), then dispatches
 * via {@link runAction}. A `status` action whose result carries a problem (an
 * unavailable store / blocked-by-config) prints the rows and EXITS NONZERO,
 * mirroring `workflow status`. A `human:`-gate action goes through the SAME
 * interactive TTY proof as `gate approve` ({@link processHumanGateIo}), so a piped
 * `action run` cannot satisfy a human gate. The typed errors (`ActionDeniedError`/
 * `ActionInputError`/`UnknownActionError`) propagate to the cli.ts action wrapper
 * (printed + exit 1).
 *
 * @param actionId - The declared action id to run.
 * @param options - Parsed command options (`--input` pairs + `--input-json`).
 */
export async function workflowActionRunCommand(
  actionId: string,
  options: WorkflowActionRunOptions,
): Promise<void> {
  const inputs = collectActionInputs(options);
  const run: ActionRunResult = await runAction(process.cwd(), actionId, inputs, "cli", processHumanGateIo());
  output.status("+", output.success(`Ran action ${run.actionId}`));
  console.log(`operation:   ${run.operation}`);
  console.log(`permission:  ${run.effectivePermission}`);
  console.log(`result:      ${renderActionResult(run.result)}`);
  renderStatusOrExit(run);
}

/** Print the effective permission per surface (so an operator sees the clamps). */
function printEffectivePermissions(detail: ActionDetail): void {
  console.log("effective permissions:");
  for (const [surface, capability] of Object.entries(detail.effectivePermissions)) {
    console.log(`  ${surface}: ${capability}`);
  }
}

/**
 * Show one declared workflow action, INCLUDING its effective permission per
 * surface — so an operator sees, e.g., that an `mcp` request for `trusted-write`
 * is effectively `staged-write`. Read-only; `UnknownActionError` propagates to the
 * cli.ts action wrapper (printed + exit 1).
 *
 * @param actionId - The declared action id to show.
 * @returns The process exit code (always 0; an unknown id throws).
 */
export async function workflowActionShowCommand(actionId: string): Promise<number> {
  const detail = await showAction(process.cwd(), actionId);
  output.header(`Workflow action ${detail.actionId}`);
  console.log(`label:     ${detail.label}`);
  console.log(`workflow:  ${detail.workflow}`);
  console.log(`operation: ${detail.operation}`);
  if (detail.gate !== undefined) console.log(`gate:      ${detail.gate}`);
  if (detail.trustGate !== undefined) console.log(`trustGate: ${detail.trustGate}`);
  printEffectivePermissions(detail);
  return 0;
}
