/**
 * Core type definitions for the llmwiki knowledge compiler.
 * All shared interfaces live here to keep the module boundary clean.
 */

import type { PageKind } from "../schema/types.js";
import type { HeldReason, PolicyHeldReasonCode, ReviewMode } from "../review/policy.js";
import type { EntityId } from "../profile/types.js";
import type { ConnectorProvenance } from "../connectors/types.js";
import type { TrustDecision } from "../trust/decision.js";
import type { PageId } from "./page-id.js";
import type { SelectedPageRef } from "../search/retrieval.js";

/**
 * Lifecycle state of a concept or page's provenance.
 * - `extracted`: drawn directly from a source document.
 * - `merged`: synthesised from multiple sources during compilation.
 * - `inferred`: produced by the model from context, not directly cited.
 * - `ambiguous`: sources disagree or evidence is conflicting.
 * - `imported`: brought in from an external OKF bundle (durable origin marker
 *   that survives review approval; never produced by local compilation).
 */
export type ProvenanceState =
  | "extracted"
  | "merged"
  | "inferred"
  | "ambiguous"
  | "imported";

/**
 * Reference to another concept that contradicts the current one.
 * The slug points to the contradicting wiki page.
 */
export interface ContradictionRef {
  slug: string;
  reason?: string;
}

/**
 * Provenance metadata shared between extraction-time concept records and
 * page-frontmatter records. Both surfaces carry the same three optional
 * fields — confidence, lifecycle state, and contradictions — so a single
 * shared shape keeps the two ends of the pipeline from drifting apart as
 * new fields are added.
 *
 * Extended by {@link ExtractedConcept} and {@link WikiFrontmatter} via
 * `interface … extends ProvenanceMetadata`, so the JSON shapes
 * serialised on disk and over the LLM tool boundary stay byte-identical
 * to the previous flat layout (TypeScript erases the indirection at
 * compile time).
 *
 * `inferredParagraphs` used to live here too but was an unreliable
 * extraction-time guess about the future page body. It is now derived
 * from the rendered body at lint time (see
 * `checkInferredWithoutCitations`) — body is the single source of
 * truth, no metadata field involved.
 */
export interface ProvenanceMetadata {
  /** Numeric confidence in 0..1 — overall confidence in the content. */
  confidence?: number;
  /** Lifecycle state describing how the content was produced. */
  provenanceState?: ProvenanceState;
  /** Slugs of other concepts/pages whose evidence contradicts this one. */
  contradictedBy?: ContradictionRef[];
}

/** A single concept extracted from a source by the LLM. */
export interface ExtractedConcept extends ProvenanceMetadata {
  concept: string;
  summary: string;
  is_new: boolean;
  tags?: string[];
}

/** Per-source entry in .llmwiki/state.json. */
export interface SourceState {
  hash: string;
  concepts: string[];
  compiledAt: string;
  /**
   * v2 typed-ownership mirror of {@link concepts}: each bare concept slug
   * minted into a branded `concepts/<slug>` {@link EntityId}. Kept ALONGSIDE
   * the v1 `concepts` list (never replacing it) so a v2 state stays losslessly
   * downgradeable. Present only after migration to `version: 2`.
   */
  entities?: EntityId[];
}

/** Root shape of .llmwiki/state.json. */
export interface WikiState {
  version: 1 | 2;
  indexHash: string;
  sources: Record<string, SourceState>;
  /** Concept slugs frozen across batches to preserve content from deleted sources. */
  frozenSlugs?: string[];
  /**
   * v2 typed-ownership mirror of {@link frozenSlugs}: each frozen concept slug
   * minted into a branded `concepts/<slug>` {@link EntityId}. Kept ALONGSIDE
   * the v1 `frozenSlugs` list (never replacing it). Present only after
   * migration to `version: 2`.
   */
  frozenEntities?: EntityId[];
}

/** Change detection result for a single source file. */
export interface SourceChange {
  file: string;
  status: "new" | "changed" | "unchanged" | "deleted";
}

/** Wiki page frontmatter parsed from YAML. */
export interface WikiFrontmatter extends ProvenanceMetadata {
  title: string;
  sources: string[];
  summary: string;
  orphaned?: boolean;
  tags?: string[];
  aliases?: string[];
  createdAt: string;
  updatedAt: string;
  /**
   * Optional typed page kind. Defaults to "concept" when absent so existing
   * pages compiled before the schema layer existed continue to work.
   * Uses the canonical PageKind union from the schema layer — import is
   * type-only so it is erased at compile time and creates no runtime cycle.
   */
  kind?: PageKind;
}

/** Summary entry used in index.md generation. */
export interface PageSummary {
  title: string;
  slug: string;
  summary: string;
}

/** Structured result returned by the compile pipeline. */
export interface CompileResult {
  compiled: number;
  skipped: number;
  deleted: number;
  concepts: string[];
  pages: string[];
  errors: string[];
  /** Candidate IDs created by --review or policy-held compile outputs. */
  candidates?: string[];
  /** Structured review split for candidates created by the compile run. */
  review?: {
    held: ReviewedCandidateRef[];
    forced: ReviewedCandidateRef[];
  };
}

/** Candidate reference returned in CompileResult.review. */
export interface ReviewedCandidateRef {
  id: string;
  slug: string;
  reasons: PolicyHeldReasonCode[];
}

/** Optional behaviour controls for the compile pipeline. */
export interface CompileOptions {
  /**
   * Write generated pages as candidates under .llmwiki/candidates/ instead
   * of mutating wiki/. Reviewers approve/reject via `llmwiki review`.
   */
  review?: boolean;
  /**
   * Narrows a compile run to a subset of detected source changes. Applied to the
   * FULL change set from `detectChanges` (new | changed | deleted) immediately
   * after detection and BEFORE affected-source expansion. A change is processed
   * only if the predicate returns true; the deleted entries it keeps still go
   * through deletion/orphan bookkeeping. Omitted ⇒ all detected changes are
   * processed (normal compile). Used by `refresh --stale` to scope a run.
   */
  changeFilter?: (change: SourceChange) => boolean;
  /**
   * Skip schema seed-page generation (but still run index/MOC/link/embedding
   * finalization). Used by `refresh --stale` so a stale-repair run does not
   * write seed pages unrelated to the repair.
   */
  skipSeedPages?: boolean;
  /**
   * Maximum concurrent LLM calls during compile (extraction + page generation).
   * Set by the `--concurrency` flag; overrides LLMWIKI_COMPILE_CONCURRENCY and
   * the built-in default. Out-of-range values are clamped with a warning.
   */
  concurrency?: number;
  /**
   * Refresh semantic embeddings after compilation. Defaults to true.
   * Set to false for a lexical-only build with no embedding-provider calls or
   * pending-embedding retries.
   */
  embeddings?: boolean;
  /**
   * Trusted caller policy appended to the built-in extraction and page-writing
   * system instructions. The built-in instructions are never replaced.
   */
  systemPolicy?: string;
}

/**
 * A pending wiki page change awaiting human review. Persisted as JSON under
 * .llmwiki/candidates/<id>.json when compile is run with --review.
 */
export interface ReviewCandidate {
  /** Stable identifier used by the review CLI commands. */
  id: string;
  /** Human-readable concept title. */
  title: string;
  /** Filename slug that the page would be written to. */
  slug: string;
  /** Short summary copied from the LLM extraction. */
  summary: string;
  /** Source filenames that contributed to this candidate. */
  sources: string[];
  /** Full page content (frontmatter + body) ready to be written verbatim. */
  body: string;
  /** ISO timestamp recorded when the candidate was generated. */
  generatedAt: string;
  /** Whether this candidate was policy-held or explicitly forced by --review. */
  reviewMode: ReviewMode;
  /** Structured reasons the candidate is awaiting review. */
  heldReasons: HeldReason[];
  /**
   * Wiki subdir the approved page is written to; defaults to concepts.
   * OKF query docs set `queries` to round-trip back into the right subdir.
   */
  targetDirectory?: "concepts" | "queries";
  /**
   * Typed entity directory the approved page routes to under a configurable
   * profile (e.g. `"papers"`). Phase-2 typed-target metadata; OMITTED for
   * default-profile candidates.
   */
  targetEntityType?: string;
  /**
   * Trust Guard decision attached to this candidate at generation time, so
   * reviewers see how the write was routed. Phase-2 typed-target metadata;
   * OMITTED for default-profile candidates.
   */
  trustDecision?: TrustDecision;
  /** Original OKF bundle-relative path, for imported candidates. */
  okfPath?: string;
  /** Host-authored provenance for connector-fetched candidates. */
  connectorProvenance?: ConnectorProvenance;
  /** Confidence parsed from the generated page frontmatter, for review display. */
  confidence?: number;
  /** True when the generated page frontmatter declares contradictions. */
  contradicted?: boolean;
  /**
   * Per-source incremental-state snapshots captured at compile time.
   *
   * Approving the candidate persists these into `.llmwiki/state.json` so the
   * source files are marked compiled and won't be reprocessed on the next
   * `compile` run. Without this, approved candidates would silently
   * regenerate on every subsequent compile.
   */
  sourceStates?: Record<string, SourceState>;
  /**
   * Schema lint violations detected at candidate-generation time.
   *
   * Populated when the candidate body violates a schema rule (e.g. fewer
   * wikilinks than the kind's `minWikilinks` requires). Only set when at
   * least one violation exists — absent when the candidate is clean.
   * `review show` surfaces these so reviewers see failures before approving.
   */
  schemaViolations?: import("../linter/types.js").LintResult[];
  /**
   * Provenance lint violations detected at candidate-generation time.
   *
   * Covers malformed claim citations (`^[file.md:abc]`), out-of-bounds
   * line spans, and citations referencing source files that don't exist.
   * Surfaced in `review show` next to schema violations so reviewers
   * catch citation issues before approving — these used to only show up
   * on the next normal `compile` after the page was already promoted.
   */
  provenanceViolations?: import("../linter/types.js").LintResult[];
}

/** A single chunk citation surfaced as part of a query result. */
export interface ChunkCitation {
  /**
   * Qualified parent-page id (`<namespace>/<part>`) — keeps same-slug chunks
   * (`concepts/foo` vs `papers/foo`) distinct in provenance/reasoning/debug.
   */
  pageId: PageId;
  slug: string;
  title: string;
  chunkIndex: number;
  score: number;
  text: string;
}

/** Diagnostic snapshot of how the retrieval pipeline picked context. */
export interface RetrievalDebug {
  /** Pages selected after collapsing chunks to their parent qualified pageId. */
  pages: Array<{ pageId: PageId; score: number }>;
  /** Top-ranked chunks before the page-collapse step. */
  chunks: ChunkCitation[];
  /** True when chunk-level entries drove the selection (vs. page-level fallback). */
  usedChunks: boolean;
  /** True when reranking reordered the initial semantic ranking. */
  reranked: boolean;
}

/** A structured warning surfaced in a {@link QueryResult} (S6). */
export interface QueryWarning {
  code: string;
  message: string;
}

/** Structured result returned by the query pipeline. */
export interface QueryResult {
  answer: string;
  /**
   * Legacy DERIVED display field: the bare page-part of each selected
   * {@link pageIds} entry (via `slugFromPageId`). Kept populated for back-compat
   * with consumers that read slugs; prefer {@link pageIds}/{@link refs} as the
   * canonical, collision-free identity (a typed `papers/foo` and a concept `foo`
   * share the slug `foo` but are DISTINCT pageIds).
   */
  selectedPages: string[];
  /**
   * Canonical qualified ids the answer was grounded on (`<namespace>/<part>`),
   * deduped and order-preserved. Carries the typed namespace so a `papers/foo`
   * hit grounds on `wiki/papers/foo.md`, never `wiki/concepts/foo.md`.
   */
  pageIds: PageId[];
  /** The selected page refs (qualified id + slug + title + selection kind). */
  refs: SelectedPageRef[];
  reasoning: string;
  saved?: string;
  /** Populated when the query was run in debug mode. */
  debug?: RetrievalDebug;
  /**
   * Embedding-load degrade warnings surfaced in the result payload (S6) rather
   * than only logged: an outdated (non-v3) or unavailable index degrades query
   * to lexical/index selection and reports `embedding-index-outdated`. Omitted
   * (key absent) when there are no warnings, so a healthy query is unchanged.
   */
  warnings?: QueryWarning[];
}

/** Source type tag persisted in frontmatter to describe the ingest origin. */
export type SourceType = "web" | "file" | "image" | "pdf" | "transcript";

/** Outcome of a source write: a new file, a content change, or a no-op. */
export type WriteStatus = "created" | "updated" | "unchanged";

/** Structured result returned by the ingest pipeline. */
export interface IngestResult {
  filename: string;
  charCount: number;
  truncated: boolean;
  source: string;
  /** Detected source type; undefined for legacy results produced before this field was added. */
  sourceType?: SourceType;
  /** Whether the source file was created, updated (content changed), or unchanged (no-op). */
  writeStatus: WriteStatus;
}

/**
 * A single source span pointing back into ingested source text.
 * Spans are inclusive on both ends and 1-indexed when referring to lines,
 * mirroring the way humans cite editor line numbers.
 */
export interface SourceSpan {
  /** Source filename (e.g. `paper.md`) — always relative to `sources/`. */
  file: string;
  /** Optional inclusive line range; `start` and `end` may be equal. */
  lines?: { start: number; end: number };
}

/**
 * A claim-level citation parsed from a `^[file.md:42-58]` or
 * `^[file.md#L42-L58]` marker. The plain `^[file.md]` form parses with
 * `spans[i].lines` undefined, preserving paragraph-level provenance.
 */
export interface ClaimCitation {
  /** Raw text inside the brackets, useful for diagnostics. */
  raw: string;
  /** One or more source spans contributed by this marker. */
  spans: SourceSpan[];
}
