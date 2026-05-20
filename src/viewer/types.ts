/**
 * Shared types for the local web viewer.
 *
 * `ViewerPage` is the in-memory page record consumed by the HTTP server's
 * `/api/page/:directory/:slug` endpoint. `ViewerSnapshot` is the immutable
 * project-wide state captured once at viewer startup and served from for
 * every request — v1 deliberately does not live-watch the filesystem.
 *
 * `ViewerWarning` is the only warning surface; the underlying wiki layer
 * (`src/wiki/collect.ts`) returns structural `parseStatus` flags, and the
 * viewer decorator (`src/viewer/collect.ts`) maps those into stable
 * `code`/`message` pairs the UI renders.
 */

import type { ClaimCitation } from "../utils/types.js";
import type { PageDirectory } from "../export/types.js";

/**
 * Canonical page identifier: `concepts/<slug>` or `queries/<slug>`. Bare
 * slugs collide between the two directories, so every viewer surface uses
 * the namespaced form.
 */
export type PageId = `${PageDirectory}/${string}`;

/**
 * A single diagnostic surfaced on a page. Codes are stable so the client
 * (and future scripted consumers) can branch on them without parsing
 * messages. The current set covers Slice 1's parser diagnostics; more
 * codes are added by later slices.
 */
export interface ViewerWarning {
  /** Stable machine-readable warning identifier. */
  code: string;
  /** Human-readable description; may include the page slug. */
  message: string;
}

/**
 * In-memory representation of one wiki page as the viewer sees it.
 * Includes everything the server needs to render `/api/page/...` without
 * touching the disk again per request.
 */
export interface ViewerPage {
  /** Namespaced canonical ID (`concepts/<slug>` or `queries/<slug>`). */
  id: PageId;
  /** Filename stem; the canonical filesystem-truth identifier. */
  slug: string;
  /** Source directory the page lives in. */
  pageDirectory: PageDirectory;
  /** Display title. Falls back to slug when frontmatter has no title. */
  title: string;
  /** Absolute path on disk, used for editor links in the support rail. */
  filePath: string;
  /** Raw frontmatter object (empty when missing or malformed). */
  frontmatter: Record<string, unknown>;
  /** Markdown body with the frontmatter block stripped. Needed by Slice 4. */
  body: string;
  /** Outgoing wikilink targets resolved to namespaced IDs. */
  outgoingLinks: PageId[];
  /** Wikilink targets from this page's body that could not be resolved to any existing page.
   *  `slug` is the slugified form used to build the ghost node ID; `display` is the original
   *  human-typed text used as the node label. */
  danglingLinks?: { slug: string; display: string }[];
  /** Claim-level citations extracted from the body via `extractClaimCitations`. */
  citations: ClaimCitation[];
  /** Diagnostics surfaced for this page (parser issues, unresolved citations…). */
  warnings: ViewerWarning[];
}

/**
 * Lightweight project metadata for the dashboard.
 */
export interface ViewerProject {
  /** Display title — preferred from package.json or directory name. */
  title: string;
  /** Bare directory name of the project root. */
  rootName: string;
}

/**
 * Frozen-at-startup counts surfaced by `/api/pages.counts` and re-used by
 * `/api/health`. `sourceFiles` is the cheap filesystem count under
 * `sources/`; `compiledSources` matches MCP `wiki_status.sources` and
 * counts entries in `.llmwiki/state.json`.
 */
export interface ViewerCounts {
  concepts: number;
  queries: number;
  sourceFiles: number;
  pendingReviews: number;
  compiledSources: number;
}

/**
 * Captured state of `wiki/index.md`, the optional compile-time index page.
 * `body` is the raw markdown captured at startup; Slice 4 renders it.
 */
export interface ViewerIndex {
  available: boolean;
  href: string;
  body: string;
  outgoingLinks: PageId[];
}

/**
 * Lightweight summary row for the dashboard's "recent pages" panel.
 */
export interface ViewerRecentPage {
  id: PageId;
  pageDirectory: PageDirectory;
  slug: string;
  title: string;
  updatedAt: string;
}

/**
 * A single node in the wiki link graph. Real pages and ghost (dangling-target)
 * placeholders are both represented here; check `isDangling` to distinguish.
 */
export interface GraphNode {
  /** Namespaced canonical ID matching `ViewerPage.id`, or the raw link target for ghosts. */
  id: PageId;
  title: string;
  slug: string;
  /** Directory prefix from the PageId string. Widened to `string` so ghost nodes
   *  (whose directory may not match the `PageDirectory` union) can be represented. */
  directory: string;
  /** frontmatter.kind for real pages; "dangling" for ghost nodes. */
  kind: string;
  /** For real nodes: valid out-degree + in-degree. For ghost nodes: in-degree only. */
  degree: number;
  /** True when the node has no backing page — it represents a broken wikilink target. */
  isDangling?: boolean;
}

/** A directed edge between two wiki pages. */
export interface GraphEdge {
  source: PageId;
  target: PageId;
}

/** Adjacency data for the graph view. Built once at snapshot time. */
export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/**
 * Snapshot of the entire viewable wiki captured once at startup. Every
 * HTTP endpoint serves from this object — the viewer deliberately does
 * not live-watch the filesystem in v1, so post-startup file changes are
 * not reflected until `llmwiki view` restarts.
 */
export interface ViewerSnapshot {
  /** Absolute project root the snapshot was captured against. */
  root: string;
  /** ISO-8601 timestamp the snapshot was built at. */
  generatedAt: string;
  /** Project metadata for the dashboard header. */
  project: ViewerProject;
  /** Frozen counts for `/api/pages` and `/api/health`. */
  counts: ViewerCounts;
  /** State of `wiki/index.md` at startup. */
  index: ViewerIndex;
  /** Top-N most recently updated pages for the dashboard. */
  recentPages: ViewerRecentPage[];
  /** All readable pages, in collector order (concepts then queries). */
  pages: ViewerPage[];
  /**
   * Filenames present under `sources/` at startup, captured as a flat
   * list. The Slice 4 citation renderer uses these to set the `data-
   * resolved` flag on each chip without doing per-request directory
   * scans.
   */
  sourceFilenames: string[];
  /** Adjacency data for the `#/graph` route. Built once at snapshot time. */
  graph: GraphData;
}
