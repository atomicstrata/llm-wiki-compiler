/**
 * @file src/commands/workflow-shared.ts
 * @description Shared helpers for the `llmwiki workflow` command group.
 *
 * These are the pure input parsers and run-rendering helpers used across more
 * than one of the workflow command modules (`workflow.ts`, `workflow-action.ts`,
 * `workflow-adapt.ts`): the `--input key=value` / `--input-json` parsers, the
 * classified run-status line printer + its problem predicate, and the small
 * run-position printer. Factored here so the command modules stay focused and the
 * shared logic lives in exactly one place (no duplication, no behavior change).
 */

import { createInterface } from "node:readline";
import * as output from "../utils/output.js";
import { assertRawInputJsonWithinBounds, assertInputDepthWithinBounds } from "../workflows/input-bounds.js";
import type { RunStatus } from "../workflows/status.js";
import type { WorkflowRun } from "../workflows/types.js";
import type { TrustDecision } from "../trust/decision.js";
import type { HumanGateIo } from "../workflows/human-gate-confirm.js";

/** Options carrying repeatable `--input key=value` strings (one per occurrence). */
export interface WorkflowStartOptions {
  /** Raw `key=value` strings, one per `--input` occurrence. */
  input?: string[];
}

/**
 * Parse repeated `--input key=value` pairs into a run-inputs record, splitting on
 * the FIRST `=` so values may themselves contain `=`. A pair with no `=` (or an
 * empty key) is malformed.
 *
 * @param pairs - Raw `key=value` strings from `--input`.
 * @returns The parsed inputs record.
 * @throws {Error} When any pair lacks a `=` or has an empty key.
 */
function parseInputs(pairs: string[]): Record<string, unknown> {
  const inputs: Record<string, unknown> = {};
  for (const pair of pairs) {
    const eq = pair.indexOf("=");
    if (eq <= 0) throw new Error(`invalid --input ${JSON.stringify(pair)} (expected key=value)`);
    inputs[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return inputs;
}

/**
 * Parse `--input` pairs, or print the malformed-pair error and exit 1. Isolates
 * the only fatal-on-bad-input branch so the start/action-run happy paths stay
 * straight-line.
 *
 * @param pairs - Raw `key=value` strings from `--input`.
 * @returns The parsed inputs record (never returns on malformed input).
 */
export function parseInputsOrExit(pairs: string[]): Record<string, unknown> {
  try {
    return parseInputs(pairs);
  } catch (err) {
    console.error(`\x1b[31mError:\x1b[0m ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}

/**
 * Parse a `--input-json` string into a plain JSON OBJECT, or `null` when the text
 * is malformed JSON or parses to a non-object (array/scalar/`null`). Pure — the
 * caller decides how to report the `null` — so the branchy parse + shape check
 * lives in one place rather than inflating the exit wrapper.
 *
 * @param json - The raw `--input-json` string.
 * @returns The parsed object, or `null` when not a JSON object.
 */
export function parseJsonObject(json: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  const isObject = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed);
  return isObject ? (parsed as Record<string, unknown>) : null;
}

/**
 * Parse `--input-json` into a JSON OBJECT of typed inputs, or print an error and
 * exit 1 BEFORE any core call. Rejects non-object JSON (an array/scalar/`null`)
 * and malformed JSON alike, so a bad `--input-json` never reaches the core.
 *
 * @param json - The raw `--input-json` string (undefined → no typed inputs).
 * @returns The parsed inputs record (empty when `json` is undefined).
 */
export function parseInputJsonOrExit(json: string | undefined): Record<string, unknown> {
  if (json === undefined) return {};
  try {
    // BOUND the raw text BEFORE JSON.parse (memory DoS), then DEPTH-bound the
    // parsed object BEFORE it reaches any stringify/canonicalize (stack overflow).
    assertRawInputJsonWithinBounds(json);
    const parsed = parseJsonObject(json);
    if (parsed === null) throw new Error("--input-json must be a JSON object");
    assertInputDepthWithinBounds(parsed);
    return parsed;
  } catch (err) {
    console.error(`\x1b[31mError:\x1b[0m ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}

/**
 * The optional detail segments of a status line, in print order: the readable run
 * status, an awaiting-gate id, an awaiting-output marker, and any problem. Each
 * row's `value` decides presence and its `render` produces the segment text, so a
 * single filter+map drives the whole line — adding a segment needs no new branch.
 */
function statusDetailParts(status: RunStatus): string[] {
  const rows: { value: unknown; render: () => string }[] = [
    { value: status.run, render: () => `status=${status.run?.status}` },
    { value: status.awaitingGate, render: () => `awaiting-gate: ${status.awaitingGate}` },
    { value: status.awaitingOutput, render: () => "awaiting-output" },
    { value: status.problem, render: () => `problem: ${status.problem}` },
  ];
  return rows.filter((row) => Boolean(row.value)).map((row) => row.render());
}

/** The `submit` hint for a write-park, prefixed with the trusted-write grant when the park is trust-gated. */
function submitHint(status: RunStatus): string {
  const submit = submitCommand(status);
  // A trust-gated write is NOT approvable via `gate approve`; the operator grants
  // the profile's writes with LLMWIKI_TRUSTED_WRITE and re-submits the SAME run.
  return status.awaitingTrustGate === true
    ? `next: this write is trust-gated — set LLMWIKI_TRUSTED_WRITE to grant this profile's writes, then re-run  ${submit}`
    : `next: ${submit}`;
}

/**
 * The concrete `workflow submit` command satisfying a write-park. An artifact-only
 * stage (no `--entity-type` hint but an `--artifact-type` hint) submits
 * `--kind artifact`; every other write-park submits `--kind page`.
 */
function submitCommand(status: RunStatus): string {
  const base = `workflow submit ${status.runId}`;
  if (status.nextSubmitEntityType === undefined && status.nextSubmitArtifactType !== undefined) {
    return `${base} --kind artifact --artifact-type ${status.nextSubmitArtifactType} --slug <slug> --body-file <path>`;
  }
  const entityType = status.nextSubmitEntityType ?? "<entity-type>";
  return `${base} --kind page --entity-type ${entityType} --slug <slug> --body-file <path>`;
}

/**
 * The human-readable `next:` action hint for a parked/failed run, or `null` when no
 * action is pending. A `trust:`-gated park hints the grant + re-submit (NOT
 * `gate approve`, which fails on a trust gate); a human/agent `awaiting-gate` run
 * hints `gate approve`; an `awaiting-output` run hints `submit`; a `failed` run
 * points at `events` (why) and `resume` (retry). Derived from the run's state — the
 * structured fields stay; this is an extra hint line.
 */
function nextHintOf(status: RunStatus): string | null {
  if (status.awaitingGate !== undefined && status.awaitingTrustGate !== true) {
    return `next: workflow gate approve ${status.runId} ${status.awaitingGate}`;
  }
  if (status.awaitingOutput === true || status.awaitingTrustGate === true) {
    return submitHint(status);
  }
  if (status.run?.status === "failed") {
    return `next: workflow events ${status.runId} (why it failed), then workflow resume ${status.runId} to retry`;
  }
  return null;
}

/**
 * The HONEST message for a non-applied (parked) stage output, branching on WHY it
 * parked. A `stage-for-review` decision is a trust DOWNGRADE (an untrusted actor's
 * otherwise-clean write) that the `LLMWIKI_TRUSTED_WRITE` grant LIFTS — so advising
 * the grant is correct. A `quarantine`/`deny` is a write-planner BLOCK of flagged
 * content: the grant does NOT override it (`isApplyDecision` only ever applies
 * `allow`/`allow-with-warning`), so advising the grant there would be misleading
 * AND a security smell. In every case NO `.llmwiki/candidates` review item exists on
 * the workflow path, so the message never claims the output was "staged for review".
 *
 * @param kind - The stage output kind (`page`/`relation`/`lifecycle-transition`).
 * @param decision - The trust decision under which the output parked.
 * @returns The rendered park message.
 */
export function parkedOutputMessage(kind: string, decision: TrustDecision): string {
  const base = `parked, not applied (decision: ${decision}) — no review candidate is created on the workflow path`;
  if (decision === "stage-for-review") return `${base}; set LLMWIKI_TRUSTED_WRITE to apply`;
  return `${base}; this ${kind} output was flagged by the write planner (${decision}) and will NOT be applied — LLMWIKI_TRUSTED_WRITE does not override a planner block`;
}

/** Print one classified run line, including its status (when readable) and any problem. */
export function printRunStatus(status: RunStatus): void {
  const parts = [`${status.runId}  [${status.classification}]`, ...statusDetailParts(status)];
  console.log(parts.join("  "));
  const hint = nextHintOf(status);
  if (hint !== null) console.log(`  ${hint}`);
}

/** True when a status is non-actionable under the current config (problem or blocked). */
export function isProblematic(status: RunStatus): boolean {
  return status.problem !== undefined || status.classification === "blocked-by-config";
}

/** Print a run's current position (status + current stage) after a lifecycle op. */
export function printRunPosition(run: WorkflowRun): void {
  console.log(`status:       ${run.status}`);
  console.log(`currentStage: ${run.currentStage ?? "(none)"}`);
}

/**
 * The real-`process` terminal IO for the interactive human-gate proof, shared by the
 * direct `gate approve` command AND the `action run` command so BOTH human-gate paths
 * use the SAME interactive proof. SDK/MCP never call this (they default to a
 * non-interactive IO that fails closed), so a human gate is satisfiable on no
 * programmatic surface.
 *
 * @returns A {@link HumanGateIo} bound to `process.stdin`/`process.stdout`.
 */
export function processHumanGateIo(): HumanGateIo {
  return {
    stdinIsTty: process.stdin.isTTY === true,
    stdoutIsTty: process.stdout.isTTY === true,
    write: (text) => process.stdout.write(text),
    readLine: () =>
      new Promise<string | null>((resolve) => {
        const rl = createInterface({ input: process.stdin });
        rl.once("line", (line) => {
          rl.close();
          resolve(line);
        });
        rl.once("close", () => resolve(null));
      }),
  };
}
