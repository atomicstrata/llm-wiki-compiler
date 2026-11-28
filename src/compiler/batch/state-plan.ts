/**
 * @file src/compiler/batch/state-plan.ts
 * @description The PLAN-STATE and ORPHAN-FROZEN phases of a batch compile:
 * what the incumbent does to its draft after generation, before seeds,
 * decided over run rows and the compile state with bounded memory. Nothing
 * here writes the compile state (state-finalize publishes it, last).
 *
 * NEXT ENTRIES (`ns:<file>`), the incumbent `persistExtractionStates`: every
 * fresh (not reused) extraction with concepts records its hash, its concepts
 * that are LIVE (written this run, or retained: a reconciliation or frozen
 * slug not rewritten) in concept order, a new `compiledAt`, and its
 * extraction snapshot only when every concept it extracted was written.
 * (Failed extractions' entries come from the freeze phase; deleted sources
 * are removed.)
 *
 * FINAL OWNERS. A slug's owners after this run: its old owners whose next
 * entry still lists it (or that the run leaves unchanged), and the sources
 * whose new entry lists it.
 *
 * ORPHAN-FROZEN, the incumbent `orphanUnownedFrozenPages`: every
 * reconciliation slug, then every frozen slug, that no final owner holds is orphaned (byte-bounded journalled batches; idempotent on replay); then,
 * beyond the incumbent, every slug inherited from a superseded run's partial
 * publication (`ih:`) that no final owner holds AND whose page is still
 * exactly that run's output (a recorded digest; a manual or foreign page is
 * left alone). Inherited slugs never join the frozen list.
 *
 * REMAINING FROZEN (`nf:<pos>`), the incumbent `persistFrozenSlugs`: a frozen
 * slug stays unless every final owner extracted successfully this run and
 * some extraction yielded it; a reconciliation slug stays unless its page was
 * written. The list REPLACES the frozen list at state-finalize.
 */

import { CONCEPTS_DIR } from "../../utils/constants.js";
import { slugify } from "../../utils/markdown.js";
import type { SourceState } from "../../utils/types.js";
import { snapshotExtraction } from "../extraction-snapshot.js";
import { localOrphanPassSteps, orphanPage } from "../orphan.js";
import { contributionsPrefix, parseContributionKey, seqKey } from "./contracts.js";
import type { ExtractionRowV1 } from "./extract.js";
import type { NextSourceV1 } from "./freeze.js";
import { isFailedExtraction } from "./extraction-outcome.js";
import type { GeneratedPageV1 } from "./generate.js";
import { PageWriteBatcher } from "./page-writes.js";
import { pageDigest, parseInheritedKey } from "./inherit.js";
import { readPageBounded } from "./pages.js";
import type { BatchRun } from "./run-store.js";
import type { StateSnapshot } from "./state-reads.js";

/** Whether this run wrote `slug`'s page. */
async function written(run: BatchRun, slug: string): Promise<boolean> {
  return ((await run.get(`gr:${slug}`)) as GeneratedPageV1 | undefined)?.written === true;
}

/** Whether `slug` rebuilds cleanly: a reconciliation slug. */
async function pendingRebuild(run: BatchRun, slug: string): Promise<boolean> {
  return (await run.get(`rs:${slug}`)) !== undefined;
}

/** Whether `slug` is retained: a clean-rebuild or frozen slug this run did not rewrite. */
async function retained(run: BatchRun, slug: string): Promise<boolean> {
  return ((await pendingRebuild(run, slug)) || (await run.get(`fz:${slug}`)) !== undefined) && !(await written(run, slug));
}

/** The next entry of one fresh extraction (the incumbent `persistExtractionStates` plus `withExtractionSnapshot`). */
async function nextEntry(run: BatchRun, state: StateSnapshot, extraction: ExtractionRowV1): Promise<SourceState> {
  const slugs = extraction.concepts.map((concept) => slugify(concept.concept));
  const live: string[] = [];
  let allWritten = true;
  for (const slug of slugs) {
    const isWritten = await written(run, slug);
    allWritten = allWritten && isWritten;
    if (isWritten || (await retained(run, slug))) live.push(slug);
  }
  const entry: SourceState = { hash: extraction.hash, concepts: live, compiledAt: new Date().toISOString() };
  if (!allWritten || slugs.length === 0) return entry;
  return { ...entry, extraction: { ...snapshotExtraction("", extraction.concepts), sourceHash: extraction.hash } };
}

/** The next entries of every fresh extraction, after the cursor. */
async function planEntries(run: BatchRun, state: StateSnapshot): Promise<void> {
  for await (const row of run.scan("x:", seqKey("x:", (run.meta.cursor.after as number) + 1))) {
    const extraction = row.v as ExtractionRowV1;
    if (extraction.reused || isFailedExtraction(extraction)) continue;
    await run.put(`ns:${extraction.file}`, { kind: "set", entry: await nextEntry(run, state, extraction) } satisfies NextSourceV1);
    run.counters.sourcesAdvanced += 1;
  }
  for await (const row of run.scan("d:")) {
    const detected = row.v as { file: string; scoped: string };
    if (detected.scoped === "deleted" && (await run.get(`dr:${detected.file}`)) !== undefined && (await state.source(detected.file)) !== undefined) {
      await run.put(`ns:${detected.file}`, { kind: "remove" } satisfies NextSourceV1);
    }
  }
}

/** Whether `file`'s final entry lists `slug` (its next entry, else its unchanged entry). */
async function finallyOwns(run: BatchRun, state: StateSnapshot, file: string, slug: string): Promise<boolean> {
  const next = (await run.get(`ns:${file}`)) as NextSourceV1 | undefined;
  if (next !== undefined) return next.kind === "set" && next.entry.concepts.includes(slug);
  return ((await state.source(file))?.concepts ?? []).includes(slug);
}

/** Every final owner of `slug` (old owners still holding it, then new owners), each once. */
async function* finalOwners(run: BatchRun, state: StateSnapshot, slug: string): AsyncGenerator<string> {
  for await (const owner of state.owners(slug)) if (await finallyOwns(run, state, owner, slug)) yield owner;
  for await (const row of run.scan(contributionsPrefix(slug))) {
    const { seq, idx } = parseContributionKey(row.k);
    const extraction = (await run.get(seqKey("x:", seq))) as ExtractionRowV1;
    // Old owners were yielded above; a source with several contributions of `slug` is yielded at its first.
    if (((await state.source(extraction.file))?.concepts ?? []).includes(slug)) continue;
    if (idx !== extraction.concepts.findIndex((concept) => slugify(concept.concept) === slug)) continue;
    if (await finallyOwns(run, state, extraction.file, slug)) yield extraction.file;
  }
}

/** Whether `file` extracted successfully this run (fresh or reused, with concepts). */
async function compiledThisRun(run: BatchRun, file: string): Promise<boolean> {
  const seq = (await run.get(`xf:${file}`)) as number | undefined;
  return seq !== undefined && ((await run.get(seqKey("x:", seq))) as ExtractionRowV1).concepts.length > 0;
}

/** Whether frozen `slug` stays frozen (the incumbent unfreeze rule). */
async function staysFrozen(run: BatchRun, state: StateSnapshot, slug: string): Promise<boolean> {
  let owners = 0;
  for await (const owner of finalOwners(run, state, slug)) {
    owners += 1;
    if (!(await compiledThisRun(run, owner))) return true;
  }
  let extracted = false;
  for await (const _row of run.scan(contributionsPrefix(slug))) { extracted = true; break; }
  return owners === 0 || !extracted;
}

/** The remaining frozen list: frozen slugs that stay, then reconciliation slugs not rewritten. */
async function planFrozen(run: BatchRun, state: StateSnapshot): Promise<void> {
  let position = 0;
  const keep = async (slug: string): Promise<void> => {
    if ((await run.get(`nfs:${slug}`)) !== undefined) return;
    await run.put(`nfs:${slug}`, position);
    await run.put(seqKey("nf:", position++), slug);
  };
  for await (const row of run.scan("fzo:")) if (await staysFrozen(run, state, row.v as string)) await keep(row.v as string);
  for await (const row of run.scan("rso:")) if (!(await written(run, row.v as string))) await keep(row.v as string);
}

/** The plan-state phase (no effect; one checkpoint). */
export async function runStatePlan(run: BatchRun, state: StateSnapshot): Promise<void> {
  await planEntries(run, state);
  await planFrozen(run, state);
  await run.advance("orphan-frozen");
}

/** Whether `slug`'s page is still exactly the content a superseded run recorded as `digest` (a bounded read). */
async function stillInheritedOutput(run: BatchRun, slug: string, digest: string): Promise<boolean> {
  const read = await readPageBounded(run.root, CONCEPTS_DIR, slug);
  return "content" in read && pageDigest(read.content) === digest;
}

/** The orphan-frozen phase: reconciliation then frozen slugs no final owner holds are orphaned. */
export async function runOrphanFrozen(run: BatchRun, state: StateSnapshot): Promise<void> {
  const steps = { ...localOrphanPassSteps, readPage: readPageBounded };
  const batcher = new PageWriteBatcher(run.root, async (applied) => { run.counters.orphaned += applied.length; });
  const visit = async (slug: string): Promise<void> => {
    if ((await run.get(`ofv:${slug}`)) !== undefined) return;
    await run.put(`ofv:${slug}`, 1);
    for await (const _owner of finalOwners(run, state, slug)) return;
    const write = await orphanPage(steps, run.root, slug, "no remaining sources");
    if (write) await batcher.add(write);
  };
  for await (const row of run.scan("rso:")) await visit(row.v as string);
  for await (const row of run.scan("fzo:")) await visit(row.v as string);
  // Pages a superseded run published that no source owns now, only while still exactly its output (`./inherit.ts`).
  for await (const row of run.scan("ih:")) {
    const { slug, digest } = parseInheritedKey(row.k);
    if (await stillInheritedOutput(run, slug, digest)) await visit(slug);
  }
  await batcher.flush();
  await run.advance("seeds");
}
