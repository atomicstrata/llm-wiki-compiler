/**
 * @file src/compiler/batch/state-finalize.ts
 * @description The STATE-FINALIZE phase of a batch compile: the incumbent's
 * SINGLE state flush, after resolution and repair, as ONE conditional commit
 * of the segmented compile state.
 *
 * CHANGES. Every compile-state row the run changes is first spilled as
 * `cs:<cstate key>` (a put or a deletion): each removed source's source,
 * order and owner rows; each rewritten source's entry (its ordinal kept) and
 * the owner rows its concept list gained or lost; each NEW source's rows at
 * the next free ordinals, in the incumbent insertion order (sources whose
 * extraction failed first, then the successful ones, each in extraction
 * order); and the frozen list replaced by the planned remaining list (the
 * incumbent's no-change route instead clears it, after orphaning, when it held
 * any). The meta records the prompt modifiers, the counts and this run.
 *
 * PUBLICATION. The spilled rows stream (in key order) into one commit, only
 * when the state is still the one the run started from; a state whose meta
 * names this run already carries the commit (a crash after it), so it is not
 * repeated. `state.json` must still be the untouched legacy backup.
 */

import { compileStateMetaOf, CompileStateError, FROZEN_ORDER_PREFIX, ORDINAL_LIMIT, FROZEN_PREFIX, frozenKey, frozenOrderKey, orderKey, ownerKey, sourceKey, type CompileStateMeta, type SourceRowV1 } from "../../cstate/contracts.js";
import { assertLegacyUnchanged, openCompileState } from "../../cstate/store.js";
import type { SegmentRow } from "../../segments/contracts.js";
import type { SourceState } from "../../utils/types.js";
import { promptModifiersDigest } from "../prompt-modifiers.js";
import { BatchCompileError } from "./contracts.js";
import type { ExtractionRowV1 } from "./extract.js";
import type { NextSourceV1 } from "./freeze.js";
import { isFailedExtraction } from "./extraction-outcome.js";
import { manifestDigest, type BatchRun } from "./run-store.js";
import type { StateSnapshot } from "./state-reads.js";

/** What the change rows did to the counts. */
interface Deltas { sources: number; owners: number; nextOrdinal: number }

/** Spill one change. */
const change = (run: BatchRun, key: string, value: unknown): Promise<void> => run.put(`cs:${key}`, value === undefined ? { d: 1 } : { v: value });

/** The changes of one source with a stored row. */
async function changeStored(run: BatchRun, file: string, old: SourceRowV1<SourceState>, next: NextSourceV1, deltas: Deltas): Promise<void> {
  const before = new Set(old.v.concepts);
  const after = new Set(next.kind === "set" ? next.entry.concepts : []);
  for (const slug of before) if (!after.has(slug)) { await change(run, ownerKey(slug, old.o), undefined); deltas.owners -= 1; }
  for (const slug of after) if (!before.has(slug)) { await change(run, ownerKey(slug, old.o), file); deltas.owners += 1; }
  if (next.kind === "remove") {
    await change(run, sourceKey(file), undefined);
    await change(run, orderKey(old.o), undefined);
    deltas.sources -= 1;
  } else {
    await change(run, sourceKey(file), { o: old.o, v: next.entry });
  }
}

/** The changes of one NEW source at the next free ordinal. */
async function changeNew(run: BatchRun, file: string, entry: SourceState, deltas: Deltas): Promise<void> {
  // Detection refused a run whose new sources could pass the limit; this keeps the store's invariant regardless.
  if (deltas.nextOrdinal >= ORDINAL_LIMIT) throw new CompileStateError("compile_state_unavailable", `the compile state's source ordinals would pass ${ORDINAL_LIMIT}; nothing was written`);
  const ordinal = deltas.nextOrdinal++;
  await change(run, sourceKey(file), { o: ordinal, v: entry });
  await change(run, orderKey(ordinal), file);
  for (const slug of new Set(entry.concepts)) { await change(run, ownerKey(slug, ordinal), file); deltas.owners += 1; }
  deltas.sources += 1;
}

/** Spill every source change: stored sources first, then new ones in incumbent insertion order. */
async function sourceChanges(run: BatchRun, state: StateSnapshot, deltas: Deltas): Promise<void> {
  for await (const row of run.scan("ns:")) {
    const file = row.k.slice("ns:".length);
    const old = (await state.store.get(sourceKey(file))) as SourceRowV1<SourceState> | undefined;
    if (old !== undefined) await changeStored(run, file, old, row.v as NextSourceV1, deltas);
  }
  for (const failed of [true, false]) {
    for await (const row of run.scan("x:")) {
      const extraction = row.v as ExtractionRowV1;
      if (isFailedExtraction(extraction) !== failed || (await state.source(extraction.file)) !== undefined) continue;
      const next = (await run.get(`ns:${extraction.file}`)) as NextSourceV1 | undefined;
      if (next?.kind === "set") await changeNew(run, extraction.file, next.entry, deltas);
    }
  }
}

/** Spill the frozen list's replacement; returns its length. */
async function frozenChanges(run: BatchRun, state: StateSnapshot, unchangedRoute: boolean): Promise<number> {
  for await (const row of state.store.scan({ prefix: FROZEN_PREFIX })) await change(run, row.k, undefined);
  for await (const row of state.store.scan({ prefix: FROZEN_ORDER_PREFIX })) await change(run, row.k, undefined);
  if (unchangedRoute) return 0;
  let position = 0;
  for await (const row of run.scan("nf:")) {
    await change(run, frozenKey(row.v as string), position);
    await change(run, frozenOrderKey(position++), row.v as string);
  }
  return position;
}

/** Whether the run takes the incumbent no-change route (nothing extracted, nothing deleted). */
async function unchangedRoute(run: BatchRun): Promise<boolean> {
  return run.counters.toExtract === 0 && run.counters.deleted === 0;
}

/** The next meta: the counts after the changes, the prompt modifiers, and this run. */
function nextMeta(meta: CompileStateMeta, deltas: Deltas, frozen: number, runId: string): CompileStateMeta {
  return {
    ...meta, promptModifiers: promptModifiersDigest(), frozenPresent: true, sources: meta.sources + deltas.sources, owners: meta.owners + deltas.owners,
    frozen, nextOrdinal: deltas.nextOrdinal, lastRun: runId,
  };
}

/** The spilled changes as compile-state rows, in key order. */
async function* changedRows(run: BatchRun): AsyncGenerator<SegmentRow> {
  for await (const row of run.scan("cs:")) {
    const value = row.v as { v?: unknown; d?: 1 };
    yield value.d === 1 ? { k: row.k.slice("cs:".length), d: 1 } : { k: row.k.slice("cs:".length), v: value.v };
  }
}

/** Whether the incumbent would flush at all: the changed route always; the no-change route only when it held frozen slugs. */
async function flushes(run: BatchRun, state: StateSnapshot): Promise<boolean> {
  return !(await unchangedRoute(run)) || state.meta.frozen > 0;
}

/** The state-finalize phase. */
export async function runStateFinalize(run: BatchRun, state: StateSnapshot): Promise<void> {
  const store = await openCompileState(run.root);
  const meta = compileStateMetaOf(store);
  if (meta.lastRun !== run.runId && (await flushes(run, state))) {
    if (manifestDigest(store) !== run.meta.identity.cstate) throw new BatchCompileError("compile_batch_inputs_changed", "the compile state changed while the batch compile ran; nothing more was written");
    await assertLegacyUnchanged(run.root, meta);
    const deltas: Deltas = { sources: 0, owners: 0, nextOrdinal: meta.nextOrdinal };
    await sourceChanges(run, state, deltas);
    const frozen = await frozenChanges(run, state, await unchangedRoute(run));
    await store.commit({ rows: changedRows(run), meta: { ...nextMeta(meta, deltas, frozen, run.runId) } });
  }
  await run.advance("residual", {});
}
