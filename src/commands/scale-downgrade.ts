/**
 * @file src/commands/scale-downgrade.ts
 * @description `llmwiki scale preview`, `llmwiki scale downgrade` and
 * `llmwiki scale archive list|report`.
 *
 * - `scale preview --size|--documents [--capability]`: what `scale set` would
 *   do, read-only and lock-free (lowering an estimate never scales down).
 * - `scale downgrade --target <layout> --size|--documents --out plan.json`:
 *   the read-only scale-down preview; the plan is saved to a NEW file.
 * - `scale downgrade --apply plan.json --readers-offline`: apply (or resume)
 *   exactly that plan, from a fresh process.
 * - `scale downgrade --cancel plan.json --readers-offline`: return a
 *   scale-down that has moved nothing yet to the incumbent layout (a fenced
 *   one keeps its planned estimate on the record; one that never fenced
 *   writes no record); refused after the first move.
 * - `scale archive list` and `scale archive report <name> <runId> [--cursor c]`:
 *   the retained archives and their batch run reports, read-only.
 *
 * Exit codes: 0 done or ready; 3 the preview or apply is blocked; 2 refused
 * with nothing changed (an invalid, stale or foreign plan, readers not
 * asserted offline or found live, an invalid archive); 4 a scale-down stopped
 * part-way (every state left is consistent; re-run the same apply). `--json`
 * emits one versioned envelope on stdout.
 */

import { constants } from "node:fs";
import { open, writeFile } from "node:fs/promises";
import type { CapabilityNameV3, DowngradeTarget } from "../scale/contracts-v2.js";
import { ScaleRefusalError } from "../scale/contracts.js";
import { applyScaleDowngrade, type DowngradeApplyResultV1 } from "../scale/downgrade-apply.js";
import { cancelScaleDowngrade, type DowngradeCancelResultV1 } from "../scale/downgrade-cancel.js";
import { listScaleArchives, readArchivedReport } from "../scale/downgrade-archive-reader.js";
import { ScaleDowngradeError } from "../scale/downgrade-contracts.js";
import { parseDowngradePlan, serializeDowngradePlan } from "../scale/downgrade-plan.js";
import { parseExpectedScale } from "../scale/init.js";
import { previewScaleDowngrade, previewScaleTransition, type ScaleDowngradePreviewV1 } from "../scale/preview.js";
import { canonicalRoot } from "../segments/reader-lease.js";
import * as output from "../utils/output.js";

/** Version of the `--json` envelope these commands emit. */
const SCALE_DOWNGRADE_JSON_VERSION = 1;
const EXIT_DONE = 0;
const EXIT_REFUSED = 2;
const EXIT_BLOCKED = 3;
const EXIT_PARTIAL = 4;
/** Longest plan file read. */
const MAX_PLAN_FILE_BYTES = 16 * 1024 * 1024;

/** Options of `scale preview`. */
export interface ScalePreviewCommandOptions {
  readonly size?: string;
  readonly documents?: string;
  readonly capability?: readonly string[];
  readonly json?: boolean;
}

/** Options of `scale downgrade`. */
export interface ScaleDowngradeCommandOptions {
  readonly target?: string;
  readonly size?: string;
  readonly documents?: string;
  readonly out?: string;
  readonly apply?: string;
  readonly cancel?: string;
  readonly readersOffline?: boolean;
  readonly json?: boolean;
}

/** Options of `scale archive report`. */
export interface ScaleArchiveCommandOptions {
  readonly cursor?: string;
  readonly json?: boolean;
}

/** Emit `body` (JSON) or `lines` (text), then return `code`. */
function emit(command: string, body: Record<string, unknown>, lines: readonly string[], options: { json?: boolean }, code = EXIT_DONE): number {
  if (options.json) process.stdout.write(`${JSON.stringify({ version: SCALE_DOWNGRADE_JSON_VERSION, command, ok: code === EXIT_DONE, ...body }, null, 2)}\n`);
  else for (const line of lines) output.status(code === EXIT_DONE ? "*" : "!", line);
  return code;
}

/** The exit code of a refusal. */
function refusalCode(error: ScaleDowngradeError | ScaleRefusalError): number {
  if (error instanceof ScaleRefusalError) return EXIT_REFUSED;
  return error.code === "scale_downgrade_partial" ? EXIT_PARTIAL : error.code === "scale_downgrade_blocked" ? EXIT_BLOCKED : EXIT_REFUSED;
}

/** Run `work`, turning a typed refusal into its envelope and exit code. */
async function refusing(command: string, options: { json?: boolean }, work: () => Promise<number>): Promise<number> {
  if (options.json) output.setQuiet(true);
  try {
    return await work();
  } catch (error) {
    if (!(error instanceof ScaleDowngradeError) && !(error instanceof ScaleRefusalError)) throw error;
    const detail = error instanceof ScaleDowngradeError ? error.detail : undefined;
    return emit(command, { refusal: { code: error.code, message: error.message, ...(detail === undefined ? {} : { detail }) } }, [error.message], options, refusalCode(error));
  } finally {
    if (options.json) output.setQuiet(false);
  }
}

/** The estimate the options name; at least one figure. */
function requestOf(options: { size?: string; documents?: string }) {
  const request = parseExpectedScale(options.size, options.documents);
  if (request === undefined) throw new ScaleRefusalError("scale_invalid_request", "give --size, --documents, or both");
  return request;
}

/** `llmwiki scale preview --size|--documents [--capability <name>]...`: read-only. */
export function scalePreviewCommand(options: ScalePreviewCommandOptions = {}): Promise<number> {
  return refusing("scale preview", options, async () => {
    const preview = await previewScaleTransition(process.cwd(), requestOf(options), (options.capability ?? []) as CapabilityNameV3[]);
    const lines = [
      `Planned: ${preview.plan.architecture}; active: ${preview.current.record?.active.architecture ?? "local-standard"}; change: ${preview.change}`,
      ...(preview.steps.length > 0 ? [`Steps: ${preview.steps.join(", ")}`] : []),
      ...(preview.preflight === null ? [] : [`Free space: ${preview.preflight.freeBytes} bytes; required: ${preview.preflight.requiredBytes} bytes`]),
      `Measured: ${preview.measured.sourceDocuments} source documents (${preview.measured.sourceBytes} bytes); ${preview.measured.wikiFiles} wiki files (${preview.measured.wikiBytes} bytes)`,
      ...(preview.estimateBelowMeasured ? ["The measured size alone plans a larger layout than this estimate"] : []),
      ...(preview.change === "none" && preview.current.record !== null ? ["A smaller estimate keeps the active layout; an explicit scale-down is `llmwiki scale downgrade`"] : []),
      preview.current.notice,
    ];
    return emit("scale preview", { preview }, lines, options);
  });
}

/** The text lines of a scale-down preview. */
function downgradeLines(preview: ScaleDowngradePreviewV1, out: string | undefined): string[] {
  const { inventory } = preview.plan;
  const blockers = [...inventory.blockers, ...(preview.space === null ? [] : [preview.space])];
  return [
    `Scale-down ${inventory.from} -> ${inventory.target}: ${inventory.units.filter((unit) => unit.present).length} file(s) to export and install, ${inventory.stores.length} store(s) and ${inventory.runs.length} batch run(s) to archive`,
    `Measured: ${inventory.measured.sourceDocuments} source documents (${inventory.measured.sourceBytes} bytes)`,
    ...(inventory.notices.length > 0 ? [`Notices: ${inventory.notices.join(", ")}`] : []),
    ...blockers.slice(0, 10).map((blocker) => `BLOCKED ${blocker.code}: ${blocker.detail}`),
    ...(out === undefined ? [] : [`Plan saved to ${out}; apply with: llmwiki scale downgrade --apply ${out} --readers-offline (a new process)`]),
  ];
}

/** The scale-down preview, saved to a new plan file when `--out` is given. */
async function previewDowngrade(options: ScaleDowngradeCommandOptions): Promise<number> {
  if (options.target !== "local-standard" && options.target !== "local-large") throw new ScaleRefusalError("scale_invalid_request", "--target must be local-standard or local-large");
  const preview = await previewScaleDowngrade(process.cwd(), { target: options.target as DowngradeTarget, request: requestOf(options) });
  if (options.out !== undefined) await writeFile(options.out, serializeDowngradePlan(preview.plan), { flag: "wx", mode: 0o600 });
  return emit("scale downgrade", { preview }, downgradeLines(preview, options.out), options, preview.ready ? EXIT_DONE : EXIT_BLOCKED);
}

/** The text lines of an applied scale-down. */
function appliedLines(result: DowngradeApplyResultV1): string[] {
  return [
    `Scaled down to ${result.target} at revision ${result.revision}${result.resumed ? " (resumed)" : ""}: ${result.installed.length} file(s) installed, ${result.retainedPriors.length} prior file(s) and ${result.archivedStores} store(s) retained in ${result.dir ?? "(nothing to retain)"}`,
    ...(result.runs.length > 0 ? [`${result.runs.length} batch run report(s) archived; page them with llmwiki scale archive report`] : []),
    ...(result.current === undefined ? [] : [`The record has since moved to revision ${result.current.revision} (${result.current.architecture}); it was not changed`]),
  ];
}

/** A saved plan file that cannot be used as a plan. */
const planFileInvalid = (file: string, why: string): ScaleDowngradeError => new ScaleDowngradeError("scale_downgrade_invalid_plan", `${file} ${why}`);

/**
 * The text of the saved plan `file`, under the repository's plan-file policy
 * (as `catalog gc --apply`): a regular file, never followed through a symlink,
 * read through one handle that never reads more than one byte past the cap,
 * however large the file is or grows; short reads are continued. Anything else
 * is refused as an invalid plan, and the handle is always closed.
 */
async function readPlanText(file: string): Promise<string> {
  // NONBLOCK so a FIFO or device cannot hang the open before it is rejected as not a regular file.
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(() => { throw planFileInvalid(file, "cannot be opened as a regular file"); });
  try {
    if (!(await handle.stat()).isFile()) throw planFileInvalid(file, "is not a regular file");
    const buffer = Buffer.alloc(MAX_PLAN_FILE_BYTES + 1);
    let filled = 0;
    for (let read = -1; read !== 0 && filled < buffer.length; filled += read) read = (await handle.read(buffer, filled, buffer.length - filled, filled)).bytesRead;
    if (filled > MAX_PLAN_FILE_BYTES) throw planFileInvalid(file, "is larger than a plan");
    return buffer.subarray(0, filled).toString("utf8");
  } finally {
    await handle.close();
  }
}

/** The saved plan `file`, parsed for the project here, with its canonical root. */
async function savedPlan(file: string): Promise<{ root: string; plan: ReturnType<typeof parseDowngradePlan> }> {
  const root = await canonicalRoot(process.cwd());
  return { root, plan: parseDowngradePlan(await readPlanText(file), root) };
}

/** Apply (or resume) the saved plan `file`. */
async function applyDowngrade(file: string, options: ScaleDowngradeCommandOptions): Promise<number> {
  const { root, plan } = await savedPlan(file);
  const result = await applyScaleDowngrade(root, plan, { readersOffline: options.readersOffline === true });
  return emit("scale downgrade", { applied: result }, appliedLines(result), options);
}

/** The text lines of a cancelled scale-down. */
function cancelledLines(result: DowngradeCancelResultV1): string[] {
  const what = result.alreadyCancelled ? "was already cancelled earlier" : result.phase === "fenced" ? `cancelled at record revision ${result.cancelRevision}` : "cancelled before it fenced (the record was not changed)";
  const effects = result.alreadyCancelled
    ? "That cancel returned the project to its indexed layout and moved or deleted nothing; later work may have changed the record since (see llmwiki scale status). This run only finished any leftover cleanup."
    : "The incumbent indexed layout is active and nothing was moved or deleted.";
  return [
    `Scale-down ${what}${result.resumed ? " (resumed)" : ""}. ${effects}`,
    result.estimate === "planned-kept"
      ? "The smaller estimate this scale-down planned stays on the record the cancel wrote; set another with llmwiki scale set if you want it changed."
      : "No scale record was written, so the estimate is unchanged.",
    ...(result.currentEstimate === null ? [] : [`Estimate on the record now: ${result.currentEstimate.sizeBytes} bytes, ${result.currentEstimate.documents} documents${result.alreadyCancelled ? " (it may reflect later changes)" : ""}`]),
    `Evidence kept in ${result.dir}`,
    ...(result.laterRecord === null ? [] : [`The record had since moved to revision ${result.laterRecord.revision} (${result.laterRecord.architecture}); the cancel did not change it`]),
  ];
}

/** Cancel (or finish cancelling) the saved plan `file` before it moved anything. */
async function cancelDowngrade(file: string, options: ScaleDowngradeCommandOptions): Promise<number> {
  const { root, plan } = await savedPlan(file);
  const result = await cancelScaleDowngrade(root, plan, { readersOffline: options.readersOffline === true });
  return emit("scale downgrade", { cancelled: result }, cancelledLines(result), options);
}

/** Whether an option only a preview takes (`--out`, `--target`, `--size`, `--documents`) was given. */
function hasPreviewOption(options: ScaleDowngradeCommandOptions): boolean {
  return options.out !== undefined || options.target !== undefined || options.size !== undefined || options.documents !== undefined;
}

/** Refuse a saved-plan run that names both `--apply` and `--cancel`, then one that also names a preview option. */
function assertSavedPlanOptions(options: ScaleDowngradeCommandOptions): void {
  if (options.apply !== undefined && options.cancel !== undefined) throw new ScaleDowngradeError("scale_downgrade_invalid_plan", "give --apply or --cancel, not both");
  if (hasPreviewOption(options)) {
    throw new ScaleDowngradeError("scale_downgrade_invalid_plan", "--apply and --cancel take only the saved plan: preview with --target and an estimate first");
  }
}

/** Cancel (`--cancel`) or apply (`--apply`) the saved plan `file`. */
function runSavedPlan(file: string, options: ScaleDowngradeCommandOptions): Promise<number> {
  return options.cancel !== undefined ? cancelDowngrade(file, options) : applyDowngrade(file, options);
}

/** `llmwiki scale downgrade --target <layout> --size|--documents [--out plan.json]`, `--apply plan.json` or `--cancel plan.json` (with `--readers-offline`). */
export function scaleDowngradeCommand(options: ScaleDowngradeCommandOptions = {}): Promise<number> {
  return refusing("scale downgrade", options, async () => {
    const file = options.apply ?? options.cancel;
    if (file === undefined) return previewDowngrade(options);
    assertSavedPlanOptions(options);
    return runSavedPlan(file, options);
  });
}

/** `llmwiki scale archive list`: read-only. */
export function scaleArchiveListCommand(options: { json?: boolean } = {}): Promise<number> {
  return refusing("scale archive list", options, async () => {
    const archives = await listScaleArchives(process.cwd());
    const lines = archives.length === 0 ? ["No retained scale-down archives"] : archives.map((archive) => `${archive.name}: to ${archive.target} at fence revision ${archive.fenceRevision}; ${archive.runs.length} batch run(s); last run ${archive.lastRun ?? "none"}`);
    return emit("scale archive list", { archives }, lines, options);
  });
}

/** `llmwiki scale archive report <name> <runId> [--cursor c]`: one page, read-only. */
export function scaleArchiveReportCommand(name: string, runId: string, options: ScaleArchiveCommandOptions = {}): Promise<number> {
  return refusing("scale archive report", options, async () => {
    const page = await readArchivedReport(process.cwd(), name, runId, options.cursor);
    const lines = [...page.lines.map((line) => JSON.stringify(line)), ...(page.cursor === undefined ? [] : [`More: --cursor ${page.cursor}`])];
    return emit("scale archive report", { page }, lines, options);
  });
}
