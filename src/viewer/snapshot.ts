/**
 * Build the frozen-at-startup `ViewerSnapshot` consumed by every viewer
 * endpoint. Every count, page list, and index payload that the HTTP
 * layer needs is captured here exactly once — v1 deliberately does not
 * live-watch the filesystem, so post-startup mutations are intentionally
 * invisible to the running viewer until it restarts.
 *
 * The snapshot consolidates six data sources:
 *   - `collectViewerPages` for the decorated DEFAULT page list AND the
 *     concept/query counts (deriving counts from the already-confined
 *     page list means symlinked entries dropped by the collector
 *     cannot quietly inflate the counts via a second unconfined scan)
 *   - `collectTypedViewerInputs` for a non-default profile's typed entity
 *     pages, in all three shapes they are needed in (page records, graph
 *     nodes/edges, route allowlist); `undefined` for the default profile
 *   - `readStateClassified` (read-only, never writes a `.bak`) for the
 *     compiled-source count AND as the input to the freshness snapshot
 *   - `buildFreshnessSnapshot` for per-page freshness and the aggregate
 *     stale/orphaned counts (one state read + one hash pass over sources/)
 *   - `countCandidates` for the pending-reviews count
 *   - `readdir(sources/)` for the cheap source-file count
 */

import { readdir, readFile, realpath } from "fs/promises";
import path from "path";
import { SOURCES_DIR } from "../utils/constants.js";
import { countCandidates } from "../compiler/candidates.js";
import { readStateClassified, isPlainObject } from "../utils/state.js";
import type { ClassifiedState } from "../utils/state.js";
import { collectViewerPages, decorateEntityPages, resolveBareSlugList } from "./collect.js";
import { extractWikilinkSlugs } from "../wiki/collect.js";
import { isMalformedCitationEntry, splitCitationMarker } from "../utils/markdown.js";
import { buildGraphData } from "./graph.js";
import { pageTimestamp } from "./page-fields.js";
import { buildFreshnessSnapshot, computeFreshness } from "../freshness/index.js";
import { collectProfileSummary } from "../profile/block.js";
import { journalHealthWarning } from "../trust/journal-health-warning.js";
import { collectTypedViewerInputs } from "./typed-pages.js";
import { attachEntityContexts } from "./entity-context.js";
import type { FreshnessSnapshot } from "../freshness/types.js";
import { UNRESOLVED_CITATION_CODE } from "./types.js";
import type {
  DefaultViewerPage,
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
  const [defaultPages, classified, pendingReviews, sourceFilenames, index, typed] =
    await Promise.all([
      collectViewerPages(root),
      readStateClassified(root),
      countCandidates(root),
      listSourceFiles(root),
      readIndexFile(root),
      collectTypedViewerInputs(root),
    ]);
  const freshnessSnapshot = await buildFreshnessSnapshot(root, classified);
  const decorate = buildPageDecorator(sourceFilenames, freshnessSnapshot);
  const annotatedDefault = defaultPages.map(decorate);
  const annotatedTyped = decorateEntityPages(typed?.pages ?? [], defaultPages).map(decorate);
  const pages = attachEntityContexts([...annotatedDefault, ...annotatedTyped], typed?.graph.relations ?? [], sourceFilenames);
  // Surface a pending/unavailable compile journal so the viewer never renders
  // partial post-crash or tampered state as silently healthy. ABSENT when the
  // journal is ok, so the default snapshot is byte-identical (parity-safe).
  const journalWarning = await journalHealthWarning(root);
  const profile = await collectProfileSummary(root);
  return {
    root,
    generatedAt: new Date().toISOString(),
    stateStatus: classified.status,
    project: buildProject(root),
    counts: buildCounts(annotatedDefault, sourceFilenames, pendingReviews, countableState(classified)),
    index: buildFullIndex(index, defaultPages),
    recentPages: buildRecentPages(pages),
    pages,
    sourceFilenames,
    // Typed pages reach the graph through `typed.graph` as entity nodes and
    // relation edges, NOT through this page list — passing them both ways would
    // mint two nodes for one page under the same id.
    graph: buildGraphData(annotatedDefault, typed?.graph),
    ...(journalWarning ? { warnings: [journalWarning] } : {}),
    ...(profile ? { profile } : {}),
    ...(typed ? { entityTypes: typed.entityTypes, pipeline: typed.pipeline, artifactDefinitions: typed.artifactDefinitions } : {}),
  };
}

/**
 * The per-page decoration every page in the snapshot receives, default and typed
 * alike: citation warnings resolved against the project's source files, then
 * computed freshness. Returned as a closure so the source-file set is built once
 * and both page lists provably get the SAME treatment.
 */
function buildPageDecorator(
  sourceFilenames: string[],
  freshness: FreshnessSnapshot,
): <T extends ViewerPage>(page: T) => T {
  const sourceFileSet = new Set(sourceFilenames);
  return <T extends ViewerPage>(page: T): T =>
    attachFreshness(annotateCitationWarnings(page, sourceFileSet), freshness);
}

/**
 * The `sources` map `buildCounts` may safely tally. A too-new/corrupt state
 * carries the RAW parsed object, which need not be v1-shaped (its `sources` may
 * be absent), so any non-ok state yields an empty map and `compiledSources`
 * fails closed instead of crashing.
 */
function countableState(classified: ClassifiedState): { sources: Record<string, unknown> } {
  return classified.status === "ok" ? classified.state : { sources: {} };
}

/** The captured `wiki/index.md` state plus its wikilinks resolved against the default pages. */
function buildFullIndex(
  index: { available: boolean; body: string },
  defaultPages: DefaultViewerPage[],
): ViewerIndex {
  return {
    available: index.available,
    href: INDEX_HREF,
    body: index.body,
    outgoingLinks: resolveBareSlugList(extractWikilinkSlugs(index.body), defaultPages),
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
 *
 * Applies equally to typed entity pages: a citation marker's resolvability is a
 * property of the body and the project's sources, not of the profile a page was
 * written under. Generic over the page type so a `DefaultViewerPage` stays one.
 */
function annotateCitationWarnings<T extends ViewerPage>(
  page: T,
  sourceFiles: ReadonlySet<string>,
): T {
  const extra: ViewerWarning[] = [];
  const markerPattern = /\^\[([^\]\n]+)\]/g;
  let match: RegExpExecArray | null;
  while ((match = markerPattern.exec(page.body)) !== null) {
    appendCitationWarningsForMarker(match[1], sourceFiles, extra);
  }
  if (extra.length === 0) return page;
  return { ...page, warnings: [...page.warnings, ...extra] };
}

/**
 * Derive the frozen counts from the annotated DEFAULT page list, source
 * filenames, candidates count, and state. Concept/query counts are derived from
 * pages (the already-confined collector list) so symlinked drops don't inflate
 * them.
 *
 * Typed entity pages are deliberately not counted here. `concepts`/`queries`
 * are documented as scoped to the literal `wiki/concepts` + `wiki/queries` dirs
 * and would exclude a typed page anyway; `stale`/`orphaned` are the freshness
 * tally OVER those same pages, and mixing in a corpus that has no source
 * ownership at all (see `classify` in src/freshness/index.ts) would put two
 * different populations behind one number with no way to tell them apart.
 *
 * Belt-and-suspenders: a non-plain-object `state.sources` (e.g. a too-new state
 * with no v1-shaped map) is coerced to `{}` so `compiledSources` cannot crash.
 */
function buildCounts(
  pages: DefaultViewerPage[],
  sourceFilenames: string[],
  pendingReviews: number,
  state: { sources: Record<string, unknown> },
): ViewerCounts {
  const sources = isPlainObject(state.sources) ? state.sources : {};
  return {
    concepts: pages.filter((p) => p.pageDirectory === "concepts").length,
    queries: pages.filter((p) => p.pageDirectory === "queries").length,
    sourceFiles: sourceFilenames.length,
    pendingReviews,
    compiledSources: Object.keys(sources).length,
    stale: pages.filter((p) => p.freshness.freshnessStatus === "stale").length,
    orphaned: pages.filter((p) => p.freshness.freshnessStatus === "orphaned").length,
  };
}

/**
 * Attach computed source-freshness to a page. Called once per page during
 * snapshot build so freshness is frozen at startup alongside all other
 * snapshot data.
 *
 * Typed entity pages go through the SAME computation rather than being handed a
 * default: source ownership is recorded only for default concepts, so a typed
 * page finds no owners and lands on `unverified` by the path `classify` already
 * documents — while still picking up the `contradicted`/`archived` frontmatter
 * signals if it declares them.
 */
function attachFreshness<T extends ViewerPage>(page: T, snapshot: FreshnessSnapshot): T {
  return {
    ...page,
    freshness: computeFreshness(
      { slug: page.slug, pageDirectory: page.pageDirectory, frontmatter: page.frontmatter },
      snapshot,
    ),
  };
}

/** Classify every source entry inside one `^[...]` marker. */
function appendCitationWarningsForMarker(
  raw: string,
  sourceFiles: ReadonlySet<string>,
  into: ViewerWarning[],
): void {
  for (const entry of splitCitationMarker(raw)) {
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
        code: UNRESOLVED_CITATION_CODE,
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
 * Top-N recently updated pages for the dashboard, ranked by each page's
 * EFFECTIVE timestamp (see {@link pageTimestamp}) — so a saved query, which
 * carries `createdAt` and no `updatedAt`, ranks by when it was actually
 * written instead of being pinned below every dated concept. Pages declaring
 * no timestamp at all still sort to the end with an empty string, keeping the
 * list deterministic.
 */
function buildRecentPages(pages: ViewerPage[]): ViewerRecentPage[] {
  const rows: ViewerRecentPage[] = pages.map((page) => ({
    id: page.id,
    pageDirectory: page.pageDirectory,
    slug: page.slug,
    title: page.title,
    updatedAt: pageTimestamp(page.frontmatter),
    ...(page.entityType !== undefined ? { entityType: page.entityType } : {}),
  }));
  rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return rows.slice(0, RECENT_PAGES_LIMIT);
}
