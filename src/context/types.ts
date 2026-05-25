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

import type { PageId } from "../viewer/types.js";
import type { PageDirectory } from "../export/types.js";
import type { RecommendedAction } from "../project/recommendations.js";

/** Closed v1 enum for why a page landed in `primary[]`. */
export type PrimaryReason =
  | "semantic-chunk"
  | "title-match"
  | "body-match"
  | "exact-slug"
  | "exact-title"
  | "graph-neighbor";

/** Closed v1 enum for the edge label used in `neighbors[]`. */
type NeighborReason = "wikilink";

/** Closed v1 enum for top-level `warnings[]` codes. */
type ContextWarningCode =
  | "embedding-store-missing"
  | "query-embedding-unavailable"
  | "semantic-retrieval-error"
  | "lint-errors"
  | "pending-candidates"
  | "source-window-unavailable"
  | "truncated-prompt";

/** Closed v1 enum for `gaps[]` codes. */
type ContextGapCode = "dangling-link" | "page-warning";

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
}

/** One graph neighbor edge. `distance` is 1 for direct, 2 for second-hop. */
interface ContextNeighbor {
  from: PageId;
  to: PageId;
  direction: "outgoing" | "incoming";
  distance: number;
  score: number;
  reason: NeighborReason;
}

/** Top-level context-pack state warning. */
export interface ContextWarning {
  code: ContextWarningCode;
  message: string;
}

/**
 * Missing-knowledge gap. `pageId` is required in v1; every documented
 * gap code (`dangling-link`, `page-warning`) is tied to a specific
 * page. A future project-wide gap would either bump `version` or
 * introduce a new sibling field rather than retrofitting nullability
 * onto this one.
 */
interface ContextGap {
  code: ContextGapCode;
  message: string;
  pageId: PageId;
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
