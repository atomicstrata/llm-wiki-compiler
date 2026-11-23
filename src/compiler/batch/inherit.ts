/**
 * @file src/compiler/batch/inherit.ts
 * @description What a new batch compile run INHERITS from the runs it
 * superseded: every concept page such a run may have PUBLISHED without
 * committing the compile state, with the exact content it would have
 * published, so the new run can orphan the ones no source owns any more (the
 * last contributors of a partially published page may be gone by the
 * restart; the new compile state never knew the page).
 *
 * EVIDENCE. Before a generation batch publishes its pages, the run durably
 * records one IMMUTABLE intent key per page and content,
 * `pi:<slug>\0<sha256 of the body>` (`./generate.ts`): an attempt that
 * regenerates a page adds its own key and never overwrites an earlier
 * attempt's, so even a kill between a publication and its checkpoint,
 * followed by another attempt that dies before publishing, leaves every
 * content that may be live on disk. The keys are read RAW (any version,
 * committed or not). A superseded run's own inherited keys (`ih:`) are carried
 * too, so a chain of restarts keeps every unreconciled page.
 *
 * PROOF BEFORE ORPHANING. An intent alone proves nothing: the kill may have
 * come before the write, or the page may have been replaced since. The
 * orphan-frozen phase orphans an inherited page only when its CURRENT content
 * (a bounded read) has one of the recorded digests, i.e. it is still exactly
 * a superseded run's output; a manual or foreign page at that path is left
 * as it is.
 *
 * WHICH RUNS. Every superseded run that started after the run that last
 * committed the compile state (all of them when none did, or when that run's
 * store is gone): a run that committed the state reconciled what came before.
 */

import { createHash } from "node:crypto";
import { compileStateMetaOf } from "../../cstate/contracts.js";
import { openCompileState } from "../../cstate/store.js";
import { BatchRun, runIds } from "./run-store.js";

/** The digest an intent records for a page body. */
export const pageDigest = (body: string): string => createHash("sha256").update(body).digest("hex");

/** The immutable intent key of publishing `digest` at `slug`. */
export const intentKey = (slug: string, digest: string): string => `pi:${slug}\0${digest}`;

/** The slug and digest of an intent (`pi:`) or inherited (`ih:`) key. */
export function parseInheritedKey(key: string): { slug: string; digest: string } {
  const at = key.lastIndexOf("\0");
  return { slug: key.slice(3, at), digest: key.slice(at + 1) };
}

/** When the run that last committed the compile state started, or `null` when unknown. */
async function committedCutoff(root: string): Promise<string | null> {
  const lastRun = compileStateMetaOf(await openCompileState(root)).lastRun;
  if (lastRun === null) return null;
  return BatchRun.open(root, lastRun).then((run) => run.meta.startedAt, () => null);
}

/** Spill into `run` every (slug, digest) a superseded, unreconciled run may have published. */
export async function inheritPublished(run: BatchRun): Promise<void> {
  const cutoff = await committedCutoff(run.root);
  for (const id of await runIds(run.root)) {
    if (id === run.runId) continue;
    const other: BatchRun = await BatchRun.open(run.root, id);
    if (other.meta.phase !== "superseded" || (cutoff !== null && other.meta.startedAt <= cutoff)) continue;
    for await (const key of other.keysEverWritten("pi:")) await run.put(`ih:${key.slice("pi:".length)}`, 1);
    for await (const row of other.scan("ih:")) await run.put(row.k, 1);
  }
}
