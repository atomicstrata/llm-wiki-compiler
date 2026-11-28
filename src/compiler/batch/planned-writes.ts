/**
 * @file src/compiler/batch/planned-writes.ts
 * @description TWO-PHASE page rewrites of a batch compile (resolution and
 * repair): every rewrite is first PLANNED from the pages' original bytes into
 * run rows (`<ns>w:<seq>` → the page's namespace, slug and exact new
 * content), with no page written; only then are the planned bytes APPLIED in
 * byte-bounded journalled batches. A crash while planning leaves every page
 * as it was, so the plan is redone from the same originals; a crash while
 * applying replays the same planned bytes from the last checkpoint, so a
 * replay can never re-plan from a page it already rewrote.
 */

import type { CompilePageNamespace } from "../compile-write.js";
import { keySeq, seqKey } from "./contracts.js";
import { PageWriteBatcher } from "./page-writes.js";
import type { BatchRun } from "./run-store.js";

/** One planned rewrite. */
export interface PlannedRewriteV1 { readonly namespace: CompilePageNamespace; readonly slug: string; readonly content: string }

/** Record planned rewrite number `seq` under `ns`. */
export async function planRewrite(run: BatchRun, ns: string, seq: number, rewrite: PlannedRewriteV1): Promise<void> {
  await run.put(seqKey(`${ns}w:`, seq), rewrite);
}

/**
 * Apply every rewrite planned under `ns` after the cursor's `applied`, in
 * batches; `counted` is told how many each batch wrote. The cursor key
 * `applied` is checkpointed after each batch.
 */
export async function applyPlannedRewrites(run: BatchRun, ns: string, counted: (written: number) => void): Promise<void> {
  const batcher = new PageWriteBatcher(run.root, async (applied) => counted(applied.length));
  let since = 0;
  const after = (run.meta.cursor.applied as number | undefined) ?? -1;
  for await (const row of run.scan(`${ns}w:`, seqKey(`${ns}w:`, after + 1))) {
    const rewrite = row.v as PlannedRewriteV1;
    await batcher.add({ namespace: rewrite.namespace, slug: rewrite.slug, body: rewrite.content });
    if ((since += 1) < run.meta.batchSize) continue;
    await batcher.flush();
    await run.checkpoint({ cursor: { ...run.meta.cursor, applied: keySeq(`${ns}w:`, row.k) } });
    since = 0;
  }
  await batcher.flush();
}
