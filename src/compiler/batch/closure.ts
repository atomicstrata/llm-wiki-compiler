/**
 * @file src/compiler/batch/closure.ts
 * @description The CLOSURE phase of a batch compile: the incumbent
 * `findAffectedSources` and `findReconciliationSlugs`, over the run's rows
 * and the compile state, with bounded memory.
 *
 * AFFECTED OWNERS. The spilled shared-owner walk (`./bfs.ts`): its queue
 * starts with the excluded sources (the new and changed ones in detected
 * order, then the deleted ones) and the live owners of the frozen slugs (in
 * frozen order, each slug's owners in insertion order); excluded are the
 * sources compiled directly and every detected deletion.
 *
 * RECONCILIATION. The frozen slugs, then each deleted source's concepts that
 * a surviving (not deleted) source still owns, as `rs:<slug>` (ordered by
 * `rso:<seq>`).
 *
 * TO EXTRACT. `t:<seq>`: the new and changed sources in detected order, then
 * the affected ones in their order (the incumbent `toCompile`).
 */

import { seqKey } from "./contracts.js";
import { freshPosition, walkOwners, type WalkPosition } from "./bfs.js";
import type { DetectedRowV1 } from "./detect.js";
import type { BatchRun } from "./run-store.js";
import type { StateSnapshot } from "./state-reads.js";
import { report } from "./report.js";

/** A source to extract: its file, the round that scheduled it, and why. */
export interface ToExtractV1 { readonly file: string; readonly round: number; readonly kind: "direct" | "affected" | "late" }

/** The detected row of `file`, or `undefined` when it was not detected. */
export async function detectedOf(run: BatchRun, file: string): Promise<DetectedRowV1 | undefined> {
  const seq = (await run.get(`k:${file}`)) as number | undefined;
  return seq === undefined ? undefined : (await run.get(seqKey("d:", seq))) as DetectedRowV1;
}

/** Whether `row` is compiled directly this run. */
export const compiledDirectly = (row: DetectedRowV1 | undefined): boolean => row?.scoped === "new" || row?.scoped === "changed";

/** The pre-extraction walk: seeds are the excluded sources, then the frozen slugs' live owners. */
function affectedWalk(run: BatchRun, state: StateSnapshot): Parameters<typeof walkOwners>[2] {
  return {
    ns: "",
    excluded: async (file) => { const row = await detectedOf(run, file); return compiledDirectly(row) || row?.detected === "deleted"; },
    seed: async (queue, affect) => {
      for await (const row of run.scan("d:")) if (compiledDirectly(row.v as DetectedRowV1)) await queue((row.v as DetectedRowV1).file);
      for await (const row of run.scan("d:")) if ((row.v as DetectedRowV1).detected === "deleted") await queue((row.v as DetectedRowV1).file);
      for await (const slug of state.frozen()) for await (const owner of state.owners(slug)) await affect(owner);
    },
    save: (position) => run.checkpoint({ cursor: { walk: position } }),
  };
}

/** The reconciliation slugs: the frozen ones, then deleted sources' concepts a surviving source still owns. */
async function reconciliation(run: BatchRun, state: StateSnapshot): Promise<number> {
  let seq = 0;
  const add = async (slug: string): Promise<void> => {
    if ((await run.get(`rs:${slug}`)) !== undefined) return;
    await run.put(`rs:${slug}`, seq);
    await run.put(seqKey("rso:", seq++), slug);
  };
  for await (const slug of state.frozen()) await add(slug);
  for await (const row of run.scan("d:")) {
    const detected = row.v as DetectedRowV1;
    if (detected.scoped !== "deleted") continue;
    for (const slug of (await state.source(detected.file))?.concepts ?? []) if (await survivingOwner(run, state, slug)) await add(slug);
  }
  return seq;
}

/** Whether some owner of `slug` is not deleted this run. */
async function survivingOwner(run: BatchRun, state: StateSnapshot, slug: string): Promise<boolean> {
  for await (const owner of state.owners(slug)) if ((await detectedOf(run, owner))?.scoped !== "deleted") return true;
  return false;
}

/** The sources to extract, in incumbent order: direct, then affected. */
async function toExtract(run: BatchRun): Promise<number> {
  let seq = 0;
  const add = async (row: ToExtractV1): Promise<void> => {
    await run.put(seqKey("t:", seq++), row);
    await report(run, { kind: "compiled", file: row.file });
  };
  for await (const row of run.scan("d:")) if (compiledDirectly(row.v as DetectedRowV1)) await add({ file: (row.v as DetectedRowV1).file, round: 0, kind: "direct" });
  for await (const row of run.scan("a:")) await add({ file: row.v as string, round: 0, kind: "affected" });
  return seq;
}

/** The closure phase: affected owners, reconciliation slugs, and the sources to extract. */
export async function runClosure(run: BatchRun, state: StateSnapshot): Promise<void> {
  const position = (run.meta.cursor.walk as WalkPosition | undefined) ?? freshPosition();
  await walkOwners(run, state, affectedWalk(run, state), position);
  const reconciled = await reconciliation(run, state);
  run.counters.toExtract = await toExtract(run);
  // The incumbent `compiled` count is its toCompile list: direct and affected sources (late rounds are not counted).
  run.counters.compiled = run.counters.toExtract;
  await run.advance("orphan-deleted", { reconciled, after: -1 });
}
