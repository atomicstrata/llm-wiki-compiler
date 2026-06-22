/**
 * Stable v1 JSON contract for `llmwiki context` and the future
 * `get_context_pack` MCP tool.
 *
 * Every top-level field and every documented nested key is present from
 * Slice 1 onward, even when later-slice features have not populated
 * them yet (see `localdocs/context-graph-packs-implementation-plan.md`
 * §JSON Contract). Unpopulated list fields are empty arrays; absent
 * object fields are `null`. Slices may fill data into these fields,
 * but must NEVER add or remove top-level keys without bumping
 * `version`.
 */

import type { GraphNodeId, PageId } from "../viewer/types.js";
import type { PageDirectory } from "../export/types.js";
import type { RecommendedAction } from "../project/recommendations.js";
import type { FreshnessStatus } from "../freshness/types.js";

/** Closed v1 enum for why a page landed in `primary[]`. */
export type PrimaryReason =
  | "semantic-chunk"
  | "title-match"
  | "body-match"
  | "exact-slug"
  | "exact-title"
  | "graph-neighbor";

/**
 * Edge-provenance label used in `neighbors[]`. `"wikilink"` is the v1 value (a
 * PageId↔PageId wikilink edge); `"relation"` (CLP 4b) is an ADDITIVE value
 * emitted ONLY for a neighbor reached along a typed relation edge. A default
 * (relation-less) pack never emits `"relation"`, so its serialized output is
 * unchanged and `version` does not bump.
 */
type NeighborReason = "wikilink" | "relation";

/** Closed v1 enum for top-level `warnings[]` codes. */
type ContextWarningCode =
  | "embedding-store-missing"
  | "query-embedding-unavailable"
  | "semantic-retrieval-error"
  | "lint-errors"
  | "pending-candidates"
  | "source-window-unavailable"
  | "truncated-prompt";

/**
 * Codes for `gaps[]`. `dangling-link`/`page-warning` are the v1 values;
 * `dangling-relation` (CLP 4b) is an ADDITIVE value for a typed relation whose
 * other endpoint has no backing page (a ghost). A default (relation-less) pack
 * never emits it, so its serialized output is unchanged and `version` does not
 * bump.
 */
type ContextGapCode = "dangling-link" | "page-warning" | "dangling-relation";

/**
 * Budget envelope. `estimatedTokens` uses a tokens ≈ chars/4 heuristic in v1.
 * Because `estimatedTokens` is itself serialized inside the measured JSON, the
 * reported value may differ from `estimatePackTokens(returnedPack)` by at most
 * one token of digit-count drift.
 */
export interface ContextBudget {
  requestedTokens: number;
  estimatedTokens: number;
  truncated: boolean;
  /** Section keys (`primary`, `neighbors`, `sourceWindows`, `chunks`) that lost data. */
  trimmedSections: string[];
}

/**
 * Cached lint summary surfaced inside `project.lint`. Matches
 * `LintCacheEntry` in `src/linter/cache.ts` but typed locally so the
 * context contract does not depend on the linter's internal shape.
 */
interface ContextLintSummary {
  warnings: number;
  errors: number;
  at: string;
}

/** Project block. `root` is set to `null` when `--omit-root` is supplied. */
export interface ContextProject {
  root: string | null;
  pages: number;
  pendingCandidates: number;
  lint: ContextLintSummary | null;
}

/** One semantic chunk surfaced for a primary page. Slice 2 populates it. */
interface ContextChunk {
  text: string;
  score: number;
  contentHash?: string;
}

/**
 * Flattened citation. Produced by lifting `ClaimCitation.spans` into one
 * object per span. Paragraph-only citations omit `start` and `end`.
 */
interface ContextCitation {
  file: string;
  start?: number;
  end?: number;
}

/** Source line window emitted only when `--include-sources` is set in Slice 4. */
interface ContextSourceWindow {
  file: string;
  start: number;
  end: number;
  text: string;
}

/** Page-local warning surfaced from the viewer collector. */
interface ContextPageWarning {
  code: string;
  message: string;
}

/** One primary page entry. `reasons` is sorted alphabetically for stable output. */
export interface ContextPrimary {
  id: PageId;
  title: string;
  pageDirectory: PageDirectory;
  score: number;
  reasons: PrimaryReason[];
  summary: string;
  chunks: ContextChunk[];
  citations: ContextCitation[];
  sourceWindows: ContextSourceWindow[];
  warnings: ContextPageWarning[];
  // The three freshness signals are FLATTENED here (rather than nested as a
  // `freshness: PageFreshness` object like `ViewerPage`) for an idiomatic JSON
  // wire shape for agents. Consequently, any future field added to
  // `PageFreshness` must be mirrored here by hand — it won't auto-propagate.
  /** Computed source-freshness of this page (advisory snapshot, not a guarantee). */
  freshnessStatus: FreshnessStatus;
  /** Disputed by another page (`contradictedBy` non-empty). */
  contradicted: boolean;
  /** Explicitly archived (`archived: true` frontmatter). */
  archived: boolean;
}

/**
 * One graph neighbor edge. `distance` is 1 for direct, 2 for second-hop.
 * Endpoints are in the {@link GraphNodeId} space so a typed entity node reached
 * along a relation edge (CLP 4b) is a valid neighbor; for a wikilink-only
 * (default) pack every endpoint is still a `PageId`, so the wire shape is
 * unchanged.
 */
interface ContextNeighbor {
  from: GraphNodeId;
  to: GraphNodeId;
  direction: "outgoing" | "incoming";
  distance: number;
  score: number;
  reason: NeighborReason;
  /**
   * The profile relation type a relation-derived neighbor was reached along (CLP
   * 4b). ABSENT when `reason` is `"wikilink"`, so a default pack's neighbor shape
   * is byte-identical; present only when `reason` is `"relation"`.
   */
  relationType?: string;
}

/** Top-level context-pack state warning. */
export interface ContextWarning {
  code: ContextWarningCode;
  message: string;
}

/**
 * Missing-knowledge gap. `pageId` is required; every gap code
 * (`dangling-link`, `page-warning`, `dangling-relation`) is tied to a specific
 * source. It is keyed in the {@link GraphNodeId} space so a `dangling-relation`
 * gap (CLP 4b) can name a typed entity page (an `EntityId`) as its source; for
 * a default pack every gap source is still a `PageId`, so the wire shape is
 * unchanged. A future project-wide gap would either bump `version` or introduce
 * a new sibling field rather than retrofitting nullability onto this one.
 */
interface ContextGap {
  code: ContextGapCode;
  message: string;
  pageId: GraphNodeId;
}

/** Top-level v1 envelope. */
export interface ContextPack {
  version: 1;
  prompt: string;
  budget: ContextBudget;
  project: ContextProject;
  primary: ContextPrimary[];
  neighbors: ContextNeighbor[];
  warnings: ContextWarning[];
  gaps: ContextGap[];
  suggestedActions: RecommendedAction[];
}

/** Hard cap on the echoed prompt; ranking still uses the original. */
export const PROMPT_ECHO_MAX_LENGTH = 1024;

/** Default budget when `--budget` is omitted. */
export const DEFAULT_BUDGET_TOKENS = 8000;

/** Default depth for graph expansion (1 = direct neighbors only). */
export const DEFAULT_DEPTH = 1;

/** Hard upper bound on `--depth` per plan §Graph Expansion. */
export const MAX_DEPTH = 2;

/** Default cap on `primary[]` page count. */
export const DEFAULT_TOP_PAGES = 5;

/** Hard cap on `primary[]` page count to keep trimming and output bounded. */
export const MAX_TOP_PAGES = 20;

/** Default value pinned for `--top-chunks` (plan §Ranking Model). */
export const DEFAULT_TOP_CHUNKS = 8;

/** Hard cap on semantic chunks to keep budget trimming predictably small. */
export const MAX_TOP_CHUNKS = 50;
