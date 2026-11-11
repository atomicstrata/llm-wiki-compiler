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
 *   - selected source discovery for the source-file count and read allowlist
 *
 * Disk access: {@link buildViewerSnapshot} builds a private local-disk
 * {@link ViewerSnapshotSources} from the project root and runs the one body,
 * {@link buildViewerSnapshotFrom}. EIGHT of the nine inputs are read through
 * what the sources bind (pages, compile state, the pending count, the source
 * entries, the index file, source freshness, the journal warning and typed
 * pages). The ninth, the profile summary, is read through sources too. Its
 * artifact health resolves refs over the artifact store's leaf reads and
 * verifies provenance over the preparation store's leaf reads, whose
 * lifecycle authority still reads a project root on disk. That is not nine of
 * nine. See the type.
 */

import { locationRealPath } from "../storage/disk-locations.js";
import { diskLocalReads } from "../storage/disk-local-reads.js";
import { diskLocalRecordDirs } from "../storage/disk-local-record-dirs.js";
import { diskLocalRecords } from "../storage/disk-local-records.js";
import type { LegacyLocalEntityScans, LegacyLocalReads } from "../storage/legacy-local-reads.js";
import type { LegacyLocalRecordDirs } from "../storage/legacy-local-record-dirs.js";
import type { LegacyLocalRecords } from "../storage/legacy-local-records.js";
import path from "path";
import { listSelectedSourceEntriesFrom } from "../sources/scan.js";
import { countCandidatesFrom } from "../compiler/candidate-read.js";
import { readStateClassifiedFrom, isPlainObject } from "../utils/state.js";
import { readCappedNoFollow } from "../utils/confined-read.js";
import type { ClassifiedState } from "../utils/state.js";
import { collectViewerPagesFrom, decorateEntityPages, linkPages, resolveWikilinkTargets } from "./collect.js";
import { extractWikilinkSlugs } from "../wiki/collect.js";
import { isMalformedCitationEntry, splitCitationMarker } from "../utils/markdown.js";
import { buildGraphData, type GraphBuildOptions } from "./graph.js";
import { pageTimestamp } from "./page-fields.js";
import { buildFreshnessSnapshotFrom, computeFreshness, diskSourceFreshnessSources } from "../freshness/index.js";
import type { SourceFreshnessSources } from "../freshness/index.js";
import { collectProfileSummaryFrom, diskProfileSummarySources, type ProfileSummarySources } from "../profile/block.js";
import type { EntityPageReads } from "../profile/lifecycle-read.js";
import type { EventReadSources } from "../events/store-read.js";
import { diskJournalReadSources } from "../trust/journal-classify.js";
import type { JournalReadSources } from "../trust/journal-classify.js";
import { journalHealthWarningFrom } from "../trust/journal-health-warning.js";
import { collectTypedViewerInputsFrom } from "./typed-pages.js";
import type { EffectiveProfileSources } from "../profile/load.js";
import type { GraphStoreReads } from "../utils/jsonl-store.js";
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
 * Everything {@link buildViewerSnapshotFrom} reads: the display root, and
 * `bindings`.
 *
 * `bindings` are what is bound here: four storage bindings, and narrow
 * capabilities owned by their consumers (the index file's, declared here;
 * source freshness's, declared by freshness; the journal's, declared by the
 * journal classifier; the effective profile's, declared by the profile loader,
 * with the graph-store read; and for the profile summary the event store's,
 * the entity-page read, the root's real path, the artifact store's leaf reads
 * and the preparation store's leaf reads). Typed pages and the summary
 * scan through the same `scans` the default pages use, and load the profile
 * through the same `profile`. So a snapshot resolves the profile twice,
 * exactly as it always read it twice, and reads the relation store more than
 * once; this type does not make any two reads agree, and a snapshot built from
 * it is NOT thereby profile-consistent.
 * `artifacts` is the artifact store's leaf reads, which the summary's
 * artifact health hands to the resolver; `provenance` is the preparation
 * store's leaf reads, which it hands to the provenance verifier. STILL
 * DISK-ONLY UNDERNEATH: the lifecycle read and its proof, carried in
 * `provenance`, are the real capture and check for the root.
 * NOTHING TIES ANY TWO BINDINGS TO ONE PROJECT. A caller could pass bindings
 * for two different projects and nothing here would notice; production never
 * does, because it builds everything from one root. This is not
 * `ProjectStore`, not a hosted or access-control contract, and it selects no
 * backend.
 */
export interface ViewerSnapshotSources {
  /** The root as the caller holds it. DISPLAY ONLY: the snapshot's `root` and its project header. */
  root: string;
  /** What is bound: four storage bindings, then the index file, source freshness, the journal, typed pages, and the profile summary's own reads. */
  bindings: {
    /** Default pages: `wiki/concepts`, then `wiki/queries`. */
    scans: LegacyLocalEntityScans;
    /** The compile state record. */
    records: LegacyLocalRecords;
    /** The pending review queue, counted through the tolerant list. */
    candidateDirs: LegacyLocalRecordDirs;
    /** Source entries, and the project configuration that selects them. */
    reads: LegacyLocalReads;
    /**
     * The text of `wiki/index.md`, or `null` when nothing is at exactly its
     * expected place (the index, or `wiki`, is a link). REJECTS with the raw
     * error when resolving or reading fails, a missing index included. Called once.
     */
    readIndexText(): Promise<string | null>;
    /** Where the sources the compile state names are found and read; the body runs the real freshness over it. */
    freshness: SourceFreshnessSources;
    /** Where the project's journal is found; the body runs the real health read and warning mapping over it. */
    journal: JournalReadSources;
    /** The effective profile, for typed pages and again for the profile summary: the body runs the real loader over it, once for each. */
    profile: EffectiveProfileSources;
    /** The relation store, for typed pages' edges and for the summary, through the graph-store read. */
    graph: GraphStoreReads;
    /** The event store and its head anchor, for the summary's event count. */
    events: EventReadSources;
    /** One confined page per distinct relation endpoint, for the summary's standing check. */
    pages: EntityPageReads;
    /** What a pinned artifact ref resolves to, for the summary's artifact health. Asked only for a non-default profile that declares artifact types. */
    artifacts: ProfileSummarySources["artifacts"];
    /** The preparation store's leaf reads, for whether a run vouches for a gated page's pinned artifact, in the same check. */
    provenance: ProfileSummarySources["provenance"];
    /** The project root's real path, or `null`: the summary relativises problem paths against it. Asked last. */
    realRoot(): Promise<string | null>;
  };
}

/**
 * Build the immutable startup snapshot for a project root. Reads pages,
 * counts, source state, candidates, and the optional `wiki/index.md`
 * exactly once and returns a fully populated `ViewerSnapshot`. Callers
 * must NOT re-derive any of these from disk on a per-request path —
 * `readLintCache` in `src/viewer/health.ts` is the sole exception.
 */
export function buildViewerSnapshot(root: string): Promise<ViewerSnapshot> {
  return buildViewerSnapshotFrom(diskViewerSnapshotSources(root));
}

/**
 * LOCAL DISK. The sources for the project at `root`. Building them does no
 * I/O. Everything the profile summary reads comes from THE ONE summary
 * builder, artifact health's two store reads included, so the snapshot and
 * `collectProfileSummary(root)` are wired by the same code.
 */
function diskViewerSnapshotSources(root: string): ViewerSnapshotSources {
  const summary = diskProfileSummarySources(root);
  return {
    root,
    bindings: {
      scans: summary.scans,
      records: diskLocalRecords(root),
      candidateDirs: diskLocalRecordDirs(root),
      reads: diskLocalReads(root),
      readIndexText: () => readDiskIndexText(root),
      freshness: diskSourceFreshnessSources(root),
      journal: diskJournalReadSources(root),
      profile: summary.profile,
      graph: summary.graph,
      events: summary.events,
      pages: summary.pages,
      artifacts: summary.artifacts,
      provenance: summary.provenance,
      realRoot: summary.realRoot,
    },
  };
}

/**
 * {@link buildViewerSnapshot} over {@link ViewerSnapshotSources}. The six first
 * reads START TOGETHER, in this order: pages, compile state, pending count,
 * source entries, the index file, typed inputs. Then, one after another:
 * freshness (the real one, over the bound sources, given the classified state),
 * the journal warning (the real one, over the bound journal), the profile
 * summary (the real one, over the bound sources). The index read is the one input
 * with a failure meaning of its own (see {@link readIndex}); nothing else is
 * caught here, and a rejection from any other input rejects the build.
 */
export async function buildViewerSnapshotFrom(sources: ViewerSnapshotSources): Promise<ViewerSnapshot> {
  const { root, bindings } = sources;
  const [defaultPages, classified, pendingReviews, sourceFilenames, index, typed] =
    await Promise.all([
      collectViewerPagesFrom(bindings.scans),
      readStateClassifiedFrom(bindings.records),
      countCandidatesFrom(bindings.candidateDirs),
      listSelectedSourceEntriesFrom(bindings.reads),
      readIndex(bindings),
      collectTypedViewerInputsFrom({ profile: bindings.profile, scans: bindings.scans, graph: bindings.graph }),
    ]);
  const freshnessSnapshot = await buildFreshnessSnapshotFrom(bindings.freshness, classified);
  const decorate = buildPageDecorator(sourceFilenames, freshnessSnapshot);
  const typedPages = decorateEntityPages(typed?.pages ?? []);
  const linkable = [...defaultPages, ...typedPages];
  // Typed pages link, and are linked to by qualified links, only once both lists exist.
  if (typedPages.length > 0) linkPages(linkable);
  const annotatedDefault = defaultPages.map(decorate);
  const annotatedTyped = typedPages.map(decorate);
  const pages = attachEntityContexts([...annotatedDefault, ...annotatedTyped], typed?.graph.relations ?? [], sourceFilenames);
  // Surface a pending/unavailable compile journal so the viewer never renders
  // partial post-crash or tampered state as silently healthy. ABSENT when the
  // journal is ok, so the default snapshot is byte-identical (parity-safe).
  const journalWarning = await journalHealthWarningFrom(bindings.journal);
  const profile = await collectProfileSummaryFrom({
    profile: bindings.profile, scans: bindings.scans, graph: bindings.graph, events: bindings.events, pages: bindings.pages,
    artifacts: bindings.artifacts, provenance: bindings.provenance, realRoot: () => bindings.realRoot(),
  });
  return {
    root,
    generatedAt: new Date().toISOString(),
    stateStatus: classified.status,
    project: buildProject(root),
    counts: buildCounts(annotatedDefault, sourceFilenames, pendingReviews, countableState(classified)),
    index: buildFullIndex(index, linkable),
    recentPages: buildRecentPages(pages.filter(isKnowledgePage)),
    pages,
    sourceFilenames,
    // Typed pages reach the graph through `typed.graph` as entity nodes and
    // relation edges, NOT through this page list — passing them both ways would
    // mint two nodes for one page under the same id. Their wikilinks ride on
    // those entity nodes.
    graph: buildGraphData(annotatedDefault.filter(isKnowledgePage), typed && withEntityLinks(typed.graph, typedPages)),
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

/** The captured `wiki/index.md` state plus its wikilinks resolved against every page. */
function buildFullIndex(
  index: { available: boolean; body: string },
  pages: ViewerPage[],
): ViewerIndex {
  return {
    available: index.available,
    href: INDEX_HREF,
    body: index.body,
    outgoingLinks: resolveWikilinkTargets(extractWikilinkSlugs(index.body), pages),
  };
}

/** The typed graph inputs, each entity node carrying its page's resolved wikilinks. */
function withEntityLinks(graph: GraphBuildOptions, typedPages: ViewerPage[]): GraphBuildOptions {
  const linksById = new Map(typedPages.map((page) => [page.id, page.outgoingLinks]));
  const entityPages = graph.entityPages?.map((node) => ({ ...node, outgoingLinks: linksById.get(node.id) ?? [] }));
  return entityPages ? { ...graph, entityPages } : graph;
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
 * The index file as the snapshot carries it. Missing index is not an error:
 * many projects compile without an index page, and the viewer renders an
 * "index unavailable" placeholder for the `/#/index` route. So `null` and ANY
 * rejection from the reader mean the same thing here: unavailable, empty body.
 */
async function readIndex(source: { readIndexText(): Promise<string | null> }): Promise<{ available: boolean; body: string }> {
  try {
    const body = await source.readIndexText();
    return body === null ? { available: false, body: "" } : { available: true, body };
  } catch {
    return { available: false, body: "" };
  }
}

/**
 * LOCAL DISK. Read `wiki/index.md` under `root`: resolve the root, resolve the
 * index, require the resolved path to be the expected one, then read it once.
 * `null` when it is not exactly in place or the read is not `ok`; rejects raw
 * when a resolve fails.
 *
 * Stricter than "stays under project root": `realpath(wiki/index.md)`
 * must equal the literal canonical path `<root>/wiki/index.md`. A
 * symlinked `wiki/index.md` is treated as unavailable, even when the
 * link target also lives inside the project — pointing the index at
 * (say) `<root>/README.md` would let the index endpoint render
 * content that has no business being the project's compiled index.
 * A symlinked `wiki/` directory is dropped by the same equality check.
 *
 * The read itself goes through the non-blocking no-follow reader, so a
 * named pipe planted at `wiki/index.md` is unavailable rather than a read
 * that never returns. That matters more now that the snapshot is rebuilt
 * while the viewer runs: a stuck read would stall every later refresh.
 * The index has no size limit of its own, hence the infinite cap.
 */
async function readDiskIndexText(root: string): Promise<string | null> {
  const canonicalRoot = await locationRealPath(root);
  const expectedIndex = path.join(canonicalRoot, "wiki", "index.md");
  const resolved = await locationRealPath(expectedIndex);
  if (resolved !== expectedIndex) return null;
  const read = await readCappedNoFollow(resolved, Number.POSITIVE_INFINITY);
  return read.kind === "ok" ? read.body : null;
}

/**
 * Whether a page is knowledge rather than the generated timeline. Day and week
 * pages have their own screen; in "recently updated" a re-dated week would crowd
 * out the pages a compile actually learned, and in the graph every day would be
 * a hub tying together unrelated pages that merely happened the same day.
 */
function isKnowledgePage(page: ViewerPage): boolean {
  return page.pageDirectory !== "timeline";
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
