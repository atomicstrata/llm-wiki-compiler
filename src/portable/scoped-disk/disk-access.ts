/**
 * @file src/portable/scoped-disk/disk-access.ts
 * @description The compile's project access on a registered directory: the
 * SAME {@link CompileAccess} seam every compile reads through, answering only
 * from one declared disk scope, and recording each read in the narrowest form
 * that is sound for a directory.
 *
 * It narrows by READING LESS, never by recording less:
 *
 * - sources: only the named ones and the admitted shared-concept expansion;
 * - titles: the complete list of `wiki/concepts/`, every page read whole and
 *   bound by a full-digest complete-list dependency. The directory is counted
 *   before any member is observed, and refused over the title bound;
 * - context: none — no index and no related pages reach the compile;
 * - compile state: the selected entries and the decisions, projected from ONE
 *   read of the canonical state, never the whole file as a dependency.
 *
 * LABELS. Bytes a legacy writer left have no binding for their digest. Their
 * effective labels are the union of the path's latest binding and the project
 * compartment — never fewer than before, never treated as public. Every such
 * reconciliation is reported, so the persist can bind it under the gate.
 */

import type { CompileAccess, ConceptTitle } from "../../compiler/compile-access.js";
import { linkableTitleOf } from "../../compiler/resolver.js";
import type { WikiState } from "../../utils/types.js";
import type { ContentDigest, LabelSet, ObservedObject } from "../contracts.js";
import { normalizeLabels } from "../digest.js";
import { PortableRefusal } from "../errors.js";
import { CONCEPTS_PREFIX, STATE_CUSTODY_PATH, STATE_PATH } from "../logical-paths.js";
import { BoundedScopedAccess, type AccessCounters } from "../scoped/bounded-access.js";
import type { DiskProjectStore } from "../store/disk-store.js";
import { entryDigestOf } from "./custody.js";
import type { DiskCompileScopeV2, DiskScopedDependencyV2 } from "./disk-contracts.js";
import { decisionsDigest, type CanonicalState } from "./disk-state.js";

/** The work counters of a disk scoped generation or validation. */
export interface DiskScopedCounters extends AccessCounters {
  /** Names a complete listing returned, counted before any member was observed (a refused listing still counts). */
  listingNames: number;
  /** Members of a complete list observed and hashed to re-prove it at validation. */
  listMembersHashed: number;
  /** Bytes of the canonical state file read for its projections. */
  stateBytesRead: number;
}

/** A fresh set of counters. */
function emptyDiskCounters(): DiskScopedCounters {
  return { objectsObserved: 0, bytesObserved: 0, retainedBytes: 0, maxBufferBytes: 0, listingNames: 0, listMembersHashed: 0, stateBytesRead: 0 };
}

/** The work of every disk scoped phase, accumulated for cost evidence. Bounds are enforced per operation, never from these. */
export interface DiskScopedWork { propose: DiskScopedCounters; validate: DiskScopedCounters }

/** A fresh work record. */
export function emptyDiskWork(): DiskScopedWork {
  return { propose: emptyDiskCounters(), validate: emptyDiskCounters() };
}

/** What one disk scoped generation reads from and is bounded by. */
export interface DiskAccessInput {
  store: DiskProjectStore;
  scope: DiskCompileScopeV2;
  allowedSources: readonly string[];
  canonical: CanonicalState;
  /** The state-custody record as read with the canonical state: its loss facts are protected evidence too. */
  custody: ObservedObject;
  compartment: string;
  reauthorize: () => Promise<LabelSet | null>;
  counters: DiskScopedCounters;
}

/** One binding a persist must record for bytes a legacy writer left unbound. */
export interface PendingReconciliation { path: string; digest: ContentDigest; labels: LabelSet }

/** The compile's access to one declared disk scope, recording what it reads. */
export class DiskScopedCompileAccess extends BoundedScopedAccess implements CompileAccess {
  private readonly reconciled = new Map<string, PendingReconciliation>();
  private readonly listed = new Map<string, number>();
  private stateHandedOver = false;

  constructor(private readonly input: DiskAccessInput) {
    super(input.store, { bounds: input.scope.bounds, allowedSources: input.allowedSources, reauthorize: input.reauthorize, counters: input.counters });
  }

  /** The binding of these bytes, or the reconciled union when a legacy writer left them unbound. */
  protected override async boundLabelsOf(path: string, digest: ContentDigest): Promise<LabelSet | null> {
    const bound = await this.input.store.labelsFor(path, digest);
    if (bound !== null) return bound;
    const known = this.reconciled.get(path);
    if (known !== undefined && known.digest === digest) return known.labels;
    const labels = normalizeLabels([...((await this.input.store.lastLabels(path)) ?? []), this.input.compartment]);
    if (!this.reconciled.has(path)) this.reconciled.set(path, { path, digest, labels });
    return labels;
  }

  /** A directory has no pinned head: the bound labels ARE the live ones. */
  protected override async liveLabelsOf(): Promise<LabelSet> {
    return [];
  }

  /** The concept directory is counted before any member is observed, and refused over the title bound. */
  protected override admitListing(prefix: string, paths: readonly string[]): void {
    this.input.counters.listingNames += paths.length;
    if (prefix === CONCEPTS_PREFIX && paths.length > this.input.scope.bounds.maxTitleEntries) {
      throw new PortableRefusal("limit_exceeded", "title entries");
    }
    this.listed.set(prefix, paths.length);
  }

  /**
   * Hand the canonical state and its custody over: each authorized against
   * current clearances every time, its labels joining the output's union, and
   * its bytes counted once. Called before the closure is decided from them,
   * since co-owner names, kept-page decisions and loss facts are protected
   * facts of those files.
   */
  async handOverState(): Promise<void> {
    const { observed } = this.input.canonical;
    await this.assertReadable(STATE_PATH, observed.digest);
    await this.assertReadable(STATE_CUSTODY_PATH, this.input.custody.digest);
    if (this.stateHandedOver) return;
    this.stateHandedOver = true;
    this.consume(observed.bytes.byteLength + this.input.custody.bytes.byteLength);
    this.input.counters.stateBytesRead += observed.bytes.byteLength;
  }

  /** Admit the closure's expansion once it is decided, before the compile runs. Called through the generation record, which fallow cannot follow. */
  // fallow-ignore-next-line unused-class-member
  expandTo(expanded: readonly string[]): void {
    this.admitSources(expanded);
  }

  /** Compile state: the selected entries and the decisions, from the ONE canonical read; nothing else of the file. */
  override async readState(): Promise<WikiState> {
    await this.handOverState();
    const { state } = this.input.canonical;
    const sources: WikiState["sources"] = {};
    for (const name of this.allowed) {
      const entry = state.sources[name];
      if (entry === undefined) continue;
      sources[name] = entry;
      this.priorHashes.set(name, entry.hash);
    }
    return { ...state, sources };
  }

  /** No index reaches the compile on a directory: there is no bounded context. */
  override async readExtractionIndex(): Promise<string> {
    return "";
  }

  /** No related pages either. */
  override async listConceptPageFiles(): Promise<string[]> {
    return [];
  }

  /**
   * Every title of the flat concept directory: the complete list, each page
   * read whole and bound by digest. The shared link-target builder calls this
   * through the CompileAccess seam, which fallow cannot follow.
   */
  override async listConceptTitles(): Promise<ConceptTitle[]> {
    const titles: ConceptTitle[] = [];
    for (const path of await this.listPaths(CONCEPTS_PREFIX)) {
      if (!path.endsWith(".md")) continue;
      const slug = path.slice(CONCEPTS_PREFIX.length, -".md".length);
      const title = linkableTitleOf(await this.readConceptPage(slug));
      if (title !== null) titles.push({ slug, title });
    }
    return titles;
  }

  /** Bindings the persist must record for legacy bytes this generation was given. Called through the generation record. */
  // fallow-ignore-next-line unused-class-member
  pendingReconciliations(): PendingReconciliation[] {
    return [...this.reconciled.values()].sort((a, b) => a.path.localeCompare(b.path));
  }

  /** Every form this generation recorded; the persist adds the consulted owners. */
  recordedForms(): DiskScopedDependencyV2[] {
    const forms: DiskScopedDependencyV2[] = this.sharedForms();
    for (const listing of this.recordedListings()) {
      forms.push({ form: "complete-list", prefix: listing.prefix, completeListDigest: listing.completeListDigest, entries: this.listed.get(listing.prefix) ?? 0 });
    }
    // The state projections are recorded whether or not the compile asked: the closure and the kept-page guard used them.
    const { state } = this.input.canonical;
    for (const source of [...this.allowed].sort()) {
      forms.push({ form: "state-entry", source, entryDigest: entryDigestOf(state.sources[source]) });
    }
    forms.push({ form: "state-decisions", decisionsDigest: decisionsDigest(state) });
    // Their LABELS too: a same-byte widening of either file stales the proposal; an unrelated entry edit does not.
    for (const path of [STATE_PATH, STATE_CUSTODY_PATH]) forms.push({ form: "labels", path, labels: this.recordedLabels(path) });
    return forms;
  }
}
