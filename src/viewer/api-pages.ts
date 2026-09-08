/**
 * The viewer's two page endpoints: the `/api/pages` bootstrap envelope and the
 * per-page `/api/page/:directory/:slug` payload.
 *
 * Split out of `server.ts` at the `handleApi*` seam so that file stays about
 * transport — security headers, origin policy, routing — while everything that
 * decides what a page LOOKS LIKE over the wire lives together. Both handlers
 * serve from the frozen `ViewerSnapshot` and never touch the filesystem.
 *
 * The directory segment of `/api/page/:directory/:slug` is the security-relevant
 * input here. It used to be a comparison against two literals; a non-default
 * profile's entity types are addressable too, so it is now confined by an
 * allowlist DERIVED FROM THE ACTIVE PROFILE — see {@link isAllowedDirectory} for
 * why that is a membership test on a raw segment rather than a decode-and-match.
 */

import type { ServerResponse } from "http";
import { pageTimestamp, viewerPageKind } from "./page-fields.js";
import { buildPipelineEnvelope } from "./pipeline.js";
import { assertSafeSlug, PathSafetyError } from "./path-safety.js";
import { tryRenderBody, writeJson, writeJsonError, writeRenderFailed } from "./respond.js";
import { UNRESOLVED_CITATION_CODE } from "./types.js";
import type { ViewerPage, ViewerPageDirectory, ViewerSnapshot } from "./types.js";
import type { PageDirectory } from "../export/types.js";

/** Profile id reported when the project runs the built-in default profile. */
const DEFAULT_PROFILE_ID = "default";

/**
 * The two directories every project can address, whatever profile it runs.
 * Typed as `PageDirectory` so widening that shared union without revisiting this
 * allowlist is a compile error rather than a silently unreachable directory.
 */
const DEFAULT_DIRECTORIES: readonly PageDirectory[] = ["concepts", "queries"];

/** `/api/pages` — the full bootstrap envelope: project/profile identity, stateStatus, counts, graph summary, recent pages, and the page list. */
export function handleApiPages(res: ServerResponse, snapshot: ViewerSnapshot): void {
  writeJson(res, 200, {
    project: snapshot.project,
    stateStatus: snapshot.stateStatus,
    profileId: snapshot.profile?.profileId ?? DEFAULT_PROFILE_ID,
    counts: {
      concepts: snapshot.counts.concepts,
      queries: snapshot.counts.queries,
      sourceFiles: snapshot.counts.sourceFiles,
      pendingReviews: snapshot.counts.pendingReviews,
      compiledSources: snapshot.counts.compiledSources,
      stale: snapshot.counts.stale,
      orphaned: snapshot.counts.orphaned,
    },
    graph: graphSummary(snapshot),
    sourceFilenames: snapshot.sourceFilenames,
    index: { available: snapshot.index.available, href: snapshot.index.href },
    recentPages: snapshot.recentPages,
    pages: snapshot.pages.map(pageListRow),
    updatedAt: snapshot.generatedAt,
    ...profileProblemFields(snapshot.profile),
    ...profilePipelineField(snapshot),
  });
}

/**
 * The active profile's lifecycle and relation model, serialised ONLY when a
 * non-default profile is active — the same omitted-when-absent rule
 * {@link profileProblemFields} follows, and for the same reason: a default
 * project declares no lifecycle and no relation type, so its envelope must not
 * grow a key describing either.
 *
 * The counts inside it (valid pages per type, the unfiltered state tally, live
 * relation counts) already existed on `snapshot.profile`; the declarations come
 * from the loaded pack via `snapshot.pipeline`. Joining them here rather than on
 * the client means the panel reads one list instead of three maps it would have
 * to align itself.
 */
function profilePipelineField(snapshot: ViewerSnapshot): Record<string, unknown> {
  const pipeline = buildPipelineEnvelope(snapshot.pipeline, snapshot.profile);
  return pipeline ? { profilePipeline: pipeline } : {};
}

/**
 * The profile collector's problems, serialised ONLY when there is at least one.
 *
 * The data exists so a non-default project with a bad entity directory or an
 * invalid entity page is never reported as silently healthy — but it stopped at
 * the snapshot until now, so the header could still read ALL CLEAR over a broken
 * project. Omitted-when-clean keeps a default-profile envelope byte-identical and
 * lets the client treat absence as "nothing wrong" without a second flag.
 *
 * Both fields ship together because `problems` is CAPPED (`PROFILE_PROBLEM_CAP`)
 * while `problemTotal` is the true count: without the total, a truncated list
 * would read as the whole set.
 */
function profileProblemFields(profile: ViewerSnapshot["profile"]): Record<string, unknown> {
  if (!profile?.problems?.length) return {};
  return { profileProblems: profile.problems, profileProblemTotal: profile.problemTotal };
}

/**
 * Node/edge/dangling totals for the dashboard's graph panel and its
 * "needs attention" card. Summarised here so the dashboard does not have
 * to fetch the full `/api/graph` adjacency payload for three integers.
 */
function graphSummary(snapshot: ViewerSnapshot): Record<string, number> {
  return {
    nodeCount: snapshot.graph.nodes.length,
    edgeCount: snapshot.graph.edges.length,
    danglingCount: snapshot.graph.nodes.filter((node) => node.isDangling === true).length,
  };
}

/** Count a page's warnings carrying the given stable code. */
function countWarnings(page: ViewerPage, code: string): number {
  return page.warnings.filter((warning) => warning.code === code).length;
}

/** Per-page row shape returned in `/api/pages.pages`. */
function pageListRow(page: ViewerPage): Record<string, unknown> {
  return {
    id: page.id,
    pageDirectory: page.pageDirectory,
    slug: page.slug,
    title: page.title,
    kind: viewerPageKind(page),
    summary: typeof page.frontmatter.summary === "string" ? page.frontmatter.summary : "",
    updatedAt: pageTimestamp(page.frontmatter),
    warnings: page.warnings,
    freshness: page.freshness,
    citationCount: page.citations.length,
    unresolvedCitationCount: countWarnings(page, UNRESOLVED_CITATION_CODE),
    ...entityTypeField(page),
  };
}

/**
 * The page's `entityType`, serialised ONLY for a typed entity page. Omitted (key
 * absent) on every default page, so a default project's rows are byte-identical
 * and a client can treat absence as "this is a default concept or query".
 */
function entityTypeField(page: ViewerPage): Record<string, unknown> {
  return page.entityType !== undefined ? { entityType: page.entityType } : {};
}

/**
 * `/api/page/:directory/:slug` — single page payload with server-rendered
 * sanitized HTML. Serves default `concepts`/`queries` pages and, on a project
 * running a non-default profile, typed entity pages at their entity type
 * (`/api/page/articles/<slug>`). Any warnings come from the collector
 * (missing/malformed frontmatter, missing title) or the citation annotator.
 */
export function handleApiPage(
  res: ServerResponse,
  pathname: string,
  snapshot: ViewerSnapshot,
  isLoopback: boolean,
): void {
  const segments = pathname.replace(/^\/api\/page\//, "").split("/");
  if (segments.length !== 2) {
    writeJsonError(res, 400, "bad_request", "Expected /api/page/:directory/:slug");
    return;
  }
  const [directorySegment, encodedSlug] = segments;
  const target = safeDecodeSlug(directorySegment, encodedSlug, addressableDirectories(snapshot));
  if (!target) {
    writeJsonError(res, 400, "bad_request", "Invalid directory or slug.");
    return;
  }
  const page = snapshot.pages.find(
    (p) => p.pageDirectory === target.directory && p.slug === target.slug,
  );
  if (!page) {
    writeJsonError(res, 404, "page_not_found", `${target.directory}/${target.slug}`);
    return;
  }
  writePageOrRenderFailure(res, page, snapshot, isLoopback);
}

/** Render the page body and write its payload, or the `render_failed` envelope. */
function writePageOrRenderFailure(
  res: ServerResponse,
  page: ViewerPage,
  snapshot: ViewerSnapshot,
  isLoopback: boolean,
): void {
  const rendered = tryRenderBody(page.body, snapshot, isLoopback);
  if (rendered === null) {
    writeRenderFailed(res);
    return;
  }
  writeJson(res, 200, pagePayload(page, snapshot, rendered.html));
}

/**
 * Every directory segment this snapshot will address: the two default literals
 * plus the ACTIVE PROFILE's declared entity type ids. Built from the frozen
 * snapshot, so it is the profile's own declaration and never anything derived
 * from the request. A default project contributes nothing extra, so no typed
 * directory is addressable there.
 */
function addressableDirectories(snapshot: ViewerSnapshot): ReadonlySet<string> {
  return new Set<string>([...DEFAULT_DIRECTORIES, ...(snapshot.entityTypes ?? [])]);
}

/**
 * Decode the slug and confine the directory so a bad input on either fails with
 * one uniform 400. Resolves with `null` for any structural rejection.
 */
function safeDecodeSlug(
  directorySegment: string,
  encodedSlug: string,
  allowed: ReadonlySet<string>,
): { directory: ViewerPageDirectory; slug: string } | null {
  if (!isAllowedDirectory(directorySegment, allowed)) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(encodedSlug);
  } catch {
    return null;
  }
  if (!isSafeSlug(decoded)) return null;
  return { directory: directorySegment, slug: decoded };
}

/**
 * A directory segment is addressable only when it clears the SAME structural
 * floor a slug does — no `.`/`..`, no separators, no NUL — and is a member of
 * the profile-derived allowlist. Never a pattern match on the request.
 *
 * The segment is deliberately NOT percent-decoded first. `concepts`, `queries`
 * and every profile entity type id are slug-safe by construction (the grammar in
 * `src/profile/identity.ts`, plus `rejectReservedEntityTypeNames` in
 * `src/profile/validate.ts` keeping entity types disjoint from the two default
 * names), so a legitimate directory never needs encoding. Refusing to decode
 * leaves exactly one spelling per directory and denies a caller the decode pass
 * that would be needed to smuggle `..`, a separator, or a NUL through as one.
 */
function isAllowedDirectory(segment: string, allowed: ReadonlySet<string>): boolean {
  return isSafeSlug(segment) && allowed.has(segment);
}

/** True when `value` clears `assertSafeSlug`; a `PathSafetyError` is the rejection. */
function isSafeSlug(value: string): boolean {
  try {
    assertSafeSlug(value);
    return true;
  } catch (err) {
    if (err instanceof PathSafetyError) return false;
    throw err;
  }
}

/** Build the JSON payload for `/api/page/:dir/:slug`. */
function pagePayload(
  page: ViewerPage,
  snapshot: ViewerSnapshot,
  renderedHtml: string,
): Record<string, unknown> {
  return {
    id: page.id,
    title: page.title,
    pageDirectory: page.pageDirectory,
    slug: page.slug,
    html: renderedHtml,
    citations: page.citations,
    outgoingLinks: page.outgoingLinks,
    frontmatter: page.frontmatter,
    warnings: page.warnings,
    freshness: page.freshness,
    updatedAt: pageTimestamp(page.frontmatter),
    // Literal, NOT `pageTimestamp`: this field means "when was the page first
    // written", so it must never inherit an `updatedAt`.
    createdAt:
      typeof page.frontmatter.createdAt === "string" ? (page.frontmatter.createdAt as string) : "",
    generatedAt: snapshot.generatedAt,
    ...(page.entityType !== undefined && page.entityContext ? { entityContext: page.entityContext } : {}),
    ...entityTypeField(page),
  };
}
