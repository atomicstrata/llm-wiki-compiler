/**
 * @file src/portable/scoped/store-types.ts
 * @description The data shapes of the scoped path and the SURFACE its shared
 * bodies ask of an authority-only scoped store, with no implementation.
 *
 * The proposal, review and validation bodies are shared by the local disk
 * path and by a host. They name this surface, not a store class, so the
 * public graph holds the contract and never a host's volatile store.
 */

import type { LabelSet } from "../contracts.js";
import type { IndexAnswer } from "../scale/paged-store.js";
import type { PersistentMap } from "../store/persistent-map.js";
import type { ProjectStore, ReadView } from "../store/store.js";
import type { NamespaceSnapshot } from "./namespace-table.js";

/** Work the scoped path did, for the slice's evidence. Counted where the work happens. */
export interface ScopedCounters {
  /**
   * Objects and payload bytes a generation or a validation observed. On this
   * store the digest compared is the one the authority recorded when it bound
   * the bytes (it is the only writer), so these are bytes OBSERVED, not bytes
   * re-hashed. They count semantic payload, not process memory.
   */
  objectsObserved: number;
  bytesObserved: number;
  /** Title entries handed to a compile as the namespace projection. */
  titleEntriesEnumerated: number;
  /** Scope fences compared at validation, each one comparison. */
  fencesCompared: number;
  /** Distinct terms of each member text bound into a namespace index: a term count, NOT the full posting-list maintenance work. */
  postingsInserted: number;
  /** Bytes a generation held at once: the largest single body, and all bodies it retained. */
  maxBufferBytes: number;
  retainedBytes: number;
  /** Objects and bytes read by cold rebuilds of derived views. */
  coldObjectsRead: number;
  coldBytesRead: number;
}

/** A keyword query over one namespace's members. */
export interface NamespaceQuery { namespace: string; text: string; k: number; scanBudget: number; labelSets: readonly LabelSet[] }

/** What one namespace query found, with the identity of the index state that answered it. */
export interface NamespaceAnswer { answer: IndexAnswer; index: { name: string; root: string; labelEpoch: string } | null }

/** Everything one scoped generation reads from: ONE head and the namespace table beside it. */
export interface ScopedPin {
  view: ReadView;
  namespaces: PersistentMap<NamespaceSnapshot>;
  /** Which namespace each compiled source belongs to, at the same head. */
  sourceNamespaces: PersistentMap<string>;
  labelEpoch: string;
  context: NamespaceAnswer | null;
}

/**
 * What the shared scoped bodies ask of an authority-only store with namespace
 * scope fences. A directory has no such store; a host's store implements it.
 */
export interface ScopedStoreSurface extends ProjectStore {
  /** Work counters of the scoped path. */
  readonly scopedCounters: ScopedCounters;
  /** Pin one head, its namespace table and label epoch (and answer a namespace query) in one synchronous step. */
  pinScoped(query: NamespaceQuery | null): ScopedPin;
  /** The namespace table at the current head. */
  currentNamespaces(): PersistentMap<NamespaceSnapshot>;
  /** Build one namespace's member index when it is missing or stale. */
  ensureNamespaceIndex(name: string, maxMembers: number): Promise<void>;
  /** The label sets the catalog is partitioned by. */
  partitionLabelSets(): readonly LabelSet[];
}
