/**
 * @file src/portable/compile/recording-access.ts
 * @description The compile's project access over a {@link ProjectStore}, which
 * RECORDS every read as it happens.
 *
 * The shared review-mode compile reads a project only through
 * {@link CompileAccess}. This implementation answers those reads from a store —
 * a directory or one with no paths — and notes each object read, each object
 * looked for and not found, and each listing evaluated. That record is the
 * proposal's apply dependencies: the compile does not report its own reads and
 * has no other way to reach project content, so nothing that shaped a draft can
 * be left out.
 *
 * Candidates go to an in-memory sink the host turns into a proposal record
 * batch. The legacy candidate store is neither read nor written.
 */

import { createHash } from "node:crypto";
import { changesFromHashes, TOP_LEVEL_SOURCE_SELECTION } from "../../compiler/hasher.js";
import { buildCandidate, type CandidateDraft } from "../../compiler/candidates.js";
import { writableCandidateId } from "../../compiler/candidate-publication.js";
import type { CompileAccess, ConceptTitle, PendingSourceState } from "../../compiler/compile-access.js";
import { linkableTitleOf } from "../../compiler/resolver.js";
import { checkPageCitationsWith } from "../../linter/rules-citations.js";
import type { LintResult } from "../../linter/types.js";
import { reviewPolicyFromConfig } from "../../review/config.js";
import type { ReviewPolicy } from "../../review/policy.js";
import { schemaFromText, type SchemaConfig } from "../../schema/index.js";
import { classifyStateText } from "../../utils/state.js";
import type { ReviewCandidate, SourceChange, WikiState } from "../../utils/types.js";
import type { DependencyListing, DependencyObject } from "../contracts.js";
import { recordDigest } from "../digest.js";
import { PortableRefusal } from "../errors.js";
import {
  ACTIVE_PRODUCT_PATH,
  CONCEPTS_PREFIX,
  CONFIG_PATH,
  INDEX_PATH,
  PROFILE_PATH,
  SCHEMA_PATHS,
  SOURCES_PREFIX,
  STATE_PATH,
  conceptPagePath,
  sourcePath,
} from "../logical-paths.js";
import type { ReadView } from "../store/store.js";

const UTF8 = new TextDecoder("utf-8", { fatal: true });

/** Digest over the whole ordered (path, digest) list a prefix matches: never one page of it. */
export async function completeListDigest(store: ReadView, prefix: string): Promise<DependencyListing> {
  const entries: [string, string][] = [];
  for (const path of await store.list(prefix)) {
    entries.push([path, (await store.observe(path))?.digest ?? "absent"]);
  }
  return { prefix, completeListDigest: recordDigest(entries) };
}

/**
 * Parse project configuration, turning a malformed file into a TYPED refusal.
 * An untyped parse error would reject the call and strand the generation
 * lease; a refusal is recorded as the operation's terminal outcome instead.
 */
function parsedOrRefused<T>(parse: () => T): T {
  try {
    return parse();
  } catch (error) {
    if (error instanceof PortableRefusal) throw error;
    throw new PortableRefusal("operation_unsupported_on_portable_path", "malformed project configuration");
  }
}

/** One object as generation first saw it: what is recorded AND what every later read returns. */
export interface FirstObservation { entry: DependencyObject; bytes: Uint8Array | null }

/** One listing as generation first saw it. */
interface FirstListing { paths: string[]; entry: DependencyListing }

/** The compile's access to one project through its store, recording what it reads. */
export class RecordingCompileAccess implements CompileAccess {
  // The maps hold the IN-FLIGHT promise, stored before the first await. Extraction
  // and page generation run concurrently: two first reads of one path must share
  // one observation, not race to make two and keep whichever finished last.
  private readonly objects = new Map<string, Promise<FirstObservation>>();
  private readonly listings = new Map<string, Promise<FirstListing>>();
  private readonly settled = new Map<string, DependencyObject>();
  private readonly settledListings = new Map<string, DependencyListing>();
  /** Candidates the compile emitted, in emission order. */
  readonly candidates: ReviewCandidate[] = [];

  constructor(protected readonly store: ReadView) {}

  /** Every object read or found absent, in path order. */
  recordedObjects(): DependencyObject[] {
    return [...this.settled.values()].sort((a, b) => a.path.localeCompare(b.path));
  }

  /** Every listing evaluated, in prefix order. */
  recordedListings(): DependencyListing[] {
    return [...this.settledListings.values()].sort((a, b) => a.prefix.localeCompare(b.prefix));
  }

  /** What the compile observed at `path`, if it read it. */
  observed(path: string): DependencyObject | undefined {
    return this.settled.get(path);
  }

  /** Observe `path` from the store and record what was seen. */
  protected async observeOnce(path: string): Promise<FirstObservation> {
    const seen = await this.store.observe(path);
    const entry = { path, digest: seen?.digest ?? "absent" as const, revision: seen?.revision ?? null };
    this.settled.set(path, entry);
    // Kept as BYTES. A listing observes every member to digest it, and most
    // members are never read as text: a `.DS_Store` beside the sources is a
    // dependency by digest, not something to decode.
    return { entry, bytes: seen?.bytes ?? null };
  }

  /**
   * Observe one object ONCE. The first observation is what is recorded and
   * what every later or concurrent read of that path returns, so generation is
   * never fed bytes other than the ones its dependencies name. A failed
   * observation is shared too: every caller sees the same refusal.
   */
  protected first(path: string): Promise<FirstObservation> {
    let pending = this.objects.get(path);
    if (pending === undefined) {
      pending = this.observeOnce(path);
      this.objects.set(path, pending);
    }
    return pending;
  }

  /**
   * One object as text, or `null` when absent, as first observed. Decoding
   * happens only here, when the compile actually asks for text. Bytes the
   * compile selected that are not valid UTF-8 are a typed refusal of the
   * proposal, never an untyped error that would strand its generation lease.
   */
  protected async readText(path: string): Promise<string | null> {
    const { bytes } = await this.first(path);
    if (bytes === null) return null;
    try {
      return UTF8.decode(bytes);
    } catch {
      throw new PortableRefusal("operation_unsupported_on_portable_path", `not valid UTF-8 text: ${path}`);
    }
  }

  /**
   * Admit a listing's membership before any member is observed. Version 1
   * admits every listing; a bounded access refuses one too large to traverse.
   */
  protected admitListing(_prefix: string, _paths: readonly string[]): void {}

  /** List `prefix` from the store and digest exactly the membership returned. */
  private async listOnce(prefix: string): Promise<FirstListing> {
    const paths = await this.store.list(prefix);
    this.admitListing(prefix, paths);
    const members: [string, string][] = [];
    for (const path of paths) members.push([path, (await this.first(path)).entry.digest]);
    const entry = { prefix, completeListDigest: recordDigest(members) };
    this.settledListings.set(prefix, entry);
    return { paths, entry };
  }

  /**
   * List a prefix ONCE. The membership returned is the membership recorded,
   * and its complete-list digest is taken over those same members through the
   * same first observations, so the listing used and the listing named agree.
   */
  protected async listPaths(prefix: string): Promise<string[]> {
    let pending = this.listings.get(prefix);
    if (pending === undefined) {
      pending = this.listOnce(prefix);
      this.listings.set(prefix, pending);
    }
    return (await pending).paths;
  }

  /** The first schema file that exists, looked for in the order a local compile looks. */
  async loadSchema(): Promise<SchemaConfig> {
    for (const path of SCHEMA_PATHS) {
      const text = await this.readText(path);
      if (text !== null) return parsedOrRefused(() => schemaFromText(path, text));
    }
    return schemaFromText("schema.json", null);
  }

  /**
   * The review policy from project configuration. Two things the prototype
   * compile does not support are refused here rather than quietly ignored: a
   * configured CLP profile, whose identity this seam does not capture, and a
   * custom source selection.
   */
  async loadReviewPolicy(): Promise<ReviewPolicy> {
    await this.refuseActiveProfile();
    const text = await this.readText(CONFIG_PATH);
    const config = text === null ? null : parsedOrRefused(() => JSON.parse(text) as Record<string, unknown>);
    if (config?.sources !== undefined) {
      throw new PortableRefusal("operation_unsupported_on_portable_path", "custom source selection is not supported");
    }
    return reviewPolicyFromConfig(config);
  }

  /**
   * A project's active profile can come from a legacy `profile.json` OR from an
   * active-product binding. This seam captures the identity of neither, so
   * either one is refused — present, malformed or unreadable alike — rather
   * than compiled as if the project used the default schema. Both absences are
   * recorded, so a profile or binding installed after generation stales the apply.
   */
  protected async refuseActiveProfile(): Promise<void> {
    for (const path of [PROFILE_PATH, ACTIVE_PRODUCT_PATH]) {
      const present = await this.readText(path).then((text) => text !== null, () => true);
      if (present) {
        throw new PortableRefusal("operation_unsupported_on_portable_path", "an active profile or product is not supported");
      }
    }
  }

  async readState(): Promise<WikiState> {
    const classified = classifyStateText(await this.readText(STATE_PATH));
    if (classified.status === "too-new") {
      throw new PortableRefusal("operation_unsupported_on_portable_path", "compile state is from a newer version");
    }
    return classified.state;
  }

  /** Markdown sources directly under `sources/`, as file names. */
  private async sourceFiles(): Promise<string[]> {
    const paths = await this.listPaths(SOURCES_PREFIX);
    return paths.map((path) => path.slice(SOURCES_PREFIX.length)).filter((name) => name.endsWith(".md"));
  }

  async detectChanges(previous: WikiState): Promise<SourceChange[]> {
    const hashed = [];
    for (const file of await this.sourceFiles()) hashed.push({ file, hash: await this.hashSource(file) });
    return changesFromHashes(hashed, previous, TOP_LEVEL_SOURCE_SELECTION);
  }

  /** The same hash a local compile records: SHA-256 hex of the source text. */
  async hashSource(file: string): Promise<string> {
    return createHash("sha256").update(await this.readSource(file)).digest("hex");
  }

  async readSource(file: string): Promise<string> {
    const text = await this.readText(sourcePath(file));
    if (text === null) throw new Error(`source not found: ${file}`);
    return text;
  }

  async readExtractionIndex(): Promise<string> {
    return (await this.readText(INDEX_PATH)) ?? "";
  }

  async readConceptPage(slug: string): Promise<string> {
    return (await this.readText(conceptPagePath(slug))) ?? "";
  }

  async listConceptPageFiles(): Promise<string[]> {
    return (await this.listPaths(CONCEPTS_PREFIX)).map((path) => path.slice(CONCEPTS_PREFIX.length));
  }

  async listConceptTitles(): Promise<ConceptTitle[]> {
    const titles: ConceptTitle[] = [];
    for (const file of await this.listConceptPageFiles()) {
      if (!file.endsWith(".md")) continue;
      const slug = file.replace(/\.md$/u, "");
      const title = linkableTitleOf(await this.readConceptPage(slug));
      if (title !== null) titles.push({ slug, title });
    }
    return titles;
  }

  /**
   * The prototype compile does not use pending proposals as a generation
   * input, so it reads none and records no lineage-scoped listing.
   */
  async pendingSourceStates(): Promise<Map<string, PendingSourceState>> {
    return new Map();
  }

  /** Existence comes from the recorded listing; a source body is read only for a line span. */
  async checkBrokenCitations(fullPage: string, virtualPath: string): Promise<LintResult[]> {
    return checkPageCitationsWith(fullPage, virtualPath, {
      exists: async (filename) => (await this.listPaths(SOURCES_PREFIX)).includes(sourcePath(filename)),
      lineCount: async (filename) => {
        const text = await this.readSource(filename);
        return text.length === 0 ? 0 : text.split("\n").length;
      },
    });
  }

  /** Build the candidate record with the shared builder and keep it for the proposal batch. */
  async emitCandidate(draft: CandidateDraft): Promise<ReviewCandidate> {
    const candidate = buildCandidate(draft, writableCandidateId(draft.slug, 0, {}));
    this.candidates.push(candidate);
    return candidate;
  }

  /** A review-mode compile writes no live page, so there is never anything to discard. */
  async discardCandidatesForSlug(): Promise<void> {}
}
