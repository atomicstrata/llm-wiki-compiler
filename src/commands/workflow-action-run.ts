/**
 * @file src/commands/workflow-action-run.ts
 * @description Commander action for `llmwiki workflow action run`: dispatch a
 * declared workflow action under the COMPOSED authority on the fixed `cli`
 * surface, merging string `--input key=value` pairs with a typed `--input-json`
 * object. Split from `./workflow-action.js` (no behavior change) so the
 * read-only discovery commands do not load the run path.
 */

import * as output from "@atomicstrata/llmwiki-core/modules/utils/output";
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
