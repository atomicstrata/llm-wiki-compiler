/**
 * @file src/portable/scale/paged-store.ts
 * @description The NEW internal read interface a host programs against at
 * scale, and the port a rebuildable index sits behind.
 *
 * {@link PagedReadView} is a different interface from version 1's `ReadView`,
 * not an option on it: metadata without a body, one body at a time, and a
 * keyset page over a catalog the store keeps sorted and labelled. A store
 * either implements it for real ({@link PagedStore}) or is reached through the
 * bounded version 1 adapter, which refuses what it cannot do by name.
 *
 * {@link DerivedIndexPort} is host-internal. An index behind it is rebuildable,
 * is never a logical object or part of a publication, and never answers an
 * authority question: it has no way to write to the catalog or the ledger.
 */

import type { ContentDigest, LabelSet } from "../contracts.js";
import type { ProjectStore } from "../store/store.js";
import type { AdapterScaleCapabilitiesV2 } from "./contracts.js";

/** What the authority recorded about one object. Reading it reads no body. */
export interface ObjectStat {
  path: string;
  digest: ContentDigest;
  byteCount: number;
  revision: string;
  labels: LabelSet;
  /** The title the authority projected from the bytes when it bound them. */
  title: string;
}

/** A request for one keyset page: paths under `prefix`, strictly after `after`, in cleared partitions only. */
export interface ListPageQuery {
  prefix: string;
  /** The label sets the caller is cleared for NOW. Other partitions are never opened. */
  labelSets: readonly LabelSet[];
  after: string | null;
  limit: number;
}

/** One keyset page. `more` is true when a later page exists under the same fence. */
export interface CatalogPage { entries: readonly ObjectStat[]; more: boolean; fence: string }

/** Paged, labelled reads of one project. */
export interface PagedReadView {
  /** Recorded metadata for one path, or `null`. No body is read. */
  stat(path: string): Promise<ObjectStat | null>;
  /** One object's bytes, or `null`. The only call that reads a body. */
  open(path: string): Promise<Uint8Array | null>;
  /**
   * A keyset page over a maintained sorted catalog: a seek plus the page.
   *
   * @throws PortableRefusal `capability_unsupported` on a store with array listing only.
   */
  listPage(query: ListPageQuery): Promise<CatalogPage>;
}

/** One object as the index is told about it. `digest: null` removes the path. */
export interface IndexChange { path: string; digest: ContentDigest | null; labels: LabelSet; text: string | null }

/** A bounded keyword query. `labelEpoch` is the ledger's CURRENT epoch. */
export interface IndexQuery {
  labelSets: readonly LabelSet[];
  labelEpoch: string;
  text: string;
  limit: number;
  scanBudget: number;
}

/** One index hit: a claim about (path, digest) that the ledger must still confirm. */
export interface IndexHit { path: string; digest: ContentDigest; score: number }

/** What a query found, and what it cost. `fenced` counts requested partitions that were not opened. */
export interface IndexAnswer { hits: readonly IndexHit[]; truncated: boolean; postingsRead: number; fenced: number }

/**
 * Host-internal port for a rebuildable keyword index.
 *
 * A partition whose recorded epoch is not `labelEpoch` is NOT OPENED: none of
 * its postings is read, counted against `scanBudget` or ranked. The port has
 * no hook for checking candidates after they are generated.
 */
export interface DerivedIndexPort {
  /**
   * Apply the ledger's COMPLETE change log since `fromRoot` and advance every
   * partition to `labelEpoch`. Warm work, proportional to the changes.
   *
   * @throws Error when the index was not built from exactly `fromRoot`: the only safe answer is a rebuild.
   */
  update(changes: readonly IndexChange[], fromRoot: string, root: string, labelEpoch: string): void;
  query(request: IndexQuery): IndexAnswer;
  /**
   * Discard everything and index `entries`. COLD work, proportional to the
   * project. No query is admitted while it runs. It records `root` and
   * `labelEpoch` only if `isStillCurrent()` holds when the traversal ends.
   *
   * @returns False when the inputs moved during the traversal: the index then reflects nothing.
   */
  rebuild(entries: AsyncIterable<IndexChange>, root: string, labelEpoch: string, isStillCurrent: () => boolean): Promise<boolean>;
}

/** Work and bytes a store did, for the slice's evidence. Counted where the work happens. */
export interface ScaleCounters {
  /** Binary-search steps taken in the catalog. Logarithmic in its size, not constant. */
  catalogSeekSteps: number;
  catalogEntriesRead: number;
  stats: number;
  bodyReads: number;
  bodyBytesRead: number;
  /** Ledger label-binding lookups made to confirm an item at serve time. */
  ledgerLookups: number;
  indexTermSeeks: number;
  postingsRead: number;
  /** Objects and bytes read by cold work only: a first index build or a rebuild. */
  coldObjectsRead: number;
  coldBytesRead: number;
  /** The largest single body buffer held. */
  maxBufferBytes: number;
}

/** A zeroed counter record. */
export function emptyCounters(): ScaleCounters {
  return {
    catalogSeekSteps: 0, catalogEntriesRead: 0, stats: 0, bodyReads: 0, bodyBytesRead: 0, ledgerLookups: 0,
    indexTermSeeks: 0, postingsRead: 0, coldObjectsRead: 0, coldBytesRead: 0, maxBufferBytes: 0,
  };
}

/** A store with a real catalog and index: what S1's one real implementation provides. */
export interface PagedStore extends ProjectStore {
  readonly scaleCapabilities: AdapterScaleCapabilitiesV2;
  readonly counters: ScaleCounters;
  pagedView(): PagedReadView;
  /** The label sets that currently exist, from the LEDGER, never from an index. */
  partitionLabelSets(): readonly LabelSet[];
  /** The ledger's current label epoch. */
  labelEpoch(): string;
  /** The catalog root: the fence a listing cursor is bound to. */
  catalogRoot(): string;
  index(): DerivedIndexPort;
}

/** True when `store` implements the paged interface for real. */
export function isPagedStore(store: ProjectStore): store is PagedStore {
  return typeof (store as Partial<PagedStore>).pagedView === "function";
}
