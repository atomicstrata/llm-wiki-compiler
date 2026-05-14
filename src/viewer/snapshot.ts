/**
 * Build the frozen-at-startup `ViewerSnapshot` consumed by every viewer
 * endpoint. Every count, page list, and index payload that the HTTP
 * layer needs is captured here exactly once — v1 deliberately does not
 * live-watch the filesystem, so post-startup mutations are intentionally
 * invisible to the running viewer until it restarts.
 *
 * The snapshot consolidates four data sources:
 *   - `collectViewerPages` for the decorated page list AND the
 *     concept/query counts (deriving counts from the already-confined
 *     page list means symlinked entries dropped by the collector
 *     cannot quietly inflate the counts via a second unconfined scan)
 *   - `readState` for the compiled-source count
 *   - `countCandidates` for the pending-reviews count
 *   - `readdir(sources/)` for the cheap source-file count
 */

import { readdir, readFile, realpath } from "fs/promises";
import path from "path";
import { SOURCES_DIR } from "../utils/constants.js";
import { countCandidates } from "../compiler/candidates.js";
import { readState } from "../utils/state.js";
import { collectViewerPages, resolveBareSlugList } from "./collect.js";
import { extractWikilinkSlugs } from "../wiki/collect.js";
import { isMalformedCitationEntry } from "../utils/markdown.js";
import type {
  ViewerCounts,
  ViewerIndex,
  ViewerPage,
  ViewerProject,
  ViewerRecentPage,
  ViewerSnapshot,
  ViewerWarning,
} from "./types.js";

const RECENT_PAGES_LIMIT = 8;
const INDEX_HREF = "/#/index";

/**
 * Build the immutable startup snapshot for a project root. Reads pages,
 * counts, source state, candidates, and the optional `wiki/index.md`
 * exactly once and returns a fully populated `ViewerSnapshot`. Callers
 * must NOT re-derive any of these from disk on a per-request path —
 * `readLintCache` in `src/viewer/health.ts` is the sole exception.
 */
export async function buildViewerSnapshot(root: string): Promise<ViewerSnapshot> {
  const [pages, state, pendingReviews, sourceFilenames, index] = await Promise.all([
    collectViewerPages(root),
    readState(root),
    countCandidates(root),
    listSourceFiles(root),
    readIndexFile(root),
  ]);
  const project = buildProject(root);
  // Concept/query counts are derived from `pages`, the already-confined
  // viewer page list, NOT from a second unconfined directory scan.
  // Anything the collector dropped for path-safety reasons (symlinked
  // file or directory) is therefore also excluded from the counts.
  const counts: ViewerCounts = {
    concepts: pages.filter((p) => p.pageDirectory === "concepts").length,
    queries: pages.filter((p) => p.pageDirectory === "queries").length,
    sourceFiles: sourceFilenames.length,
    pendingReviews,
    compiledSources: Object.keys(state.sources).length,
  };
  const fullIndex: ViewerIndex = {
    available: index.available,
    href: INDEX_HREF,
    body: index.body,
    outgoingLinks: resolveBareSlugList(extractWikilinkSlugs(index.body), pages),
  };
  const sourceFileSet = new Set(sourceFilenames);
  const annotatedPages = pages.map((page) => annotateCitationWarnings(page, sourceFileSet));
  return {
    root,
    generatedAt: new Date().toISOString(),
    project,
    counts,
    index: fullIndex,
    recentPages: buildRecentPages(annotatedPages),
    pages: annotatedPages,
    sourceFilenames,
  };
}

/**
 * Append `unresolved_citation` and `malformed_citation` warnings to a
 * page based on its parsed citations and the project's source-file
 * list. Slice 1 only produced parser-level warnings; citation
 * resolvability needs the snapshot's source-file list, so this is the
 * earliest layer that can decide.
 *
 * The body is re-scanned for raw `^[…]` markers (rather than iterating
 * `page.citations`) because `extractClaimCitations` drops citations
 * whose ONLY entry has an invalid line range — but those still need a
 * `malformed_citation` warning. Scanning the body gives every marker a
 * chance to be classified.
 */
function annotateCitationWarnings(page: ViewerPage, sourceFiles: ReadonlySet<string>): ViewerPage {
  const extra: ViewerWarning[] = [];
  const markerPattern = /\^\[([^\]\n]+)\]/g;
  let match: RegExpExecArray | null;
  while ((match = markerPattern.exec(page.body)) !== null) {
    appendCitationWarningsForMarker(match[1], sourceFiles, extra);
  }
  if (extra.length === 0) return page;
  return { ...page, warnings: [...page.warnings, ...extra] };
}

/** Classify every comma-separated entry inside one `^[…]` marker. */
function appendCitationWarningsForMarker(
  raw: string,
  sourceFiles: ReadonlySet<string>,
  into: ViewerWarning[],
): void {
  for (const entry of raw.split(",")) {
    const trimmed = entry.trim();
    if (trimmed.length === 0) continue;
    if (isMalformedCitationEntry(trimmed)) {
      into.push({
        code: "malformed_citation",
        message: `Malformed citation entry: ${trimmed}`,
      });
      continue;
    }
    const file = trimmed.split(/[:#]/)[0];
    if (file.length > 0 && !sourceFiles.has(file)) {
      into.push({
        code: "unresolved_citation",
        message: `Source not found: ${file}`,
      });
    }
  }
}


/** Project title and bare directory name for the dashboard header. */
function buildProject(root: string): ViewerProject {
  const rootName = path.basename(root);
  return { title: rootName, rootName };
}

/**
 * List filenames directly under `sources/`. Returns an empty array when
 * the directory is missing. The Slice 4 citation renderer uses this list
 * to mark each chip `data-resolved` without per-request directory scans;
 * `counts.sourceFiles` is the cheap `.length` of the same list.
 *
 * Stricter than "stays under project root": `realpath(<root>/sources)`
 * must equal the literal canonical path `<canonicalRoot>/sources`. A
 * symlinked `sources/` directory — even pointing in-root — returns an
 * empty list, matching the same containment posture the wiki collector
 * uses for `wiki/concepts/` and `wiki/queries/`. Symlinked entries
 * inside the directory are excluded by `Dirent.isFile()` (which returns
 * false for symlinks since `withFileTypes` does not follow them).
 */
async function listSourceFiles(root: string): Promise<string[]> {
  let canonicalRoot: string;
  try {
    canonicalRoot = await realpath(root);
  } catch {
    return [];
  }
  const expectedDir = path.join(canonicalRoot, SOURCES_DIR);
  let realDir: string;
  try {
    realDir = await realpath(expectedDir);
  } catch {
    return [];
  }
  if (realDir !== expectedDir) return [];
  try {
    const entries = await readdir(realDir, { withFileTypes: true });
    return entries.filter((e) => e.isFile()).map((e) => e.name);
  } catch {
    return [];
  }
}

/**
 * Read `wiki/index.md` if present. Missing index is not an error: many
 * projects compile without an index page, and the viewer renders an
 * "index unavailable" placeholder for the `/#/index` route.
 *
 * Stricter than "stays under project root": `realpath(wiki/index.md)`
 * must equal the literal canonical path `<root>/wiki/index.md`. A
 * symlinked `wiki/index.md` is treated as unavailable, even when the
 * link target also lives inside the project — pointing the index at
 * (say) `<root>/README.md` would let the index endpoint render
 * content that has no business being the project's compiled index.
 * A symlinked `wiki/` directory is dropped by the same equality check.
 */
async function readIndexFile(root: string): Promise<{ available: boolean; body: string }> {
  let canonicalRoot: string;
  try {
    canonicalRoot = await realpath(root);
  } catch {
    return { available: false, body: "" };
  }
  const expectedIndex = path.join(canonicalRoot, "wiki", "index.md");
  let resolved: string;
  try {
    resolved = await realpath(expectedIndex);
  } catch {
    return { available: false, body: "" };
  }
  if (resolved !== expectedIndex) {
    return { available: false, body: "" };
  }
  try {
    const body = await readFile(resolved, "utf-8");
    return { available: true, body };
  } catch {
    return { available: false, body: "" };
  }
}

/**
 * Top-N recently updated pages for the dashboard. Pages without an
 * `updatedAt` frontmatter field sort to the end with an empty string so
 * the list remains deterministic.
 */
function buildRecentPages(pages: ViewerPage[]): ViewerRecentPage[] {
  const rows: ViewerRecentPage[] = pages.map((page) => ({
    id: page.id,
    pageDirectory: page.pageDirectory,
    slug: page.slug,
    title: page.title,
    updatedAt:
      typeof page.frontmatter.updatedAt === "string" ? (page.frontmatter.updatedAt as string) : "",
  }));
  rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return rows.slice(0, RECENT_PAGES_LIMIT);
}

