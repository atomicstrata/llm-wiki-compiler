/**
 * @file src/compiler/batch/deletions.ts
 * @description The ORPHAN-DELETED phase of a batch compile: the incumbent
 * `markDeletedAsOrphaned`, before any extraction, one deleted source at a
 * time in detected order.
 *
 * Exactly as the incumbent `markOrphaned` over its draft: a deleted source's
 * concept page is orphaned only when no OTHER source still in the draft owns
 * it. The draft forgets each deleted source after its pages are orphaned, so
 * a later deleted co-owner can be the last owner of a page an earlier one
 * kept; here the forgotten sources are `dr:<file>` rows and the owners come
 * from the compile state's owner index. Each source's orphan writes go
 * through the incumbent page step (`orphanPage`) in byte-bounded journalled
 * batches (`./page-writes.ts`), then its `dr:` row is checkpointed; a redo
 * re-plans the same writes and the page step skips pages already orphaned.
 */

import { localOrphanPassSteps, orphanPage } from "../orphan.js";
import { PageWriteBatcher } from "./page-writes.js";
import { readPageBounded } from "./pages.js";
import * as output from "../../utils/output.js";
import { keySeq, seqKey } from "./contracts.js";
import type { DetectedRowV1 } from "./detect.js";
import type { BatchRun } from "./run-store.js";
import type { StateSnapshot } from "./state-reads.js";

/** The incumbent orphan page steps, with the page read bounded (`./pages.ts`). */
const BOUNDED_ORPHAN_STEPS = { ...localOrphanPassSteps, readPage: readPageBounded };

/** Whether `slug` has an owner other than `file` that the draft still holds (not a forgotten deleted source). */
async function sharedWithLiveOwner(run: BatchRun, state: StateSnapshot, slug: string, file: string): Promise<boolean> {
  for await (const owner of state.owners(slug)) {
    if (owner !== file && (await run.get(`dr:${owner}`)) === undefined) return true;
  }
  return false;
}

/** Orphan deleted source `file`'s solely owned pages, in byte-bounded journalled batches; returns how many were written. */
async function orphanSource(run: BatchRun, state: StateSnapshot, file: string): Promise<number> {
  let written = 0;
  const batcher = new PageWriteBatcher(run.root, async (applied) => { written += applied.length; });
  for (const slug of (await state.source(file))?.concepts ?? []) {
    if (await sharedWithLiveOwner(run, state, slug, file)) {
      output.status("i", output.dim(`Kept: ${slug}.md (shared with other sources)`));
      continue;
    }
    const write = await orphanPage(BOUNDED_ORPHAN_STEPS, run.root, slug, "source deleted");
    if (write) await batcher.add(write);
  }
  await batcher.flush();
  return written;
}

/** The orphan-deleted phase, resumable after the last deleted source it finished. */
export async function runDeletionOrphans(run: BatchRun, state: StateSnapshot): Promise<void> {
  const after = (run.meta.cursor.after as number | undefined) ?? -1;
  for await (const row of run.scan("d:", seqKey("d:", after + 1))) {
    const detected = row.v as DetectedRowV1;
    if (detected.scoped !== "deleted") continue;
    if ((await state.source(detected.file)) !== undefined) run.counters.orphaned += await orphanSource(run, state, detected.file);
    await run.put(`dr:${detected.file}`, 1);
    await run.checkpoint({ cursor: { ...run.meta.cursor, after: keySeq("d:", row.k) } });
  }
  await run.advance("extract", { after: -1, round: 0 });
}
