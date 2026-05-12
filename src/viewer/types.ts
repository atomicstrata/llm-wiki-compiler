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
  /** Claim-level citations extracted from the body via `extractClaimCitations`. */
  citations: ClaimCitation[];
  /** Diagnostics surfaced for this page (parser issues, unresolved citations…). */
  warnings: ViewerWarning[];
}

/**
 * Snapshot of the entire viewable wiki captured once at startup. Subsequent
 * slices add fields (`counts`, `index`, `recentPages`, project metadata)
 * matching the spec's `/api/pages` envelope; Slice 1 captures the minimum
 * needed by the collector and the bare-slug resolver.
 */
export interface ViewerSnapshot {
  /** Absolute project root the snapshot was captured against. */
  root: string;
  /** ISO-8601 timestamp the snapshot was built at. */
  generatedAt: string;
  /** All readable pages, in collector order (concepts then queries). */
  pages: ViewerPage[];
}
