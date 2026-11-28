/**
 * @file src/catalog/sync.ts
 * @description Reconcile the catalog with the files: EXPLICIT O(files +
 * directories) maintenance, never run by a listing.
 *
 * Every catalogued tree is walked (each directory stamped BEFORE it is
 * listed, then names and file stamps), and the walk is merge-joined with the
 * catalog's own directory, page and source rows in key order. Only a new
 * file or one whose stamp changed is read and re-projected; a row whose file
 * or directory is gone is tombstoned (with a source's identity row).
 * Directory rows simply take their new stamp. Changes are committed in
 * batches, each a durable checkpoint published as `building` (first build)
 * or `reconciling` (any later run), so readers see an unfinished
 * reconciliation as such and a rerun resumes it: unchanged files are skipped
 * by stamp. Final counts are the rows that actually ended up present (a file
 * that vanished or became unreadable during the walk is not counted). A change
 * made during the walk shows as stale at the next read, because the
 * directory was stamped before it was listed. Callers hold the project lock.
 *
 * TYPED. For a custom profile (whose scale record carries the typed-catalog
 * capability) the declared entity directories are walked too, and each entity
 * file and directory row is projected by the incumbent collector
 * (`./entity-rows.ts`); the final facts carry the profile digest, a stable
 * catalog id and the entity totals.
 *
 * BOUNDED. A bounded caller (the batch compile) passes {@link SyncOptions}:
 * entity page bodies are read under its bound (`./entity-rows.ts`), and a
 * batch also commits BEFORE an entry whose rows would take the pending rows
 * past `maxBatchBytes` (as measured serialized), so a committed batch holds at
 * most max(maxBatchBytes, one entry's serialized rows). An entry's rows are
 * projections of bounded inputs (a catalog file read under its cap, an entity
 * page body under the caller's bound); the size of each row is validated only
 * by the segment commit itself. Without options every read and every commit
 * is the incumbent's.
 */

import { MAX_KEY_CHARS, sortedByKey, type SegmentRow } from "../segments/contracts.js";
import type { SegmentStore } from "../segments/store.js";
import { identityKey, parsePageKey, SAMPLE_SIZE, type CatalogMeta, type DirStamp, type FileStamp, type TypedCatalogMeta } from "./contracts.js";
import { randomBytes } from "node:crypto";
import { loadNonDefaultProfile } from "../profile/block.js";
import type { LoadedProfile } from "../profile/types.js";
import { ScaleGateError } from "../scale/gate.js";
import { asEntityDirRow, asEntityFileRow, entityDirKey, entityDirRow, entityFileRow, entityKey, entityTypes, isEntityDirKey, parseEntityKey, type EntityPageBound } from "./entity-rows.js";
import { readCatalogFile, sameStamp, walkCatalogFiles, type EntityWalkType, type WalkedEntry } from "./files.js";
import { typedCatalogStatus } from "./typed-admission.js";
import { catalogMetaOf } from "./meta.js";
import { asSourceRow, pageRowFrom, sourceRowFrom, stampOfRow } from "./rows.js";

/** Changed entries per durable checkpoint. */
const SYNC_BATCH_ENTRIES = 1024;

/** What a bounded caller adds to a reconciliation (see the file comment); the incumbent passes nothing. */
export interface SyncOptions {
  /** Read every entity page body under this bound. */
  readonly entityPageBound?: EntityPageBound;
  /** Commit before the pending rows would pass this many serialized bytes. */
  readonly maxBatchBytes?: number;
}

/** What a reconciliation did. */
export interface SyncResult {
  readonly store: SegmentStore;
  readonly reprojected: number;
  readonly removed: number;
  readonly uncatalogued: number;
}

/** Tombstones for a vanished row (and a source's identity row). */
function removalRows(key: string, old: unknown): SegmentRow[] {
  if (old === undefined) return [];
  if (!key.startsWith("s:")) return [{ k: key, d: 1 }];
  return [{ k: key, d: 1 }, { k: identityKey(asSourceRow(old, key).source, key.slice(2)), d: 1 }];
}

/** The rows of an entity key: projected by the incumbent collector (bodies under `bound` when given), or a tombstone when its file or directory is gone. */
async function entityRows(root: string, loaded: LoadedProfile | undefined, key: string, entry: WalkedEntry | undefined, old: unknown, bound?: EntityPageBound): Promise<SegmentRow[]> {
  if (entry === undefined || loaded === undefined || !loaded.profile.entities[parseEntityKey(key).type]) return removalRows(key, old);
  if (isEntityDirKey(key)) return [{ k: key, v: await entityDirRow(root, loaded, key, entry.stamp as DirStamp | null) }];
  if (entry.stamp === null) return removalRows(key, old);
  return [{ k: key, v: await entityFileRow(root, loaded, key, entry.stamp as FileStamp, bound) }];
}

/** The rows that bring `key` in line with `entry` (absent: removed), given its current row value. */
export async function reconcileRows(root: string, store: SegmentStore, key: string, entry: WalkedEntry | undefined, old: unknown, loaded?: LoadedProfile, bound?: EntityPageBound): Promise<SegmentRow[]> {
  if (key.startsWith("e:")) return entityRows(root, loaded, key, entry, old, bound);
  if (key.startsWith("d:")) return entry === undefined ? removalRows(key, old) : [{ k: key, v: entry.stamp }];
  const text = entry === undefined ? null : await readCatalogFile(root, entry.relPath, store.counters);
  if (text === null) return removalRows(key, old);
  const stamp = entry!.stamp as FileStamp;
  if (key.startsWith("p:")) {
    const { dir, slug } = parsePageKey(key);
    return [{ k: key, v: pageRowFrom(dir, slug, text, stamp) }];
  }
  const id = key.slice(2);
  const row = sourceRowFrom(id, text, stamp);
  const rows: SegmentRow[] = [{ k: key, v: row }, { k: identityKey(row.source, id), v: { id } }];
  const oldSource = old === undefined ? undefined : asSourceRow(old, key);
  if (oldSource !== undefined && oldSource.source !== row.source) rows.push({ k: identityKey(oldSource.source, id), d: 1 });
  return rows;
}

/** The catalog's facts after a completed reconciliation, counting the rows that actually ended up present. */
function finalMeta(counts: CatalogMeta["counts"], uncatalogued: UncataloguedTally, typed: TypedCatalogMeta | undefined): Record<string, unknown> {
  const meta: CatalogMeta = {
    schema: 1, phase: "ready", counts,
    uncatalogued: { count: uncatalogued.count, sample: uncatalogued.sample.slice(0, SAMPLE_SIZE).map((relPath) => relPath.slice(0, MAX_KEY_CHARS)) },
    ...(typed === undefined ? {} : { typed }),
  };
  return { ...meta };
}

/** Entity totals of one reconciliation: listed pages and collector problems. */
interface EntityTally { pages: number; problems: number }

/** Count an entity row that ended up present. */
function tallyEntity(tally: EntityTally, key: string, value: unknown): void {
  if (isEntityDirKey(key)) { tally.problems += asEntityDirRow(value, key).problems.length; return; }
  const row = asEntityFileRow(value, key);
  if (row.page !== null) tally.pages += 1;
  tally.problems += row.problems.length;
}

/**
 * The custom profile whose entity pages this reconciliation catalogues, or
 * undefined for the default profile. Typed rows are written ONLY when the
 * scale record carries the typed-catalog capability; without it a custom
 * profile refuses before any write.
 */
async function typedProfileOf(root: string): Promise<LoadedProfile | undefined> {
  const loaded = await loadNonDefaultProfile(root).catch(() => { throw new ScaleGateError("scale-profile-ineligible", "the effective profile cannot be loaded"); });
  if (loaded === undefined) return undefined;
  if ((await typedCatalogStatus(root)) === "absent") throw new ScaleGateError("scale-profile-ineligible", "the scale record does not carry the typed-entity-catalog-1 capability");
  return loaded;
}

/** The walk's entity types for `loaded`. */
function walkTypes(loaded: LoadedProfile | undefined): EntityWalkType[] {
  return loaded === undefined ? [] : entityTypes(loaded).map(([type, def]) => ({ type, relDir: def.directory, dirKey: entityDirKey(type), fileKey: (stem: string) => entityKey(type, stem) }));
}

/** The typed facts after a completed reconciliation: the catalog id is kept while the profile is unchanged. */
function typedMetaOf(store: SegmentStore, loaded: LoadedProfile | undefined, tally: EntityTally): TypedCatalogMeta | undefined {
  if (loaded === undefined) return undefined;
  const previous = catalogMetaOf(store).typed;
  const catalogId = previous !== undefined && previous.profileDigest === loaded.digest ? previous.catalogId : randomBytes(16).toString("hex");
  const directories = Object.fromEntries(entityTypes(loaded).map(([type, def]) => [type, def.directory]));
  return { profileDigest: loaded.digest, catalogId, pages: tally.pages, problems: tally.problems, directories };
}

/** The phase an unfinished checkpoint publishes: a first build stays `building`; any later run is `reconciling`. */
function checkpointMeta(store: SegmentStore): Record<string, unknown> {
  const meta = catalogMetaOf(store);
  return { ...meta, phase: meta.phase === "building" ? "building" : "reconciling" };
}

/** Count `key` into `counts` when its row ends up present. */
function tally(counts: { concepts: number; queries: number; sources: number }, key: string, present: boolean): void {
  if (!present || key.startsWith("d:")) return;
  counts[key.startsWith("s:") ? "sources" : key.startsWith("p:concepts/") ? "concepts" : "queries"] += 1;
}

/** Count one present row: entity rows into the entity totals, the others into the catalog counts. */
function countStep(counts: CatalogMeta["counts"] & Record<string, number>, entities: EntityTally, key: string, value: unknown, present = true): void {
  if (!present) return;
  if (key.startsWith("e:")) tallyEntity(entities, key, value);
  else tally(counts, key, true);
}

/** One step of the merge-join: the next key and what the walk and the catalog each hold for it. */
interface JoinStep { key: string; entry?: WalkedEntry; old?: unknown }

/** Merge-join the walk (in key order) with the catalog's directory, page and source rows (identity rows are derived). */
async function* joinWalk(entries: AsyncIterable<WalkedEntry>, store: SegmentStore): AsyncGenerator<JoinStep> {
  const walk = entries[Symbol.asyncIterator]();
  let next = await walk.next();
  for await (const row of store.scan({ from: "d:" })) {
    if (row.k.startsWith("i:")) continue;
    while (!next.done && next.value.key < row.k) { yield { key: next.value.key, entry: next.value }; next = await walk.next(); }
    if (!next.done && next.value.key === row.k) { yield { key: row.k, entry: next.value, old: row.v }; next = await walk.next(); }
    else yield { key: row.k, old: row.v };
  }
  while (!next.done) { yield { key: next.value.key, entry: next.value }; next = await walk.next(); }
}

/**
 * Whether a joined step needs no change. An entity directory row is always
 * re-projected (its problems are cheap and status-dependent), and EVERY
 * entity row is re-projected when the profile changed (`reprojectEntities`):
 * field validation and directory mapping belong to the profile.
 */
function unchanged(step: JoinStep, reprojectEntities: boolean): boolean {
  if (step.entry === undefined || step.old === undefined || isEntityDirKey(step.key)) return false;
  if (reprojectEntities && step.key.startsWith("e:")) return false;
  return sameStamp(stampOfRow(step.key, step.old), step.entry.stamp);
}

/** The uncatalogued paths of a walk: their count and a bounded sample. */
export interface UncataloguedTally { readonly count: number; readonly sample: readonly string[] }

/** A walk handed to a reconciliation: its entries in key order, and its uncatalogued paths. */
export interface CatalogWalkInput {
  readonly entries: AsyncIterable<WalkedEntry>;
  readonly uncatalogued: UncataloguedTally;
}

/** Reconcile the whole catalog with the files of the project at `root` (the incumbent full walk, in arrays). */
export async function syncCatalog(root: string, store: SegmentStore): Promise<SyncResult> {
  const loaded = await typedProfileOf(root);
  const walk = await walkCatalogFiles(root, store.counters, walkTypes(loaded));
  const entries = (async function* () { yield* walk.entries; })();
  return syncCatalogFrom(root, store, loaded, { entries, uncatalogued: { count: walk.uncatalogued.length, sample: walk.uncatalogued.slice(0, SAMPLE_SIZE) } });
}

/** The custom profile a reconciliation of `root` catalogues, and its walk types (a bounded caller walks with these). */
export async function catalogWalkTypes(root: string): Promise<{ loaded: LoadedProfile | undefined; types: EntityWalkType[] }> {
  const loaded = await typedProfileOf(root);
  return { loaded, types: walkTypes(loaded) };
}

/** Serialized bytes of `rows`, as a bounded batch counts them. */
const serializedBytes = (rows: readonly SegmentRow[]): number => rows.reduce((sum, row) => sum + Buffer.byteLength(JSON.stringify(row)), 0);

/** The rows a reconciliation has not committed yet, and when they are due (see the file comment). */
class PendingBatch {
  private rows: SegmentRow[] = [];
  private entries = 0;
  private bytes = 0;

  constructor(private readonly maxBytes: number | undefined) {}

  /** The bytes `rows` count for: 0 for the incumbent, which counts entries only. */
  measure(rows: readonly SegmentRow[]): number {
    return this.maxBytes === undefined ? 0 : serializedBytes(rows);
  }

  /** Whether the pending rows must be committed before an entry of `bytes` is added (a bounded caller only). */
  wouldPass(bytes: number): boolean {
    return this.maxBytes !== undefined && this.rows.length > 0 && this.bytes + bytes > this.maxBytes;
  }

  /** Add one entry's rows; whether the entry count is now due. */
  add(rows: readonly SegmentRow[], bytes: number): boolean {
    this.rows.push(...rows);
    this.bytes += bytes;
    this.entries += 1;
    return this.entries >= SYNC_BATCH_ENTRIES;
  }

  /** The pending rows in key order, leaving none pending. */
  take(): SegmentRow[] {
    const rows = sortedByKey(this.rows);
    this.rows = [];
    this.entries = 0;
    this.bytes = 0;
    return rows;
  }
}

/** Commit `rows` as an unfinished checkpoint of `store`. */
const commitCheckpoint = (store: SegmentStore, rows: SegmentRow[]): Promise<SegmentStore> => store.commit({ rows, meta: checkpointMeta(store) });

/** Reconcile the whole catalog with `walk` (entries in key order): THE ONE BODY of every reconciliation. */
export async function syncCatalogFrom(root: string, store: SegmentStore, loaded: LoadedProfile | undefined, walk: CatalogWalkInput, options: SyncOptions = {}): Promise<SyncResult> {
  let current = store;
  const pending = new PendingBatch(options.maxBatchBytes);
  const done = { reprojected: 0, removed: 0 };
  const counts = { concepts: 0, queries: 0, sources: 0 };
  const entities: EntityTally = { pages: 0, problems: 0 };
  const reprojectEntities = loaded !== undefined && catalogMetaOf(store).typed?.profileDigest !== loaded.digest;
  for await (const step of joinWalk(walk.entries, store)) {
    if (unchanged(step, reprojectEntities)) { countStep(counts, entities, step.key, step.old); continue; }
    const rows = await reconcileRows(root, current, step.key, step.entry, step.old, loaded, options.entityPageBound);
    const kept = rows.find((row) => row.k === step.key && row.d !== 1);
    countStep(counts, entities, step.key, kept?.v, kept !== undefined);
    if (rows.length === 0) continue;
    if (!step.key.startsWith("d:")) done[step.entry === undefined ? "removed" : "reprojected"] += 1;
    const bytes = pending.measure(rows);
    if (pending.wouldPass(bytes)) current = await commitCheckpoint(current, pending.take());
    if (pending.add(rows, bytes)) current = await commitCheckpoint(current, pending.take());
  }
  current = await current.commit({ rows: pending.take(), meta: finalMeta(counts, walk.uncatalogued, typedMetaOf(store, loaded, entities)) });
  return { store: current, ...done, uncatalogued: walk.uncatalogued.count };
}
