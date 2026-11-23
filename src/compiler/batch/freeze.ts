/**
 * @file src/compiler/batch/freeze.ts
 * @description The FREEZE phase of a batch compile: the incumbent
 * `freezeFailedExtractions`, right after extraction.
 *
 * An extraction with no concepts is a failure that retries next run: every
 * slug its source owned is FROZEN for this run (`fz:<slug>`, ordered by
 * `fzo:<pos>`: not regenerated, not orphaned), and the source's next entry is
 * its old concepts with a blank hash (`ns:<file>`, applied at state-finalize).
 */

import * as output from "../../utils/output.js";
import { isFailedExtraction } from "./extraction-outcome.js";
import type { SourceState } from "../../utils/types.js";
import { keySeq, seqKey } from "./contracts.js";
import type { ExtractionRowV1 } from "./extract.js";
import type { BatchRun } from "./run-store.js";
import type { StateSnapshot } from "./state-reads.js";

/** A source's next entry, decided by the run and applied at state-finalize. */
export type NextSourceV1 = { readonly kind: "set"; readonly entry: SourceState } | { readonly kind: "remove" };

/** Freeze one slug (once, in order). */
async function freezeSlug(run: BatchRun, slug: string, position: { next: number }): Promise<void> {
  if ((await run.get(`fz:${slug}`)) !== undefined) return;
  await run.put(`fz:${slug}`, position.next);
  await run.put(seqKey("fzo:", position.next++), slug);
  output.status("i", output.dim(`Frozen: ${slug} (required source extraction failed)`));
}

/** The freeze phase, resumable after the last extraction it finished. */
export async function runFreeze(run: BatchRun, state: StateSnapshot): Promise<void> {
  const after = (run.meta.cursor.after as number | undefined) ?? -1;
  const position = { next: (run.meta.cursor.frozen as number | undefined) ?? 0 };
  for await (const row of run.scan("x:", seqKey("x:", after + 1))) {
    const extraction = row.v as ExtractionRowV1;
    if (!isFailedExtraction(extraction)) continue;
    output.status("!", output.warn(`${extraction.file}: no concepts — will retry.`));
    const old = (await state.source(extraction.file))?.concepts ?? [];
    for (const slug of old) await freezeSlug(run, slug, position);
    const next: NextSourceV1 = { kind: "set", entry: { hash: "", concepts: old, compiledAt: new Date().toISOString() } };
    await run.put(`ns:${extraction.file}`, next);
    await run.checkpoint({ cursor: { after: keySeq("x:", row.k), frozen: position.next } });
  }
  await run.advance("plan-generation");
}
