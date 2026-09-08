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
import type { EntityContext } from "./entity-context.js";
import type { ProfilePack } from "../profile/types.js";
import type { PageDirectory } from "../export/types.js";
import type { PageFreshness } from "../freshness/types.js";
import type { ProfileSummaryBlock } from "../profile/block.js";
import type { PipelineDefinitions } from "./pipeline.js";
import type { EntityId } from "../profile/types.js";
import type { StateStatus } from "../utils/state.js";

/**
 * Canonical page identifier: `concepts/<slug>` or `queries/<slug>`. Bare
 * slugs collide between the two directories, so every viewer surface uses
 * the namespaced form.
 */
export type PageId = `${PageDirectory}/${string}`;

/**
 * The directory namespace a viewer page is ADDRESSED under — the `<dir>` of
 * `/api/page/<dir>/<slug>` and of the page's own id.
 *
 * For a default page it is the literal {@link PageDirectory}. For a typed
 * entity page it is the profile's declared ENTITY TYPE id (`articles`), NOT the
 * type's on-disk `directory` (`wiki/articles`): the on-disk value is a
 * multi-segment project-relative path and can never be one route segment, while
 * an entity type id is slug-safe by `src/profile/identity.ts` and is guaranteed
 * disjoint from `concepts`/`queries` by `rejectReservedEntityTypeNames` in
 * `src/profile/validate.ts`. So `id === \`${pageDirectory}/${slug}\`` holds for
 * both kinds of page, and a typed page's id IS its {@link EntityId}.
 *
 * This is deliberately a VIEWER-owned type rather than a widening of the shared
 * `PageDirectory`: that union is part of the OKF export/import interchange
 * contract and its frozen parity goldens, and typed entity pages have no
 * business changing export/import semantics.
 */
export type ViewerPageDirectory = string;

/**
 * The identifier of any page the viewer can address: a default page's
 * {@link PageId} (`concepts/<slug>`), or a typed entity page's branded
 * {@link EntityId} (`<entityType>/<slug>`). Both are string subtypes, so a
 * `PageId`-keyed set/map still accepts and compares them.
 */
export type ViewerPageId = PageId | EntityId;

/**
 * The identifier space of a graph node — the same union as
 * {@link ViewerPageId}, because every node is either a page or a ghost keyed in
 * the page id space. Aliased rather than re-spelled so the two cannot drift.
 * Wikilink nodes/edges keep their concrete `PageId` everywhere a default project
 * serializes them, so the default graph is byte-identical.
 */
export type GraphNodeId = ViewerPageId;

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
 * `ViewerWarning.code` for a citation whose source file is not on disk.
 * Exported so the producer (`snapshot.ts`, which appends the warning) and
 * the consumer (`server.ts`, which counts warnings by this code for
 * `unresolvedCitationCount`) share one literal instead of two that could
 * silently drift.
 */
export const UNRESOLVED_CITATION_CODE = "unresolved_citation";

/**
 * In-memory representation of one wiki page as the viewer sees it.
 * Includes everything the server needs to render `/api/page/...` without
 * touching the disk again per request.
 */
export interface ViewerPage {
  /** Namespaced canonical ID — `concepts/<slug>`, `queries/<slug>`, or `<entityType>/<slug>`. */
  id: ViewerPageId;
  /** Filename stem; the canonical filesystem-truth identifier. */
  slug: string;
  /** The namespace this page is addressed under. See {@link ViewerPageDirectory}. */
  pageDirectory: ViewerPageDirectory;
  /**
   * The profile entity type this page belongs to. ABSENT on default
   * `concepts`/`queries` pages, so a default project's envelope, page payload,
   * and search rows are byte-identical; present ONLY on a typed entity page,
   * where it always equals {@link pageDirectory} and is the discriminator every
   * surface branches on to tell the two kinds of page apart.
   */
  entityType?: string;
  /** Bounded relation/provenance projection, captured once for typed pages. */
  entityContext?: EntityContext;
  /** Display title. Falls back to slug when frontmatter has no title. */
  title: string;
  /** Absolute path on disk, used for editor links in the support rail. */
  filePath: string;
  /** Raw frontmatter object (empty when missing or malformed). */
  frontmatter: Record<string, unknown>;
  /** Declared frontmatter aliases; a wikilink whose slug matches one resolves here. */
  aliases?: string[];
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
  /** Computed source-freshness as of snapshot build (server start). Never live-updated. */
  freshness: PageFreshness;
}

/**
 * A viewer page collected from the DEFAULT `wiki/concepts` + `wiki/queries`
 * directories, narrowing {@link ViewerPage}'s widened id/directory back to the
 * concrete `PageId`/`PageDirectory` and pinning `entityType` absent.
 *
 * The wikilink graph, the concept/query counts, and bare-slug link resolution
 * are all defined over exactly these pages — a typed entity page is never a
 * wikilink target and never enters the wikilink graph (it reaches the graph as
 * a typed node via `GraphBuildOptions` instead). Keeping the narrow type is what
 * lets those surfaces stay `PageId`-keyed without a cast.
 */
export interface DefaultViewerPage extends ViewerPage {
  id: PageId;
  pageDirectory: PageDirectory;
  entityType?: undefined;
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
  /** Pages computed stale/orphaned at snapshot build. */
  stale: number;
  orphaned: number;
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
  id: ViewerPageId;
  pageDirectory: ViewerPageDirectory;
  slug: string;
  title: string;
  updatedAt: string;
  /** Mirrors {@link ViewerPage.entityType}: absent unless the row is a typed page. */
  entityType?: string;
}

/**
 * A single node in the wiki link graph. Real pages and ghost (dangling-target)
 * placeholders are both represented here; check `isDangling` to distinguish.
 */
export interface GraphNode {
  /** Namespaced canonical ID matching `ViewerPage.id`, the raw link target for
   *  ghosts, or the branded `EntityId` for a typed entity node (CLP 4b). */
  id: GraphNodeId;
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
  /**
   * Discriminator for typed entity nodes (CLP 4b). ABSENT on wikilink and ghost
   * nodes, so the default graph serialization is byte-identical; present only
   * on a typed entity node, where it is the literal `"entity"`.
   */
  nodeKind?: "entity";
  /**
   * The profile entity type a typed node belongs to (CLP 4b), e.g. `"person"`.
   * ABSENT on wikilink/ghost nodes. Lets the viewer/context group/tag typed
   * nodes by their declared entity type.
   */
  entityType?: string;
}

/** A directed edge between two wiki pages, or a typed relation edge (CLP 4b). */
export interface GraphEdge {
  source: GraphNodeId;
  target: GraphNodeId;
  /**
   * Discriminator for typed relation edges (CLP 4b). ABSENT on wikilink edges,
   * so the default graph serialization is byte-identical; present only on a
   * relation edge, where it is the literal `"relation"`.
   */
  edgeKind?: "relation";
  /** The profile relation type a typed edge represents (CLP 4b). ABSENT on wikilink edges. */
  relationType?: string;
  /**
   * Directionality of the relation type (CLP 4b). `"symmetric"` means the edge
   * has no inherent direction (the client renders it without an arrowhead).
   * `"directed"` keeps the arrowhead. ABSENT on wikilink edges and absent when
   * the relation's direction is unavailable, so the default graph stays
   * byte-identical and the client treats absent-direction as directed.
   */
  direction?: "directed" | "symmetric";
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
  /** Classification of state.json at snapshot build time. Exposed on /api/health for the corrupt/too-new-state banner. */
  stateStatus: StateStatus;
  /** Project metadata for the dashboard header. */
  project: ViewerProject;
  /** Frozen counts for `/api/pages` and `/api/health`. */
  counts: ViewerCounts;
  /** State of `wiki/index.md` at startup. */
  index: ViewerIndex;
  /** Top-N most recently updated pages for the dashboard. */
  recentPages: ViewerRecentPage[];
  /**
   * All readable pages: the default `concepts`-then-`queries` collector order
   * first, then the active profile's typed entity pages in collector order
   * (declared entity type, then directory order). Typed pages are absent for a
   * default project, so the default list is unchanged.
   */
  pages: ViewerPage[];
  /**
   * The active profile's DECLARED entity type ids — the allowlist that decides
   * which directory segments `/api/page/<dir>/<slug>` will address, alongside
   * the two default literals. Declared-but-empty types are included, so
   * addressing one yields an honest `page_not_found` rather than a shape error.
   * ABSENT for the built-in default profile, so no typed directory is
   * addressable there and the default snapshot is byte-identical.
   */
  entityTypes?: readonly string[];
  /**
   * Filenames present under `sources/` at startup, captured as a flat
   * list. The Slice 4 citation renderer uses these to set the `data-
   * resolved` flag on each chip without doing per-request directory
   * scans.
   */
  sourceFilenames: string[];
  /** Adjacency data for the `#/graph` route. Built once at snapshot time. */
  graph: GraphData;
  /**
   * Project-level read-surface health warnings, distinct from the per-page
   * `ViewerPage.warnings`. ABSENT (key omitted) for a healthy project so the
   * default snapshot is byte-identical (parity-safe); present ONLY when the
   * compile journal is `pending` (`incomplete-compile`) or `unavailable`
   * (`journal-unavailable`), so the viewer never renders partial post-crash or
   * tampered state as silently healthy.
   */
  warnings?: ViewerWarning[];
  /**
   * Active non-default profile summary (profileId, digest, per-type entity
   * counts, problems), MIRRORING the `status` profile block. ABSENT (undefined)
   * for the built-in default so the default snapshot is byte-identical. This is
   * a counts/problems block only — no entity-page rendering, routes, or
   * navigation. The legacy `counts.concepts`/`counts.queries` stay scoped to the
   * literal wiki/concepts + wiki/queries dirs in both cases.
   */
  profile?: ProfileSummaryBlock;
  /**
   * What the active profile DECLARES about its lifecycles and relation types —
   * the half of the `#/pipeline` panel no count collector carries. ABSENT for
   * the built-in default profile, which declares neither, so the default
   * snapshot is byte-identical. Joined with {@link profile}'s counts on the way
   * out (see `buildPipelineEnvelope`) rather than here, so the snapshot holds
   * one copy of each fact instead of two views of the same numbers.
   */
  pipeline?: PipelineDefinitions;
  /** Internal request-time artifact validation contract; never a wire field. */
  artifactDefinitions?: ProfilePack["artifacts"];
}
