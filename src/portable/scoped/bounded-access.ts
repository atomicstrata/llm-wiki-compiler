/**
 * @file src/portable/scoped/bounded-access.ts
 * @description What every scoped compile access shares, whatever store it
 * reads: the authority-only store of slice S2a or a registered directory of
 * S2b. Each one answers the SAME {@link CompileAccess} seam the shared
 * review-mode compile reads through, from one declared scope only.
 *
 * Shared here, so the two paths cannot drift apart:
 *
 * - THE HANDOFF INVARIANT: every protected input — an object's bytes, an
 *   existence fact — is re-authorized against the caller's CURRENT clearances
 *   before it reaches the compile, and its labels join the output's union;
 * - the read bound: every byte first observed counts once against
 *   `maxReadBytes`, and source bytes against `maxSourceBytes`;
 * - sources: only the named ones and the admitted expansion are readable, and
 *   a citation to any other source does not exist to this compile;
 * - candidates: kept only while the count and byte bounds hold, the excess
 *   dropped with only enough kept to report its sources incomplete;
 * - the exact, absence and existence dependency forms of what was read.
 *
 * What differs — compile state, titles, context and where labels come from —
 * is each subclass's.
 */

import { changesFromHashes, TOP_LEVEL_SOURCE_SELECTION } from "../../compiler/hasher.js";
import type { CandidateDraft } from "../../compiler/candidates.js";
import { checkPageCitationsWith } from "../../linter/rules-citations.js";
import type { LintResult } from "../../linter/types.js";
import type { ReviewCandidate, SourceChange, WikiState } from "../../utils/types.js";
import { RecordingCompileAccess, type FirstObservation } from "../compile/recording-access.js";
import type { ContentDigest, LabelSet } from "../contracts.js";
import { normalizeLabels } from "../digest.js";
import { PortableRefusal } from "../errors.js";
import { isCleared } from "../host/policy.js";
import { ACTIVE_PRODUCT_PATH, PROFILE_PATH, sourcePath } from "../logical-paths.js";
import type { ReadView } from "../store/store.js";
import type { ScopeBoundsV2 } from "./contracts.js";

const UNSUPPORTED = "operation_unsupported_on_portable_path";

/** The working-set counters a bounded access keeps. */
export interface AccessCounters { objectsObserved: number; bytesObserved: number; retainedBytes: number; maxBufferBytes: number }

/** What a bounded access is bounded by and asks. */
export interface BoundedAccessInput {
  bounds: ScopeBoundsV2;
  /** The named sources plus the admitted shared-concept expansion. Nothing else is readable. */
  allowedSources: readonly string[];
  /**
   * The caller's clearances under CURRENT host state, or `null` when the caller
   * is no longer bound or authorized. Asked again before any protected bytes or
   * facts reach the compile, so authority lost while the model runs stops the
   * next read rather than only the persist.
   */
  reauthorize: () => Promise<LabelSet | null>;
  counters: AccessCounters;
}

/** What remains of a candidate the emission bounds did not retain: enough to report its sources incomplete. */
export type DroppedCandidate = Pick<ReviewCandidate, "slug" | "sources" | "sourceStates">;

/** One recorded dependency in a form both scoped paths share. */
export type SharedDependency =
  | { form: "exact"; path: string; digest: ContentDigest; labels: LabelSet }
  | { form: "absence"; path: string }
  | { form: "existence"; path: string; exists: boolean; labels: LabelSet | null };

/** The compile's access to one declared scope, recording what it reads. */
export abstract class BoundedScopedAccess extends RecordingCompileAccess {
  private readonly existence = new Map<string, { digest: ContentDigest | null }>();
  private sourceBytes = 0;
  private readBytes = 0;
  /** Every label of everything handed to the compile: the output carries their union (D9). */
  private readonly labelUnion = new Set<string>();
  /** The binding of every object or fact handed over, as its dependency records it. */
  private readonly boundLabels = new Map<string, LabelSet>();
  private readonly countedSources = new Set<string>();
  /** The recorded hash of each readable source whose prior state the compile was given. */
  protected readonly priorHashes = new Map<string, string>();
  private candidateBytes = 0;
  private retained = 0;
  /** Candidates emitted beyond the count or byte bounds: their bodies were never retained. */
  readonly dropped: DroppedCandidate[] = [];
  private readonly readable: Set<string>;

  protected constructor(view: ReadView, protected readonly limits: BoundedAccessInput) {
    super(view);
    this.readable = new Set(limits.allowedSources);
  }

  /** The sources this compile may read. */
  protected get allowed(): ReadonlySet<string> {
    return this.readable;
  }

  /** Admit further sources — a closure decided after the access was built — before the compile runs. */
  protected admitSources(names: readonly string[]): void {
    for (const name of names) this.readable.add(name);
  }

  /** The labels this view binds to exactly these bytes, or `null` when it binds none. */
  protected abstract boundLabelsOf(path: string, digest: ContentDigest): Promise<LabelSet | null>;

  /** The labels the CURRENT head binds to these bytes while they are still current; `[]` when none. */
  protected abstract liveLabelsOf(path: string, digest: ContentDigest): Promise<LabelSet>;

  /** The caller's current clearances, or a refusal when the caller is no longer authorized. */
  protected async currentClearances(): Promise<LabelSet> {
    const clearances = await this.limits.reauthorize();
    if (clearances === null) throw new PortableRefusal("permission_denied");
    return clearances;
  }

  /**
   * Refuse an object the caller is not CURRENTLY cleared for. The labels bound
   * now are what the dependency records, so a later relabel stales the proposal.
   */
  protected async assertReadable(path: string, digest: ContentDigest): Promise<void> {
    const clearances = await this.currentClearances();
    const labels = await this.boundLabelsOf(path, digest);
    await this.authorizeHandoff({ path, digest, labels }, clearances);
    if (!this.boundLabels.has(path)) this.boundLabels.set(path, normalizeLabels(labels ?? []));
  }

  /**
   * Join `labels` to the output's union: the labels a result REUSED from an
   * earlier generation consumed (slice S5). The proposal then carries them as
   * it carries the labels of everything read fresh.
   */
  // Called through the DiskScopedCompileAccess type the detached wrapper binds, which fallow cannot follow.
  // fallow-ignore-next-line unused-class-member
  retainImportedLabels(labels: LabelSet): void {
    for (const label of labels) this.labelUnion.add(label);
  }

  /**
   * THE handoff invariant: the bound labels of these exact bytes, and the live
   * ones while they are still current, must both be within the caller's current
   * clearances. The bound labels join the output's union.
   */
  protected async authorizeHandoff(item: { path: string; digest: ContentDigest; labels: LabelSet | null }, clearances: LabelSet): Promise<void> {
    const live = await this.liveLabelsOf(item.path, item.digest);
    if (item.labels === null || !isCleared(clearances, [...item.labels, ...live])) throw new PortableRefusal("permission_denied");
    for (const label of item.labels) this.labelUnion.add(label);
  }

  /** Note labels consumed by a handoff that has no object of its own, such as a context page's frontmatter. */
  protected noteConsumedLabels(labels: LabelSet): void {
    for (const label of labels) this.labelUnion.add(label);
  }

  /** The first observation's bytes are counted once, against the read bound, when they are first taken. */
  protected override async observeOnce(path: string): Promise<FirstObservation> {
    const first = await super.observeOnce(path);
    if (first.bytes === null) return first;
    this.consume(first.bytes.byteLength);
    this.limits.counters.objectsObserved += 1;
    return first;
  }

  /**
   * EVERY handoff of an object — the first read and each cached re-read alike —
   * is re-authorized against current host state before its bytes are used.
   */
  protected override async first(path: string): Promise<FirstObservation> {
    const seen = await super.first(path);
    if (seen.bytes !== null) await this.assertReadable(path, seen.entry.digest as ContentDigest);
    return seen;
  }

  /** Account `bytes` handed to or retained by the compile against the read bound and the counters. */
  protected consume(bytes: number): void {
    this.readBytes += bytes;
    if (this.readBytes > this.limits.bounds.maxReadBytes) throw new PortableRefusal("limit_exceeded", "read bytes");
    const { counters } = this.limits;
    counters.bytesObserved += bytes;
    counters.retainedBytes += bytes;
    counters.maxBufferBytes = Math.max(counters.maxBufferBytes, bytes);
  }

  /** A configured profile or product refuses, decided by EXISTENCE only: its bytes never reach the compile. */
  protected override async refuseActiveProfile(): Promise<void> {
    for (const path of [PROFILE_PATH, ACTIVE_PRODUCT_PATH]) {
      if (await this.exists(path)) throw new PortableRefusal(UNSUPPORTED, "an active profile or product is not supported");
    }
  }

  /** Classify every readable source; a named source that is absent refuses rather than reading as deleted. */
  override async detectChanges(previous: WikiState): Promise<SourceChange[]> {
    const hashed = [];
    for (const file of [...this.allowed].sort()) {
      if ((await this.first(sourcePath(file))).bytes === null) throw new PortableRefusal(UNSUPPORTED, "named source not present");
      hashed.push({ file, hash: await this.hashSource(file) });
    }
    return changesFromHashes(hashed, previous, TOP_LEVEL_SOURCE_SELECTION);
  }

  /** One source's text, only inside the scope and under its byte bound. Each source counts once. */
  override async readSource(file: string): Promise<string> {
    if (!this.allowed.has(file)) throw new PortableRefusal(UNSUPPORTED, "source outside the declared scope");
    const first = await this.first(sourcePath(file));
    const text = await this.readText(sourcePath(file));
    if (text === null) throw new PortableRefusal(UNSUPPORTED, "named source not present");
    if (!this.countedSources.has(file)) {
      this.countedSources.add(file);
      this.sourceBytes += first.bytes?.byteLength ?? 0;
    }
    if (this.sourceBytes > this.limits.bounds.maxSourceBytes) throw new PortableRefusal("limit_exceeded", "source bytes");
    return text;
  }

  /** Citations: a source's existence is an existence-only dependency; its line count reads it whole. */
  override async checkBrokenCitations(fullPage: string, virtualPath: string): Promise<LintResult[]> {
    return checkPageCitationsWith(fullPage, virtualPath, {
      // A source outside the scope is never probed: to this compile it does not exist.
      exists: async (filename) => this.allowed.has(filename) && this.exists(sourcePath(filename)),
      lineCount: async (filename) => {
        const text = await this.readSource(filename);
        return text.length === 0 ? 0 : text.split("\n").length;
      },
    });
  }

  /**
   * Whether an object exists, recorded as existence only: its bytes never
   * reach the compile. An object the caller is not currently cleared for is a
   * refusal, never a fact handed over.
   */
  protected async exists(path: string): Promise<boolean> {
    const known = this.existence.get(path) ?? await this.firstExistence(path);
    // A cached fact is handed over again only after the same current check as a first one.
    if (known.digest !== null) await this.assertReadable(path, known.digest);
    else await this.currentClearances();
    return known.digest !== null;
  }

  /** Observe whether `path` exists, once; the bytes are dropped immediately. */
  private async firstExistence(path: string): Promise<{ digest: ContentDigest | null }> {
    const seen = await this.store.observe(path);
    const fact = { digest: seen?.digest ?? null };
    this.existence.set(path, fact);
    return fact;
  }

  /**
   * Keep a candidate only while the count and total body bytes stay inside
   * their bounds. One beyond them is not retained: only its slug and sources
   * are kept, so its sources are reported incomplete.
   */
  override async emitCandidate(draft: CandidateDraft): Promise<ReviewCandidate> {
    const candidate = await super.emitCandidate(draft);
    // Pages are generated concurrently: decide in this continuation (it runs without interleaving) and
    // remove THIS candidate by identity, never whichever happens to be last.
    const size = Buffer.byteLength(candidate.body, "utf8");
    const { bounds } = this.limits;
    if (this.retained >= bounds.maxCandidates || this.candidateBytes + size > bounds.maxCandidateBytes) {
      this.candidates.splice(this.candidates.indexOf(candidate), 1);
      this.dropped.push({ slug: candidate.slug, sources: candidate.sources, sourceStates: candidate.sourceStates });
    } else {
      this.retained += 1;
      this.candidateBytes += size;
    }
    return candidate;
  }

  /** The sources whose recorded prior state already matches their current bytes: nothing to compile. Read through the settled coverage. */
  // fallow-ignore-next-line unused-class-member
  unchangedSources(): Set<string> {
    const unchanged = new Set<string>();
    for (const [name, hash] of this.priorHashes) {
      const seen = this.observed(sourcePath(name));
      if (seen !== undefined && seen.digest === `sha256:${hash}`) unchanged.add(name);
    }
    return unchanged;
  }

  /** The sorted union of the labels of everything the compile was given. */
  consumedLabels(): string[] {
    return [...this.labelUnion].sort();
  }

  /** The binding recorded for `path` when it was handed over, `[]` when it never was. */
  protected recordedLabels(path: string): LabelSet {
    return this.boundLabels.get(path) ?? [];
  }

  /** Every exact, absence and existence dependency this generation recorded. */
  protected sharedForms(): SharedDependency[] {
    const forms: SharedDependency[] = this.recordedObjects().map((entry) => entry.digest === "absent"
      ? { form: "absence", path: entry.path }
      : { form: "exact", path: entry.path, digest: entry.digest, labels: this.recordedLabels(entry.path) });
    for (const [path, fact] of [...this.existence].sort(([a], [b]) => a.localeCompare(b))) {
      // An object also read whole is already an exact dependency; existence adds nothing then.
      if (!this.observed(path)) forms.push({ form: "existence", path, exists: fact.digest !== null, labels: fact.digest === null ? null : this.recordedLabels(path) });
    }
    return forms;
  }
}
