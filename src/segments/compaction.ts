/**
 * @file src/segments/compaction.ts
 * @description Which runs a commit merges, and the merge itself.
 *
 * Only AGE-CONTIGUOUS runs are ever merged, so newest-wins stays correct: a
 * merged run takes the place of its inputs in the age order. Two rules:
 *
 * 1. TIER: when the newest {@link MERGE_FANOUT} runs share a size tier
 *    (`floor(log_FANOUT(rows))`), merge them. Steady small appends therefore
 *    cost about `log_FANOUT(N)` rewrites per row.
 * 2. CAP: while more than {@link MAX_RUNS} runs remain, merge the adjacent pair
 *    with the fewest rows, which bounds how many runs a read must consult.
 *
 * A merge that includes the OLDEST run drops tombstones (nothing older can
 * still hold the key); otherwise tombstones are kept. Merged inputs are not
 * deleted: they stay on disk as retained, unreferenced history.
 */

import { MAX_RUNS, MERGE_FANOUT, type RunEntry } from "./contracts.js";
import { mergeRuns } from "./merge.js";
import { runRows } from "./reader.js";
import { writeRun, type RunTarget } from "./run-writer.js";

/** The size tier of a run. */
function tier(rows: number): number {
  return Math.floor(Math.log(Math.max(1, rows)) / Math.log(MERGE_FANOUT));
}

/** The `[start, end)` slice of runs to merge next, or `null` when the store is compact enough. */
function nextMerge(runs: readonly RunEntry[]): [number, number] | null {
  if (runs.length >= MERGE_FANOUT) {
    const newest = runs.slice(-MERGE_FANOUT);
    if (newest.every((run) => tier(run.rows) === tier(newest[0]!.rows))) return [runs.length - MERGE_FANOUT, runs.length];
  }
  if (runs.length <= MAX_RUNS) return null;
  let best = 0;
  for (let at = 1; at < runs.length - 1; at += 1) {
    if (runs[at]!.rows + runs[at + 1]!.rows < runs[best]!.rows + runs[best + 1]!.rows) best = at;
  }
  return [best, best + 2];
}

/** What a merge needs beyond the runs: where to write, and the next run id to use. */
export interface MergeContext {
  readonly target: Omit<RunTarget, "runId">;
  nextRunId: number;
}

/** Merge `runs[start, end)` into one new run (or none, when only tombstones remained). */
async function mergeSlice(context: MergeContext, runs: readonly RunEntry[], start: number, end: number): Promise<RunEntry[]> {
  const group = runs.slice(start, end);
  const inputs = group.map((run) => runRows(context.target.io, run, {}, context.target.counters));
  const runId = context.nextRunId;
  context.nextRunId += 1;
  const merged = await writeRun({ ...context.target, runId }, mergeRuns(inputs, start !== 0));
  return [...runs.slice(0, start), ...(merged === null ? [] : [merged]), ...runs.slice(end)];
}

/** Apply both rules until neither fires. Returns the compacted run list. */
export async function compactRuns(context: MergeContext, runs: readonly RunEntry[]): Promise<RunEntry[]> {
  let current = [...runs];
  for (let slice = nextMerge(current); slice !== null; slice = nextMerge(current)) {
    current = await mergeSlice(context, current, slice[0], slice[1]);
  }
  return current;
}
