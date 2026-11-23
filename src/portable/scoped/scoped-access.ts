/**
 * @file src/portable/scoped/scoped-access.ts
 * @description The compile's project access on the scoped path: the SAME
 * {@link CompileAccess} seam the shared review-mode compile always reads
 * through, answering only from one declared scope, and recording each read in
 * the narrowest dependency form that is sound for what was handed over.
 *
 * It narrows by READING LESS, never by recording less:
 *
 * - sources: only the named ones and the admitted shared-concept expansion;
 * - titles: only the selected namespace's, from the authority's projection,
 *   with no page body read for them (a title-projection dependency);
 * - context: nothing unless the scope opted in; then only the K pages a
 *   bounded keyword query over the namespace selected (a conservative
 *   retrieval dependency) — the whole wiki index is never read;
 * - compile state: only the durable records of the sources in scope;
 * - citations: existence checks are existence-only dependencies.
 *
 * Anything whose bytes reach the compile — a source, a state record, an
 * existing target page, a context page, configuration — stays an exact
 * dependency. Every object is checked against the pinned head's label binding
 * and the caller's current clearances before its bytes are used. The handoff,
 * bound and candidate rules it shares with the registered-directory path live
 * in {@link BoundedScopedAccess}.
 */

import { indexContentFromPages } from "../../compiler/indexgen.js";
import type { CompileAccess, ConceptTitle } from "../../compiler/compile-access.js";
import { promptModifiersDigest } from "../../compiler/prompt-modifiers.js";
import { classifyStateText } from "../../utils/state.js";
import type { SourceState, WikiState } from "../../utils/types.js";
import type { ContentDigest, LabelSet } from "../contracts.js";
import { recordDigest } from "../digest.js";
import { PortableRefusal } from "../errors.js";
import { isCleared } from "../host/policy.js";
import type { CompileScopeV2, ScopedDependencyV2, ScopedSourceRecordV2 } from "./contracts.js";
import { parseSourceRecord } from "./source-records.js";
import type { NamespaceMember } from "./namespace-table.js";
import { namespacedPagePath, namespacedSlugOf, scopedSourcePath, sourceRecordPath } from "./namespaces.js";
import type { ReadView } from "../store/store.js";
import type { ScopedCounters, ScopedPin } from "./store-types.js";
import { BoundedScopedAccess } from "./bounded-access.js";

const UNSUPPORTED = "operation_unsupported_on_portable_path";

/** What one scoped generation reads from and is bounded by. */
export interface ScopedAccessInput {
  pin: ScopedPin;
  scope: CompileScopeV2;
  /** The named sources plus the admitted shared-concept expansion. Nothing else is readable. */
  allowedSources: readonly string[];
  clearances: LabelSet;
  /**
   * The caller's clearances under CURRENT host state, or `null` when the caller
   * is no longer bound or authorized. Asked again before any protected bytes,
   * titles or facts reach the compile, so authority lost while the model runs
   * stops the next read rather than only the persist.
   */
  reauthorize: () => Promise<LabelSet | null>;
  /** The CURRENT head, so a classification upgrade after the pin is seen at the next handoff. */
  current: ReadView;
  counters: ScopedCounters;
}

/** One context page the bounded query selected and the pinned ledger confirmed. */
interface ContextResult { path: string; digest: ContentDigest; labels: LabelSet }

/** Context hits the pinned ledger still binds to the caller-cleared labels; any other hit is dropped silently. */
async function confirmedContext(input: ScopedAccessInput): Promise<ContextResult[]> {
  const confirmed: ContextResult[] = [];
  for (const hit of input.pin.context?.answer.hits ?? []) {
    const labels = await input.pin.view.labelsFor(hit.path, hit.digest);
    if (labels !== null && isCleared(input.clearances, labels)) confirmed.push({ path: hit.path, digest: hit.digest, labels });
  }
  return confirmed;
}

/** The compile's access to one declared scope, recording what it reads. */
export class ScopedCompileAccess extends BoundedScopedAccess implements CompileAccess {
  private titleProjection: Extract<ScopedDependencyV2, { form: "title-projection" }> | null = null;
  /** Protected facts consumed without their bytes: path → digest. */
  private readonly facts = new Map<string, ContentDigest>();
  private readonly namespace: string;

  private constructor(private readonly input: ScopedAccessInput, readonly context: readonly ContextResult[]) {
    super(input.pin.view, { bounds: input.scope.bounds, allowedSources: input.allowedSources, reauthorize: input.reauthorize, counters: input.counters });
    this.namespace = input.scope.namespace.name;
    for (const result of context) this.noteConsumedLabels(result.labels);
  }

  /** Build the access, confirming the pinned context hits against the pinned ledger first. */
  static async create(input: ScopedAccessInput): Promise<ScopedCompileAccess> {
    return new ScopedCompileAccess(input, await confirmedContext(input));
  }

  /** The pinned binding of these exact bytes. */
  protected override boundLabelsOf(path: string, digest: ContentDigest): Promise<LabelSet | null> {
    return this.store.labelsFor(path, digest);
  }

  /** The live binding while the bytes are still current, so a same-byte upgrade after the pin stops the next handoff. */
  protected override async liveLabelsOf(path: string, digest: ContentDigest): Promise<LabelSet> {
    return (await this.input.current.labelsFor(path, digest)) ?? [];
  }

  /**
   * Record protected FACTS about sources — a co-owner's name on the frontier
   * or in the expansion — as consumed evidence: the fact's object is
   * authorized now, its labels join the output's union, and its exact binding
   * becomes a dependency. Its bytes are not handed to the compile.
   */
  async noteSourceFacts(names: readonly string[]): Promise<void> {
    for (const name of names) {
      const path = (await this.store.observe(sourceRecordPath(name))) !== null ? sourceRecordPath(name) : scopedSourcePath(name);
      const seen = await this.store.observe(path);
      if (seen === null) throw new PortableRefusal("permission_denied");
      await this.assertReadable(path, seen.digest);
      this.facts.set(path, seen.digest);
    }
  }

  /** Compile state: only the durable records of the sources in scope. */
  override async readState(): Promise<WikiState> {
    const state = classifyStateText(null).state;
    const requested = promptModifiersDigest();
    let modifiersMatch = true;
    for (const name of this.input.allowedSources) {
      const record = await this.recordOf(name);
      if (record === null) continue;
      if (record.promptModifiers !== requested) modifiersMatch = false;
      this.priorHashes.set(name, record.hash);
      state.sources[name] = this.sourceStateOf(record);
    }
    // A record compiled under other modifiers makes every unchanged source in scope stale, as V1 does project-wide.
    state.promptModifiers = modifiersMatch ? requested : `${requested}|differs`;
    return state;
  }

  /** One source's durable record, required to belong to the selected namespace. */
  private async recordOf(name: string): Promise<ScopedSourceRecordV2 | null> {
    const text = await this.readText(sourceRecordPath(name));
    if (text === null) return null;
    const record = parseSourceRecord(text);
    if (record === null) throw new PortableRefusal(UNSUPPORTED, "malformed scoped state record");
    if (record.namespace !== this.namespace) throw new PortableRefusal(UNSUPPORTED, "source compiled into another namespace");
    return record;
  }

  /** The legacy shape of one record, as the shared change detection reads it. */
  private sourceStateOf(record: ScopedSourceRecordV2): SourceState {
    const concepts = record.concepts.map((path) => namespacedSlugOf(path) ?? path);
    return { hash: record.hash, concepts, compiledAt: record.compiledAt };
  }

  /**
   * The extraction prompt's dedup context: nothing, or the index lines of ALL K
   * selected pages, rendered from their recorded frontmatter (whose pages the
   * retrieval dependency names by digest). Never the wiki index.
   */
  override async readExtractionIndex(): Promise<string> {
    if (this.context.length === 0) return "";
    for (const result of this.context) await this.assertReadable(result.path, result.digest);
    const pages = this.context.map(({ path }) => ({ slug: namespacedSlugOf(path) ?? path, content: this.memberOf(path)?.frontmatter ?? "" }));
    for (const page of pages) this.consume(Buffer.byteLength(page.content, "utf8"));
    return indexContentFromPages(pages, []);
  }

  override async readConceptPage(slug: string): Promise<string> {
    return (await this.readText(namespacedPagePath(this.namespace, slug))) ?? "";
  }

  /** Related pages: none, or exactly the context the scope opted into, each re-authorized when handed over. */
  override async listConceptPageFiles(): Promise<string[]> {
    for (const result of this.context) await this.assertReadable(result.path, result.digest);
    return this.context.map(({ path }) => `${namespacedSlugOf(path) ?? path}.md`);
  }

  /**
   * The selected namespace's titles, from the authority's projection: no page
   * body is read for them. The shared link-target builder calls this through
   * the CompileAccess seam (`asCompileAccess(...)`), which fallow cannot follow.
   */
  override async listConceptTitles(): Promise<ConceptTitle[]> {
    const clearances = await this.currentClearances();
    const snapshot = this.input.pin.namespaces.get(this.namespace);
    if ((snapshot?.members.size ?? 0) > this.input.scope.bounds.maxTitleEntries) throw new PortableRefusal("limit_exceeded", "title entries");
    const members = [...(snapshot?.members.keys() ?? [])].sort().map((path) => snapshot?.members.get(path) as NamespaceMember);
    // Members hidden from the caller at the pin are not projected (the title fence still covers them);
    // each projected title passes the same live handoff check as any other protected input.
    const cleared = members.filter((member) => isCleared(clearances, member.labels));
    this.input.counters.titleEntriesEnumerated += cleared.length;
    for (const member of cleared) await this.authorizeHandoff(member, clearances);
    const titles = cleared.flatMap((member) => {
      const slug = namespacedSlugOf(member.path);
      return member.linkableTitle === null || slug === null ? [] : [{ slug, title: member.linkableTitle }];
    });
    for (const title of titles) this.consume(Buffer.byteLength(title.title, "utf8"));
    this.titleProjection = {
      form: "title-projection", namespace: this.namespace, titleFence: snapshot?.titleFence ?? "titles-0",
      titlesDigest: recordDigest(titles.map((title) => [title.slug, title.title])),
    };
    return titles;
  }

  /** The pinned member record of one namespaced page. */
  private memberOf(path: string): NamespaceMember | undefined {
    return this.input.pin.namespaces.get(this.namespace)?.members.get(path);
  }

  /** Every exact, absence, existence and projection dependency this generation recorded. Retrieval is added by the caller. */
  recordedForms(): ScopedDependencyV2[] {
    const forms: ScopedDependencyV2[] = this.sharedForms();
    for (const [path, digest] of [...this.facts].sort(([a], [b]) => a.localeCompare(b))) {
      if (!this.observed(path)) forms.push({ form: "exact", path, digest, labels: this.recordedLabels(path) });
    }
    if (this.titleProjection !== null) forms.push(this.titleProjection);
    return forms;
  }
}
