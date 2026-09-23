/**
 * @file src/utils/stage-timing.ts
 * @description Opt-in wall-clock timing for the coarse compile and query stages,
 * used to measure where time goes without an observability subsystem.
 *
 * Disabled unless `LLMWIKI_STAGE_TIMING_FILE` names an absolute path; when unset
 * the wrapped work runs directly with no timing and no I/O. When set, each stage
 * appends one JSON line: `{ v, stage, ms, ok, pid }`. Records carry only the fixed
 * stage name, the duration, whether the stage threw, and the process id, never
 * source text, page content, prompts, paths, or credentials, so the log is safe to
 * share. A failure to write the log never changes the command's outcome.
 *
 * The sink must be a regular file. It is opened without following a symlink and
 * with O_NONBLOCK, so a FIFO with no reader fails the open at once instead of
 * blocking a stage (and the project lock it runs under) forever; anything that is
 * not a regular file is skipped. New logs are created 0600; an existing file keeps
 * its own mode.
 */
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import { openFileNoFollow } from "./no-follow-open.js";
import { performance } from "node:perf_hooks";

/** The fixed set of stage names; the log never contains anything caller-supplied. */
export type TimedStage =
  | "compile.detect-changes"
  | "compile.extraction"
  | "compile.page-generation"
  | "compile.finalize"
  | "compile.embeddings"
  | "query.retrieval"
  | "query.answer";

const TIMING_FILE_ENV = "LLMWIKI_STAGE_TIMING_FILE";
const RECORD_VERSION = 1;
const SINK_FLAGS = fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_CREAT
  | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK;

/** The configured log path, or null when timing is off (unset, blank, or relative). */
function timingFile(): string | null {
  const configured = process.env[TIMING_FILE_ENV]?.trim();
  return configured && path.isAbsolute(configured) ? configured : null;
}

/** Append one record; timing is best-effort and must not fail the measured command. */
async function record(file: string, stage: TimedStage, ms: number, ok: boolean): Promise<void> {
  const line = JSON.stringify({ v: RECORD_VERSION, stage, ms: Math.round(ms * 1000) / 1000, ok, pid: process.pid });
  try {
    const handle = await openFileNoFollow(file, SINK_FLAGS, 0o600);
    try {
      if ((await handle.stat()).isFile()) await handle.appendFile(`${line}\n`);
    } finally {
      await handle.close();
    }
  } catch {
    // Deliberately silent: an unusable log path is not the measured command's concern.
  }
}

/**
 * Run `work` as one named stage. With timing off this is a plain `await work()`;
 * with timing on, the duration is recorded whether the stage resolves or throws,
 * and the original result or error is returned unchanged.
 */
export async function timeStage<T>(stage: TimedStage, work: () => Promise<T>): Promise<T> {
  const file = timingFile();
  if (file === null) return work();
  const started = performance.now();
  let ok = false;
  try {
    const result = await work();
    ok = true;
    return result;
  } finally {
    await record(file, stage, performance.now() - started, ok);
  }
}
