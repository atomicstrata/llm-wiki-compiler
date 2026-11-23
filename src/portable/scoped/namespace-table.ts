/**
 * @file src/portable/scoped/namespace-table.ts
 * @description The authority-maintained record of each declared namespace:
 * its member pages, which sources own which of them, and two fences.
 *
 * The store calls {@link NamespaceTable.bind} in the same synchronous step as
 * every head swap, whatever wrote the binding: a publication, the fixture
 * bootstrap, a relabel or a loss. There is no moment at which the head shows a
 * page or a durable source record whose namespace entry and fences do not.
 *
 * - The TITLE fence moves when a page in the namespace is created, retitled,
 *   relabelled or lost: anything that changes which titles a cleared caller
 *   could be given. A body edit that keeps title and labels does not move it.
 * - The MEMBER fence moves on ANY change to a member, body included. It is the
 *   conservative retrieval fence.
 * - OWNERSHIP is bound from each durable source record. A proposal records
 *   the exact owner lists of every concept page its closure and target guard
 *   consulted, so a concurrent ownership change there stales it.
 *
 * Ownership is AUTHORITY here, not a derived view. A lost record keeps its ownership entry, flagged
 * `lost`, so closure discovery still finds that co-owner and refuses instead of
 * silently dropping it.
 *
 * Every table is a persistent trie; a bind copies only the paths it changes
 * and counts that work into the store's commit work.
 */

import { linkableTitleOf } from "../../compiler/resolver.js";
import { parseFrontmatter } from "../../utils/markdown.js";
import type { ContentDigest, LabelSet } from "../contracts.js";
import { bytesDigest, normalizeLabels } from "../digest.js";
import { PersistentMap, type TrieWork } from "../store/persistent-map.js";
import { namespaceOf, namespacedSlugOf, sourceOfRecordPath } from "./namespaces.js";
import { parseSourceRecord } from "./source-records.js";

/** What the authority recorded about one member page when it bound it. */
export interface NamespaceMember {
  path: string;
  title: string;
  /** EXACTLY what a title projection hands the compile for this page: its linkable title, or `null` (orphaned or untitled). */
  linkableTitle: string | null;
  digest: ContentDigest;
  labels: LabelSet;
  /** The page's frontmatter block only: what the index and MOC views are derived from. */
  frontmatter: string;
}

/** What the authority knows about one source's ownership in a namespace. */
export interface SourceOwnership {
  concepts: readonly string[];
  /** The committed operation that wrote its record, or `null` for a fixture bind. */
  writer: string | null;
  /** True when the record was lost: its ownership is still known, its state is not. */
  lost: boolean;
}

/** One namespace at one head. */
export interface NamespaceSnapshot {
  name: string;
  members: PersistentMap<NamespaceMember>;
  /** Concept page path → the sources that own it, sorted. */
  owners: PersistentMap<readonly string[]>;
  sources: PersistentMap<SourceOwnership>;
  titleFence: string;
  memberFence: string;
}

/** One bound object, as the store hands it over. `bytes: null` means the object was lost. */
interface BoundObject { path: string; bytes: Uint8Array | null; labels: LabelSet }

/** What one bind changed in one namespace's members, for derived maintenance. */
interface NamespaceChange { name: string; path: string; before: NamespaceMember | null; after: NamespaceMember | null }

const UTF8 = new TextDecoder("utf-8");

/** The leading frontmatter block of `text`, LF or CRLF, or "". */
function frontmatterOf(text: string): string {
  return /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/u.exec(text)?.[0] ?? "";
}

/** The member record for a namespaced page, as bound. */
function memberOf(path: string, bytes: Uint8Array, labels: LabelSet): NamespaceMember {
  const text = UTF8.decode(bytes);
  const title = parseFrontmatter(text).meta.title;
  return {
    path, digest: bytesDigest(bytes), labels: normalizeLabels(labels), frontmatter: frontmatterOf(text),
    title: typeof title === "string" ? title : (namespacedSlugOf(path) ?? path), linkableTitle: linkableTitleOf(text),
  };
}

/** True when two label sets differ. */
function labelsDiffer(before: NamespaceMember, after: NamespaceMember): boolean {
  return JSON.stringify(before.labels) !== JSON.stringify(after.labels);
}

/** True when two member records differ in a way a member fence must reflect. */
function memberChanged(before: NamespaceMember | null, after: NamespaceMember | null): boolean {
  if (before === null || after === null) return before !== after;
  return before.digest !== after.digest || labelsDiffer(before, after);
}

/**
 * True when the titles a cleared caller could be given may differ: a create, a
 * loss, a change of the exact linkable title (a retitle, an orphaning, a title
 * removed) or a relabel.
 */
function titleVisibilityChanged(before: NamespaceMember | null, after: NamespaceMember | null): boolean {
  if (before === null || after === null) return before !== after;
  return before.linkableTitle !== after.linkableTitle || labelsDiffer(before, after);
}

/** Every namespace's members, ownership and fences, maintained at bind. */
class NamespaceTable {
  private snapshots = PersistentMap.empty<NamespaceSnapshot>();
  /** Which namespace each source's record binds it to. */
  private sourceNamespace = PersistentMap.empty<string>();
  private fenceCounter = 0;

  constructor(private readonly work: TrieWork) {}

  /** The current snapshots. Immutable: a later bind replaces the map, never mutates it. */
  current(): PersistentMap<NamespaceSnapshot> {
    return this.snapshots;
  }

  /** Which namespace each source's durable record binds it to, now. Immutable like {@link current}. */
  currentSourceNamespaces(): PersistentMap<string> {
    return this.sourceNamespace;
  }

  /**
   * Record one head swap's bindings. Fences move only for namespaces whose
   * state actually changed, and only as far as the change reaches.
   *
   * @param writer - The committed operation the batch belongs to, or `null` for a fixture bind.
   * @returns The member changes, for derived indexes.
   */
  bind(bound: readonly BoundObject[], writer: string | null): NamespaceChange[] {
    const changes: NamespaceChange[] = [];
    for (const item of bound) {
      const source = sourceOfRecordPath(item.path);
      if (source !== null) this.bindRecord(source, item.bytes, writer);
      else this.bindMember(item, changes);
    }
    return changes;
  }

  /** One page binding: membership and the title and member fences. */
  private bindMember(item: BoundObject, changes: NamespaceChange[]): void {
    const name = namespaceOf(item.path);
    if (name === null) return;
    const snapshot = this.snapshotOf(name);
    const before = snapshot.members.get(item.path) ?? null;
    const after = item.bytes === null ? null : memberOf(item.path, item.bytes, item.labels);
    if (!memberChanged(before, after) && !titleVisibilityChanged(before, after)) return;
    const members = after === null
      ? snapshot.members.deleteMany([item.path], this.work)
      : snapshot.members.setMany([[item.path, after]], this.work);
    const fence = this.nextFence();
    this.put({
      ...snapshot, members, memberFence: `members-${fence}`,
      titleFence: titleVisibilityChanged(before, after) ? `titles-${fence}` : snapshot.titleFence,
    });
    changes.push({ name, path: item.path, before, after });
  }

  /** One durable record binding or loss: ownership and the ownership fence. */
  private bindRecord(source: string, bytes: Uint8Array | null, writer: string | null): void {
    const previousName = this.sourceNamespace.get(source);
    if (bytes === null) {
      if (previousName !== undefined) this.markLost(previousName, source);
      return;
    }
    const record = parseSourceRecord(UTF8.decode(bytes));
    if (record === null || record.source !== source) return;
    if (previousName !== undefined) this.dropOwnership(previousName, source);
    const snapshot = this.snapshotOf(record.namespace);
    const owners = snapshot.owners.setMany(record.concepts.map((concept) => {
      const list = (snapshot.owners.get(concept) ?? []).filter((owner) => owner !== source);
      return [concept, [...list, source].sort()] as const;
    }), this.work);
    const sources = snapshot.sources.setMany([[source, { concepts: [...record.concepts], writer, lost: false }]], this.work);
    this.put({ ...snapshot, owners, sources });
    this.sourceNamespace = this.sourceNamespace.setMany([[source, record.namespace]], this.work);
  }

  /** A lost record keeps its ownership, flagged lost: the co-owner is still known, its state is not. */
  private markLost(name: string, source: string): void {
    const snapshot = this.snapshotOf(name);
    const known = snapshot.sources.get(source);
    if (known === undefined) return;
    const sources = snapshot.sources.setMany([[source, { ...known, lost: true }]], this.work);
    this.put({ ...snapshot, sources });
  }

  /** Remove a source's ownership entries from the namespace it was bound to. */
  private dropOwnership(name: string, source: string): void {
    const snapshot = this.snapshotOf(name);
    const known = snapshot.sources.get(source);
    if (known === undefined) return;
    const owners = snapshot.owners.setMany(known.concepts.map((concept) =>
      [concept, (snapshot.owners.get(concept) ?? []).filter((owner) => owner !== source)] as const), this.work);
    this.put({ ...snapshot, owners, sources: snapshot.sources.deleteMany([source], this.work) });
  }

  /** The snapshot of `name`, or an empty one at fences no change has produced. */
  private snapshotOf(name: string): NamespaceSnapshot {
    return this.snapshots.get(name) ?? {
      name, members: PersistentMap.empty(), owners: PersistentMap.empty(), sources: PersistentMap.empty(),
      titleFence: "titles-0", memberFence: "members-0",
    };
  }

  private put(snapshot: NamespaceSnapshot): void {
    this.snapshots = this.snapshots.setMany([[snapshot.name, snapshot]], this.work);
  }

  private nextFence(): number {
    this.fenceCounter += 1;
    return this.fenceCounter;
  }
}
