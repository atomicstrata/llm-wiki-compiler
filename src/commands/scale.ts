/**
 * @file src/commands/scale.ts
 * @description `llmwiki init` and `llmwiki scale set|status|prepare`.
 *
 * Each returns its exit code: 0 when the project is ready (or has no expected
 * scale, today's behaviour), 3 when dependent work is blocked (a transition is
 * preparing or parked, the estimate needs an unavailable backend, or the
 * record is unreadable), and 2 when a request was refused and nothing changed
 * (invalid input, a revision conflict, an unreadable record on update). Any
 * other failure propagates to the CLI's shared error handler.
 *
 * `--json` emits one versioned envelope on stdout. Every report repeats that
 * an expected scale is a planning target, not verified capacity.
 */

import { ScaleRefusalError, type ScaleRequest } from "../scale/contracts.js";
import type { ScaleRecord } from "../scale/contracts-v2.js";
import { initProject, parseExpectedScale } from "../scale/init.js";
import type { CapabilityNameV3 } from "../scale/contracts-v2.js";
import { prepareExpectedScale, scaleStatus, setExpectedScale, type ScaleReport } from "../scale/transition.js";
import * as output from "../utils/output.js";

/** Version of the `--json` envelope these commands emit. */
const SCALE_JSON_VERSION = 1;
const EXIT_READY = 0;
const EXIT_REFUSED = 2;
const EXIT_BLOCKED = 3;

/** Options shared by every scale command. */
export interface ScaleOutputOptions {
  readonly json?: boolean;
}

/** `llmwiki scale prepare` options. */
export interface ScalePrepareCommandOptions extends ScaleOutputOptions {
  /** `--capability <name>` (repeatable): version 3 capabilities to hold and prepare. */
  readonly capability?: readonly string[];
}

/** `llmwiki init` options. */
export interface InitCommandOptions extends ScaleOutputOptions {
  readonly expectedSize?: string;
  readonly expectedDocuments?: string;
}

/** `llmwiki scale set` options. */
export interface ScaleSetCommandOptions extends ScaleOutputOptions {
  readonly size?: string;
  readonly documents?: string;
  /** Commander's `--no-prepare` sets this false. */
  readonly prepare?: boolean;
  readonly expectRevision?: string;
  /** `--capability <name>` (repeatable): version 3 capabilities to hold and prepare. */
  readonly capability?: readonly string[];
}

/** The exit code a report implies. */
function exitCodeOf(report: ScaleReport): number {
  return report.readiness === "ready" || report.readiness === "unconfigured" ? EXIT_READY : EXIT_BLOCKED;
}

/** Human lines for the recorded estimate, plan and active architecture. */
function recordLines(record: ScaleRecord, report: ScaleReport): string[] {
  const { sizeBytes, documents, sizeBasis, documentsBasis } = record.requested;
  return [
    `Expected: ${sizeBytes} bytes (${sizeBasis}), ${documents} documents (${documentsBasis}); revision ${record.revision}`,
    `Planned: ${report.plan?.architecture ?? "unknown"}; active: ${record.active.architecture}`,
  ];
}

/** Human lines for a pending transition's steps or an unavailable estimate's missing backends. */
function pendingLines(pending: ScaleRecord["pending"]): string[] {
  if (pending === null) return [];
  if (pending.kind === "prepare") return pending.steps.map((step) => `Step ${step.name}: ${step.status}${step.detail ? ` — ${step.detail}` : ""}`);
  if (pending.kind === "downgrade") return [`Scale-down to ${pending.target} in progress (plan ${pending.plan}); resume it with \`llmwiki scale downgrade --apply\` and the same plan`];
  const exceeds = pending.exceeds.length === 0 ? [] : [`Exceeds the local envelope by: ${pending.exceeds.join(", ")}`];
  return [...exceeds, `Not provided by this build: ${pending.missing.join(", ")}`];
}

/** Human lines for a report. */
function humanLines(report: ScaleReport): string[] {
  const lines = [`Readiness: ${report.readiness}`];
  if (report.reason !== undefined) lines.push(`Reason: ${report.reason}`);
  if (report.record !== null) lines.push(...recordLines(report.record, report), ...pendingLines(report.record.pending));
  if (report.superseded) lines.push("This request superseded a pending one.");
  if (report.replanAvailable === true) lines.push("The current policy plans this estimate differently; run `llmwiki scale prepare` to re-plan it.");
  return [...lines, report.notice];
}

/** Emit a report, then return its exit code. */
function emitReport(command: string, report: ScaleReport, options: ScaleOutputOptions, extra: Record<string, unknown> = {}): number {
  if (options.json) {
    process.stdout.write(`${JSON.stringify({ version: SCALE_JSON_VERSION, command, ok: true, ...extra, ...report }, null, 2)}\n`);
  } else {
    for (const line of humanLines(report)) output.status("*", line);
  }
  return exitCodeOf(report);
}

/** Emit a refusal; nothing was changed. */
function emitRefusal(command: string, error: ScaleRefusalError, options: ScaleOutputOptions): number {
  if (options.json) {
    const refusal = { code: error.code, message: error.message };
    process.stdout.write(`${JSON.stringify({ version: SCALE_JSON_VERSION, command, ok: false, refusal }, null, 2)}\n`);
  } else {
    output.status("!", output.error(error.message));
  }
  return EXIT_REFUSED;
}

/** Run `work`, turning a scale refusal into its envelope and exit code. */
async function runScaleCommand(command: string, options: ScaleOutputOptions, work: () => Promise<number>): Promise<number> {
  if (options.json) output.setQuiet(true);
  try {
    return await work();
  } catch (error) {
    if (error instanceof ScaleRefusalError) return emitRefusal(command, error, options);
    throw error;
  } finally {
    if (options.json) output.setQuiet(false);
  }
}

/** Parse `--expect-revision`: a non-negative whole number. */
function parseExpectRevision(text: string | undefined): number | undefined {
  if (text === undefined) return undefined;
  if (!/^\d{1,15}$/.test(text.trim())) throw new ScaleRefusalError("scale_invalid_request", "--expect-revision must be a whole number");
  return Number(text.trim());
}

/** The request `scale set` names: a size, a document count, or both. */
function setRequest(options: ScaleSetCommandOptions): ScaleRequest {
  const request = parseExpectedScale(options.size, options.documents);
  if (request === undefined) throw new ScaleRefusalError("scale_invalid_request", "give --size, --documents, or both");
  return request;
}

/** `llmwiki init [--expected-size <size>] [--expected-documents <n>]` in the current directory. */
export function initCommand(options: InitCommandOptions = {}): Promise<number> {
  return runScaleCommand("init", options, async () => {
    const result = await initProject(process.cwd(), parseExpectedScale(options.expectedSize, options.expectedDocuments));
    return emitReport("init", result.report, options, { created: result.created });
  });
}

/** `llmwiki scale set [--size <size>] [--documents <n>] [--no-prepare] [--expect-revision <n>]`; at least one estimate. */
export function scaleSetCommand(options: ScaleSetCommandOptions = {}): Promise<number> {
  return runScaleCommand("scale set", options, async () => {
    const input = {
      request: setRequest(options), prepare: options.prepare !== false, expectedRevision: parseExpectRevision(options.expectRevision),
      capabilities: options.capability as readonly CapabilityNameV3[] | undefined,
    };
    return emitReport("scale set", await setExpectedScale(process.cwd(), input), options);
  });
}

/** `llmwiki scale status`: read-only and lock-free. */
export function scaleStatusCommand(options: ScaleOutputOptions = {}): Promise<number> {
  return runScaleCommand("scale status", options, async () => emitReport("scale status", await scaleStatus(process.cwd()), options));
}

/** `llmwiki scale prepare [--capability <name>]...`: resume or re-verify the pending transition, or upgrade the capabilities of an active indexed project. */
export function scalePrepareCommand(options: ScalePrepareCommandOptions = {}): Promise<number> {
  return runScaleCommand("scale prepare", options, async () => {
    const report = await prepareExpectedScale(process.cwd(), { capabilities: options.capability as readonly CapabilityNameV3[] | undefined });
    return emitReport("scale prepare", report, options);
  });
}
