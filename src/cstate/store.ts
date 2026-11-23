/**
 * @file src/cstate/store.ts
 * @description Reads and writes of the segmented compile state
 * (`./contracts.ts`).
 *
 * - {@link materializeCompileState} is the CAPPED compatibility read: the
 *   whole `WikiState` the incumbent `readState` returns, for the already
 *   global commands (status, lint, export, the viewer, the incumbent compile
 *   body). Sources come in their INSERTION order (the order index), each an
 *   own property; the frozen list in its stored order (the frozen-order index). Every materialized
 *   entry (key, value, and the typed mirror a version 2 read re-derives) is
 *   charged before it is retained; beyond `MAX_STATE_MATERIALIZE_BYTES` the
 *   read refuses (`compile_state_too_large`) instead of growing.
 * - {@link commitWholeState} is the compatibility WRITE of a whole state: it
 *   gives each source its ordinal (a source keeps its own while its relative
 *   order is unchanged; a new or moved one takes the next), diffs the rows
 *   against the stored ones and publishes only the changed source, order,
 *   owner and frozen rows (and the meta) in ONE conditional commit, under
 *   the caller's project lock. A state with fields this store cannot hold,
 *   an unkeyable source, or an invalid state is refused before any write.
 * - Every write first checks that `state.json` (the legacy backup) still has
 *   its imported stamp; a changed backup refuses (`compile_state_legacy_changed`).
 */

import { isDeepStrictEqual } from "node:util";
import { legacyUnchanged } from "../history/contracts.js";
import { newCounters, type IoCounters } from "../segments/counters.js";
import { sortedByKey, type SegmentRow } from "../segments/contracts.js";
import { diskSegmentStoreIo } from "../segments/io.js";
import { SegmentStore } from "../segments/store.js";
import { classifyStateText, syncEntityMirror } from "../utils/state-shape.js";
import type { SourceState, WikiState } from "../utils/types.js";
import {
  compileStateMetaOf, CompileStateError, CSTATE_STORE, FROZEN_ORDER_PREFIX, frozenOrderKey, FROZEN_PREFIX, frozenKey, isRepresentableSourceKey, MAX_STATE_MATERIALIZE_BYTES, ORDER_PREFIX, ORDINAL_LIMIT,
  orderKey, OWNER_PREFIX, ownerKey, SOURCE_PREFIX, sourceKey, type CompileStateMeta, type SourceRowV1,
} from "./contracts.js";

/** The bytes a typed-mirror entry adds beyond its slug: `"concepts/` + `",`. */
const MIRROR_ENTRY_OVERHEAD = 13;
/** The top-level fields of a state this store holds (the typed frozen mirror is re-derived). */
const HELD_STATE_KEYS = new Set(["version", "indexHash", "sources", "frozenSlugs", "frozenEntities", "promptModifiers"]);
/** Every row namespace of the store, in key order. */
const ROW_PREFIXES = [OWNER_PREFIX, FROZEN_ORDER_PREFIX, ORDER_PREFIX, SOURCE_PREFIX, FROZEN_PREFIX];

/** Open the compile state of the project at `root`. */
export function openCompileState(root: string, counters?: IoCounters): Promise<SegmentStore> {
  return SegmentStore.open(diskSegmentStoreIo(root, CSTATE_STORE), counters === undefined ? {} : { counters });
}

/** The whole state the rows and `meta` describe, without the typed mirror. */
function stateOf(meta: CompileStateMeta, sources: Record<string, SourceState>, frozen: string[]): WikiState {
  return {
    version: meta.version, indexHash: meta.indexHash, sources,
    ...(meta.frozenPresent ? { frozenSlugs: frozen } : {}),
    ...(meta.promptModifiers === null ? {} : { promptModifiers: meta.promptModifiers }),
  };
}

/** The bytes one materialized entry costs: its key and value, and (version 2) the typed mirror the read re-derives from its slugs. */
function entryCost(key: string, value: unknown, slugs: readonly string[], mirrored: boolean): number {
  const mirror = mirrored ? slugs.reduce((sum, slug) => sum + Buffer.byteLength(slug) + MIRROR_ENTRY_OVERHEAD, 0) : 0;
  return Buffer.byteLength(key) + Buffer.byteLength(JSON.stringify(value) ?? "") + mirror;
}

/** A materialization's running byte budget: refuses BEFORE the entry that would pass the cap is retained. */
class MaterializeBudget {
  private bytes: number;

  constructor(meta: CompileStateMeta) {
    this.bytes = Buffer.byteLength(JSON.stringify({ ...meta, legacy: undefined }));
  }

  /** Charge one entry. */
  charge(cost: number): void {
    this.bytes += cost;
    if (this.bytes > MAX_STATE_MATERIALIZE_BYTES) throw new CompileStateError("compile_state_too_large", `the compile state exceeds the ${MAX_STATE_MATERIALIZE_BYTES}-byte compatibility read cap; whole-state reads are refused beyond it (a batch compile reads it row by row)`);
  }
}

/** The source row of `file`; a missing or malformed one is unavailable. */
async function sourceRowOf(store: SegmentStore, file: string): Promise<SourceRowV1<SourceState>> {
  const row = (await store.get(sourceKey(file))) as SourceRowV1<SourceState> | undefined;
  if (row === undefined) throw new CompileStateError("compile_state_unavailable", `the order index names ${file.slice(0, 80)}, which has no source row`);
  return row;
}

/** Materialize the whole compile state of `root` (the capped compatibility read). */
export async function materializeCompileState(root: string): Promise<WikiState> {
  const store = await openCompileState(root);
  const meta = compileStateMetaOf(store);
  const budget = new MaterializeBudget(meta);
  const mirrored = meta.version === 2;
  const sources: Record<string, SourceState> = {};
  for await (const row of store.scan({ prefix: ORDER_PREFIX })) {
    const file = row.v as string;
    const entry = (await sourceRowOf(store, file)).v;
    budget.charge(entryCost(file, entry, entry.concepts ?? [], mirrored));
    // An own property even for an unusual key, which plain assignment could turn into a prototype change.
    Object.defineProperty(sources, file, { value: entry, enumerable: true, writable: true, configurable: true });
  }
  const frozen: string[] = [];
  for await (const row of store.scan({ prefix: FROZEN_ORDER_PREFIX })) {
    const slug = row.v as string;
    budget.charge(entryCost(row.k, slug, [slug], mirrored));
    frozen.push(slug);
  }
  return syncEntityMirror(stateOf(meta, sources, frozen));
}

/** Refuse a state this store cannot hold exactly, or one the incumbent reader would not accept. */
export function assertHoldable(state: WikiState): void {
  const extra = Object.keys(state).filter((key) => !HELD_STATE_KEYS.has(key));
  if (extra.length > 0) throw new CompileStateError("compile_state_unavailable", `the compile state carries fields the segmented store does not hold (${extra.slice(0, 5).join(", ")}); nothing was written`);
  if (classifyStateText(JSON.stringify(state)).status !== "ok") throw new CompileStateError("compile_state_unavailable", "the compile state to write is not a valid state; nothing was written");
  const unkeyable = Object.keys(state.sources).find((file) => !isRepresentableSourceKey(file));
  if (unkeyable !== undefined) throw new CompileStateError("compile_state_unavailable", `source ${JSON.stringify(unkeyable.slice(0, 80))} cannot key a segmented compile-state row (an absolute, empty, \`.\`/\`..\`, backslash, NUL-bearing or \`__proto__\` path); nothing was written`);
}

/**
 * The ordinal of each source of `state`, in its insertion order: a source
 * keeps its `stored` ordinal while that stays above the previous source's,
 * otherwise (new, or moved earlier) it takes the next free one.
 */
export function ordinalsOf(state: WikiState, stored: ReadonlyMap<string, number>, nextOrdinal: number): { ordinals: Map<string, number>; nextOrdinal: number } {
  const ordinals = new Map<string, number>();
  let next = nextOrdinal;
  let previous = -1;
  for (const file of Object.keys(state.sources)) {
    const kept = stored.get(file);
    const ordinal = kept !== undefined && kept > previous ? kept : next++;
    ordinals.set(file, ordinal);
    previous = ordinal;
  }
  if (next > ORDINAL_LIMIT) throw new CompileStateError("compile_state_unavailable", `the compile state's source ordinals would pass ${ORDINAL_LIMIT}; nothing was written`);
  return { ordinals, nextOrdinal: next };
}

/** Every row of a whole state with its `ordinals`: sources, order, owners and frozen slugs (unsorted). */
export function rowsOfState(state: WikiState, ordinals: ReadonlyMap<string, number>): Map<string, unknown> {
  const rows = new Map<string, unknown>();
  for (const [file, entry] of Object.entries(state.sources)) {
    const ordinal = ordinals.get(file)!;
    rows.set(sourceKey(file), { o: ordinal, v: entry });
    rows.set(orderKey(ordinal), file);
    for (const slug of new Set(entry.concepts)) rows.set(ownerKey(slug, ordinal), file);
  }
  [...new Set(state.frozenSlugs ?? [])].forEach((slug, at) => {
    rows.set(frozenKey(slug), at);
    rows.set(frozenOrderKey(at), slug);
  });
  return rows;
}

/** The meta of `state` with its row counts, binding `legacy`. */
export function metaOfState(state: WikiState, rows: ReadonlyMap<string, unknown>, nextOrdinal: number, legacy: CompileStateMeta["legacy"], lastRun: string | null = null): CompileStateMeta {
  const counts = { [SOURCE_PREFIX]: 0, [OWNER_PREFIX]: 0, [FROZEN_PREFIX]: 0, [ORDER_PREFIX]: 0, [FROZEN_ORDER_PREFIX]: 0 };
  for (const key of rows.keys()) counts[key.slice(0, 2) as keyof typeof counts] += 1;
  return {
    schema: 1, version: state.version, indexHash: state.indexHash, promptModifiers: state.promptModifiers ?? null, frozenPresent: state.frozenSlugs !== undefined,
    sources: counts[SOURCE_PREFIX], owners: counts[OWNER_PREFIX], frozen: counts[FROZEN_PREFIX], nextOrdinal, lastRun, legacy,
  };
}

/** The stored ordinal of every source. */
async function storedOrdinals(store: SegmentStore): Promise<Map<string, number>> {
  const ordinals = new Map<string, number>();
  for await (const row of store.scan({ prefix: SOURCE_PREFIX })) ordinals.set(row.k.slice(SOURCE_PREFIX.length), (row.v as SourceRowV1).o);
  return ordinals;
}

/** The puts and tombstones that turn the stored rows into `next`. */
async function diffRows(store: SegmentStore, next: ReadonlyMap<string, unknown>): Promise<SegmentRow[]> {
  const changes: SegmentRow[] = [];
  const seen = new Set<string>();
  for (const prefix of ROW_PREFIXES) {
    for await (const row of store.scan({ prefix })) {
      seen.add(row.k);
      if (!next.has(row.k)) changes.push({ k: row.k, d: 1 });
      else if (!isDeepStrictEqual(next.get(row.k), row.v)) changes.push({ k: row.k, v: next.get(row.k) });
    }
  }
  for (const [k, v] of next) if (!seen.has(k)) changes.push({ k, v });
  return sortedByKey(changes);
}

/** Refuse a write once `state.json`, the legacy backup, changed after the import. */
export async function assertLegacyUnchanged(root: string, meta: CompileStateMeta): Promise<void> {
  if (!(await legacyUnchanged(root, meta.legacy, newCounters()))) {
    throw new CompileStateError("compile_state_legacy_changed", `${meta.legacy.relPath} changed after it was imported into the segmented compile state (an older binary or an external edit wrote it); it is never merged or read as a fallback; restore it from a backup to continue`);
  }
}

/** Write the whole state `next` as the diff of its rows, in one conditional commit (call under the project lock). */
export async function commitWholeState(root: string, next: WikiState): Promise<void> {
  assertHoldable(next);
  const store = await openCompileState(root);
  const meta = compileStateMetaOf(store);
  await assertLegacyUnchanged(root, meta);
  const { ordinals, nextOrdinal } = ordinalsOf(next, await storedOrdinals(store), meta.nextOrdinal);
  const rows = rowsOfState(next, ordinals);
  const nextMeta = metaOfState(next, rows, nextOrdinal, meta.legacy, meta.lastRun);
  const changes = await diffRows(store, rows);
  if (changes.length === 0 && isDeepStrictEqual(nextMeta, meta)) return;
  await store.commit({ rows: changes, meta: { ...nextMeta } });
}
