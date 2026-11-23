/**
 * @file src/compiler/batch/report.ts
 * @description The PAGED REPORT of a batch compile: every per-source and
 * per-page fact the incumbent `CompileResult` would list (compiled and
 * deleted sources, written pages, seed pages, errors) is a report line
 * `r:<n>` in the run store, written in the unit that produced it, so the
 * result itself stays bounded (counts only) and no line is dropped: a page
 * holds at most {@link REPORT_PAGE_LINES} lines and {@link REPORT_PAGE_BYTES}
 * bytes (always at least one line; an error message longer than
 * {@link MAX_REPORT_MESSAGE_CHARS} is shortened with an explicit marker when it
 * is written, so every line fits a page). Every persisted line is checked
 * against that closed, bounded shape before it is returned; a malformed or
 * oversized row is a typed refusal, never echoed. `compile --report <runId> [--cursor c]` and
 * `wiki.compileReport(runId, {cursor})` page it.
 */

import { MAX_KEY_CHARS } from "../../segments/contracts.js";
import { BatchCompileError, keySeq, seqKey } from "./contracts.js";
import type { SegmentStoreIo } from "../../segments/io.js";
import { BatchRun } from "./run-store.js";

/** One report line. */
export type ReportLineV1 =
  | { readonly kind: "compiled" | "deleted"; readonly file: string }
  | { readonly kind: "page" | "seed"; readonly slug: string; readonly created: boolean }
  | { readonly kind: "error"; readonly slug?: string; readonly file?: string; readonly message: string };

/** Report lines one page returns at most. */
const REPORT_PAGE_LINES = 500;
/** Report bytes one page returns at most (always at least one line). */
const REPORT_PAGE_BYTES = 1024 * 1024;
/** The longest message one report line keeps; a longer one is shortened with an explicit marker. */
const MAX_REPORT_MESSAGE_CHARS = 8 * 1024;
/** The longest message a persisted line may carry: the kept message plus the shortening marker. */
const MAX_REPORT_LINE_MESSAGE_CHARS = MAX_REPORT_MESSAGE_CHARS + 64;

/** `line` with its message within the line cap (marked when shortened), so any line fits one page. */
function bounded(line: ReportLineV1): ReportLineV1 {
  if (line.kind !== "error" || line.message.length <= MAX_REPORT_MESSAGE_CHARS) return line;
  return { ...line, message: `${line.message.slice(0, MAX_REPORT_MESSAGE_CHARS)}… (${line.message.length - MAX_REPORT_MESSAGE_CHARS} more characters)` };
}

/** Append one report line (in the caller's unit; it is committed with the caller's checkpoint). */
export async function report(run: BatchRun, line: ReportLineV1): Promise<void> {
  await run.put(seqKey("r:", run.counters.reported++), bounded(line));
}

/** One page of a run's report. */
export interface ReportPageV1 {
  readonly runId: string;
  readonly phase: string;
  readonly lines: readonly ReportLineV1[];
  /** Continue after this cursor; absent at the end. */
  readonly cursor?: string;
}

/** The cursor of the line after `seq`. */
const cursorAfter = (runId: string, seq: number): string => `r1.${runId}.${seq}`;

/** The line index a cursor of `runId` continues after; anything else is stale. */
function decodeCursor(runId: string, cursor: string | undefined): number {
  if (cursor === undefined) return -1;
  const match = /^r1\.([0-9a-f]{12})\.(\d{1,12})$/.exec(cursor);
  if (match === null || match[1] !== runId) throw new BatchCompileError("compile_batch_report_cursor_stale", "the report cursor was not issued for this run; restart the report without it");
  return Number(match[2]);
}

/** A bounded string field. */
const text = (value: unknown): boolean => typeof value === "string" && value.length <= MAX_KEY_CHARS;
/** An optional bounded string field. */
const optionalText = (value: unknown): boolean => value === undefined || text(value);

/** The closed shape of each report line kind: its exact fields and their checks. */
const LINE_SHAPES: Readonly<Record<string, { readonly keys: string; readonly check: (line: Record<string, unknown>) => boolean }>> = {
  compiled: { keys: "file,kind", check: (line) => text(line.file) },
  deleted: { keys: "file,kind", check: (line) => text(line.file) },
  page: { keys: "created,kind,slug", check: (line) => text(line.slug) && typeof line.created === "boolean" },
  seed: { keys: "created,kind,slug", check: (line) => text(line.slug) && typeof line.created === "boolean" },
};

/** Whether `line` is a closed, bounded error line. */
function isErrorLine(line: Record<string, unknown>): boolean {
  const message = typeof line.message === "string" && line.message.length <= MAX_REPORT_LINE_MESSAGE_CHARS;
  return message && Object.keys(line).every((key) => ["kind", "message", "slug", "file"].includes(key)) && optionalText(line.slug) && optionalText(line.file);
}

/** Whether `value` is a closed, bounded report line (as {@link report} writes one). */
function isReportLine(value: unknown): value is ReportLineV1 {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const line = value as Record<string, unknown>;
  if (line.kind === "error") return isErrorLine(line);
  const shape = typeof line.kind === "string" && Object.hasOwn(LINE_SHAPES, line.kind) ? LINE_SHAPES[line.kind]! : null;
  return shape !== null && Object.keys(line).sort().join() === shape.keys && shape.check(line);
}

/** A persisted line, or a typed refusal: a malformed or oversized row is never returned. */
function checkedLine(value: unknown, runId: string): ReportLineV1 {
  if (!isReportLine(value)) throw new BatchCompileError("compile_batch_run_unknown", `batch compile run ${runId} has a malformed report line; inspect .llmwiki/indexed/crun-${runId} by hand`);
  return value;
}

/** Read one page of run `runId`'s report of the project at `root` (read-only; through `io` for an archived run store). */
export async function readReport(root: string, runId: string, cursor?: string, io?: SegmentStoreIo): Promise<ReportPageV1> {
  const run = await BatchRun.open(root, runId, io);
  const after = decodeCursor(runId, cursor);
  const lines: ReportLineV1[] = [];
  let last = after;
  let bytes = 0;
  for await (const row of run.scan("r:", seqKey("r:", after + 1))) {
    const line = checkedLine(row.v, runId);
    const size = Buffer.byteLength(JSON.stringify(line));
    if (lines.length >= REPORT_PAGE_LINES || (lines.length > 0 && bytes + size > REPORT_PAGE_BYTES)) return { runId, phase: run.meta.phase, lines, cursor: cursorAfter(runId, last) };
    lines.push(line);
    bytes += size;
    last = keySeq("r:", row.k);
  }
  return { runId, phase: run.meta.phase, lines };
}
