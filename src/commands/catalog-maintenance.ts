/**
 * @file src/commands/catalog-maintenance.ts
 * @description `llmwiki catalog gc|pin|unpin|pins`: explicit maintenance of an
 * active `local-indexed` project (`../indexed/maintenance.ts`).
 *
 * `gc` previews a segment collection (read-only) and prints its plan, or with
 * `--out <file>` also saves the plan; `gc --apply <file> --readers-offline`
 * applies a saved plan. Apply refuses unless the operator asserts that no
 * llmwiki process from a build WITHOUT reader leases, and no other tool, is
 * reading `.llmwiki/indexed`: reader leases cannot reveal those. `pin` saves
 * the current manifests under a label so a collection keeps their segments;
 * `unpin` removes one; `pins` lists them. `backup <dir>` and `restore <dir>
 * --readers-offline` copy and restore the indexed authority set ONLY (never a
 * wiki backup; the receipt lists what is not included). `runs` previews a
 * retirement of finished batch compile runs (read-only, `--keep <n>` newest
 * finished runs kept for their reports, `--out <file>` saves the plan);
 * `runs --retire <file> --readers-offline` retires exactly what a still-current
 * plan names, deleting those runs' reports. Exit codes: 0 done, 2 refused with
 * nothing deleted or changed, 4 a PARTIAL outcome: a collection that deleted
 * some unreferenced leaves (the envelope's `partial` counts them; the logical
 * stores are unchanged), a restore that stopped after installation began
 * (`recoveryRequired`, the marker path and the resume instruction), or a
 * retirement that stopped after its census (`partial`) or could not remove its
 * barrier (`barrierLeft`).
 */

import { constants } from "node:fs";
import { open, writeFile } from "node:fs/promises";
import { CatalogNotActiveError } from "../catalog/facade.js";
import { IndexedGcError } from "../indexed/gc.js";
import { IndexedMaintenanceBlockedError } from "../indexed/maintenance-lock.js";
import { catalogBackup, catalogGcApply, catalogGcPreview, catalogPin, catalogPins, catalogRestore, catalogRunsPreview, catalogRunsRetire, catalogUnpin } from "../indexed/maintenance.js";
import { IndexedRestoreError, RESTORE_MARKER_PATH } from "../indexed/restore-check.js";
import { IndexedRunsError, type RunRetirePreviewV1 } from "../indexed/run-retire.js";
import { IndexedStoreError } from "../segments/contracts.js";
import { emit, emitNotActive, EXIT_REFUSED, type CatalogCommandOptions } from "./catalog.js";

/** A saved plan is small: one entry per store. */
const MAX_PLAN_BYTES = 16 * 1024 * 1024;

/** Options of `catalog gc`. */
export interface CatalogGcCommandOptions extends CatalogCommandOptions {
  readonly apply?: string;
  readonly out?: string;
  readonly readersOffline?: boolean;
}

/** Physical cleanup stopped part-way (only unreferenced leaves were deleted; the logical stores are unchanged). */
const EXIT_PARTIAL = 4;

/** The stable code of a typed maintenance refusal, or `null` for any other error. */
function refusalCode(error: unknown): string | null {
  if (error instanceof IndexedMaintenanceBlockedError) return error.code;
  if (error instanceof IndexedGcError || error instanceof IndexedStoreError || error instanceof IndexedRestoreError || error instanceof IndexedRunsError) return error.code;
  return null;
}

/** The partial-cleanup facts of a refusal that stopped part-way (exit 4), or `null`. */
function partialFacts(error: unknown): Record<string, unknown> | null {
  if (error instanceof IndexedRestoreError && error.recoveryRequired) return { recoveryRequired: true, marker: RESTORE_MARKER_PATH, resume: "re-run the same `llmwiki catalog restore <dir> --readers-offline`" };
  if (error instanceof IndexedGcError && error.partial !== undefined) return { partial: error.partial };
  if (error instanceof IndexedRunsError && error.code === "indexed_runs_cleanup_failed") return { partial: error.partial, barrierLeft: true };
  if (error instanceof IndexedRunsError && error.partial !== undefined) return { partial: error.partial };
  return null;
}

/** Run one maintenance command, turning a typed refusal into its envelope (exit 2, or 4 for a partial cleanup). */
async function refusing(command: string, options: CatalogCommandOptions, work: () => Promise<number>): Promise<number> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof CatalogNotActiveError) return emitNotActive(command, error, options);
    const code = refusalCode(error);
    if (code === null) throw error;
    const message = (error as Error).message;
    const partial = partialFacts(error);
    return emit(command, { ...partial, refusal: { code, message } }, [message], options, partial === null ? EXIT_REFUSED : EXIT_PARTIAL);
  }
}

/** A collection plan file's refusal. */
const gcPlanInvalid = (message: string): Error => new IndexedGcError("indexed_gc_plan_invalid", message);
/** A retirement plan file's refusal. */
const runsPlanInvalid = (message: string): Error => new IndexedRunsError("indexed_runs_plan_invalid", message);

/** Read a saved plan file: a regular file within the cap, parsed as JSON; anything else is refused through `refuse`. */
async function readPlan(file: string, refuse: (message: string) => Error = gcPlanInvalid): Promise<unknown> {
  const invalid = (why: string) => refuse(`${file} ${why}`);
  // NONBLOCK so a FIFO or device cannot hang the open before it is rejected as not a regular file.
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(() => { throw invalid("cannot be opened as a regular file"); });
  try {
    if (!(await handle.stat()).isFile()) throw invalid("is not a regular file");
    const buffer = Buffer.alloc(MAX_PLAN_BYTES + 1);
    let filled = 0;
    for (let read = -1; read !== 0 && filled < buffer.length; filled += read) read = (await handle.read(buffer, filled, buffer.length - filled, filled)).bytesRead;
    if (filled > MAX_PLAN_BYTES) throw invalid(`is larger than ${MAX_PLAN_BYTES} bytes`);
    try { return JSON.parse(buffer.subarray(0, filled).toString("utf8")) as unknown; } catch { throw invalid("is not JSON"); }
  } finally {
    await handle.close();
  }
}

/** `llmwiki catalog gc [--out plan.json]` or `llmwiki catalog gc --apply plan.json --readers-offline`. */
export function catalogGcCommand(options: CatalogGcCommandOptions = {}): Promise<number> {
  return refusing("catalog gc", options, async () => {
    if (options.apply !== undefined && options.out !== undefined) throw new IndexedGcError("indexed_gc_plan_invalid", "--apply and --out cannot be combined: preview with --out, then apply that file");
    if (options.apply !== undefined) {
      const report = await catalogGcApply(process.cwd(), await readPlan(options.apply), { readersOffline: options.readersOffline === true });
      return emit("catalog gc", { applied: report }, [`Deleted ${report.deletedLeaves} unreferenced segment leaves (${report.deletedBytes} bytes); ${report.staleLeases} stale reader lease(s) ignored`], options);
    }
    const preview = await catalogGcPreview(process.cwd());
    if (options.out !== undefined) await writeFile(options.out, `${JSON.stringify(preview.plan, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    const lines = [
      `Reclaimable: ${preview.reclaimableLeaves} unreferenced segment leaves, ${preview.reclaimableBytes} bytes; pins: ${preview.pins.length}`,
      ...(preview.admissible ? [] : [`BLOCKED (apply would refuse): ${preview.blockers.slice(0, 5).join("; ")}`]),
      ...(options.out === undefined ? [] : [`Plan saved to ${options.out}; apply with: llmwiki catalog gc --apply ${options.out} --readers-offline`]),
    ];
    return emit("catalog gc", { preview }, lines, options);
  });
}

/** `llmwiki catalog pin <label>`. */
export function catalogPinCommand(label: string, options: CatalogCommandOptions = {}): Promise<number> {
  return refusing("catalog pin", options, async () => {
    const pinned = await catalogPin(process.cwd(), label);
    return emit("catalog pin", { ...pinned }, [`Pinned ${pinned.stores} store manifests as ${pinned.label}`], options);
  });
}

/** `llmwiki catalog unpin <label>`. */
export function catalogUnpinCommand(label: string, options: CatalogCommandOptions = {}): Promise<number> {
  return refusing("catalog unpin", options, async () => {
    const removed = await catalogUnpin(process.cwd(), label);
    return emit("catalog unpin", { ...removed }, [`Removed pin ${removed.label}`], options);
  });
}

/** `llmwiki catalog pins`. */
export function catalogPinsCommand(options: CatalogCommandOptions = {}): Promise<number> {
  return refusing("catalog pins", options, async () => {
    const pins = await catalogPins(process.cwd());
    return emit("catalog pins", { ...pins }, [...pins.labels.map((label) => `Pin: ${label}`), ...pins.blockers.map((blocker) => `Warning: ${blocker}`)], options);
  });
}

/** `llmwiki catalog backup <dir>`: the indexed authority set only. */
export function catalogBackupCommand(dir: string, options: CatalogCommandOptions = {}): Promise<number> {
  return refusing("catalog backup", options, async () => {
    const receipt = await catalogBackup(process.cwd(), dir);
    return emit("catalog backup", { receipt }, [`Backed up the indexed authority set: ${receipt.stores} stores, ${receipt.segments} segments (${receipt.segmentBytes} bytes) to ${receipt.dir}`, `Not included: ${receipt.notIncluded}`], options);
  });
}

/** `llmwiki catalog restore <dir> --readers-offline`: same canonical root only. */
export function catalogRestoreCommand(dir: string, options: CatalogGcCommandOptions = {}): Promise<number> {
  return refusing("catalog restore", options, async () => {
    const receipt = await catalogRestore(process.cwd(), dir, { readersOffline: options.readersOffline === true });
    const lines = [
      `Restored the indexed authority set${receipt.resumed ? " (resumed)" : ""}: ${receipt.created} segments created, ${receipt.repaired} repaired, ${receipt.kept} kept; auxiliary written ${receipt.auxWritten.length}, removed ${receipt.auxRemoved.length}, untouched ${receipt.auxUntouched.length}`,
      ...(receipt.reconciledStamps.length > 0 ? [`Legacy stamps reconciled (manifests differ from the backup only there): ${receipt.reconciledStamps.join(", ")}`] : []),
      `Not restored or checked: ${receipt.notIncluded}`,
    ];
    return emit("catalog restore", { receipt }, lines, options);
  });
}

/** Options of `catalog runs`. */
export interface CatalogRunsCommandOptions extends CatalogCommandOptions {
  readonly keep?: string;
  readonly out?: string;
  readonly retire?: string;
  readonly readersOffline?: boolean;
}

/** Most runs a text preview lists (`--json` lists every one). */
const PREVIEW_RUN_LINES = 50;

/** Parse `--keep`: a whole number, or absent (the default). */
function keepOf(text: string | undefined): number | undefined {
  if (text === undefined) return undefined;
  if (!/^\d{1,4}$/.test(text)) throw runsPlanInvalid("--keep must be a whole number from 0 to 1000");
  return Number(text);
}

/** The text lines of a retirement preview. */
function runsPreviewLines(preview: RunRetirePreviewV1, out: string | undefined): string[] {
  const lost = preview.reportsLost;
  return [
    `Retirable: ${preview.retirableRuns} finished batch compile run(s), ${preview.retirableBytes} bytes; ${preview.pendingCleanup} interrupted cleanup(s) to finish`,
    ...preview.runs.slice(0, PREVIEW_RUN_LINES).map((run) => `${run.runId} ${run.phase} ${run.class}: ${run.reason}`),
    ...(preview.runs.length > PREVIEW_RUN_LINES ? [`... ${preview.runs.length - PREVIEW_RUN_LINES} more run(s); use --json for all`] : []),
    ...(lost.length > 0 ? [`Retiring DELETES the reports of: ${lost.slice(0, 20).join(", ")}${lost.length > 20 ? ` and ${lost.length - 20} more` : ""}; page any you need first (llmwiki compile --report <runId>)`] : []),
    ...(preview.truncated ? ["Some eligible runs are deferred by this plan's leaf budget; retire again afterwards"] : []),
    ...(preview.admissible ? [] : [`BLOCKED (retire would refuse): ${preview.blockers.slice(0, 5).join("; ")}`]),
    ...(out === undefined ? [] : [`Plan saved to ${out}; retire with: llmwiki catalog runs --retire ${out} --readers-offline (a new process)`]),
  ];
}

/** `llmwiki catalog runs --retire plan.json --readers-offline`. */
async function retireRuns(file: string, options: CatalogRunsCommandOptions): Promise<number> {
  const report = await catalogRunsRetire(process.cwd(), await readPlan(file, runsPlanInvalid), { readersOffline: options.readersOffline === true });
  return emit("catalog runs", { retired: report }, [`Retired ${report.retired.length} batch compile run(s) and their reports (${report.reclaimedBytes} bytes reclaimed); finished ${report.cleaned} interrupted cleanup(s); ${report.staleLeases} stale reader lease(s) ignored`], options);
}

/** `llmwiki catalog runs [--keep n] [--out plan.json]` or `llmwiki catalog runs --retire plan.json --readers-offline`. */
export function catalogRunsCommand(options: CatalogRunsCommandOptions = {}): Promise<number> {
  return refusing("catalog runs", options, async () => {
    if (options.retire !== undefined && (options.out !== undefined || options.keep !== undefined)) throw runsPlanInvalid("--retire cannot be combined with --out or --keep: preview with them, then retire that file");
    if (options.retire !== undefined) return retireRuns(options.retire, options);
    const preview = await catalogRunsPreview(process.cwd(), { keepFinished: keepOf(options.keep) });
    if (options.out !== undefined) await writeFile(options.out, `${JSON.stringify(preview.plan, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    return emit("catalog runs", { preview }, runsPreviewLines(preview, options.out), options);
  });
}
