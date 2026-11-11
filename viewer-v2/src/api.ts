/**
 * Typed client for the viewer's read-only JSON API.
 *
 * Every function maps to one route of the local viewer server. The shapes
 * list the fields this client reads; the server may send more. Fields that
 * exist only on profile projects are optional and absent, never null, on a
 * default project.
 */

/** Whether `.llmwiki/state.json` could be read. */
export type StateStatus = "ok" | "missing" | "corrupt" | "too-new";

export type FreshnessStatus = "fresh" | "stale" | "orphaned" | "unverified";

/** A page's freshness relative to its sources. */
export interface PageFreshness {
  freshnessStatus: FreshnessStatus;
  contradicted: boolean;
  archived: boolean;
}

/** A per-page problem the server noticed while reading it. */
export interface PageWarning {
  code: string;
  message: string;
}

/** One row of the page list. */
export interface PageRow {
  id: string;
  pageDirectory: string;
  slug: string;
  title: string;
  kind: string;
  summary: string;
  updatedAt: string;
  createdAt: string;
  warnings: PageWarning[];
  freshness: PageFreshness;
  citationCount: number;
  unresolvedCitationCount: number;
  entityType?: string;
}

/** One of the eight most recently updated pages. */
export interface RecentPage {
  id: string;
  pageDirectory: string;
  slug: string;
  title: string;
  updatedAt: string;
  entityType?: string;
}

/** One entity type a profile declares, with its page count. */
export interface EntityTypeRow {
  type: string;
  directory: string;
  pageCount: number;
}

/** A problem with a profile project's records. */
export interface ProfileProblem {
  kind: string;
  entityType?: string;
  path?: string;
  message: string;
}

/** The bootstrap envelope: project identity, counts, and every page. */
export interface PagesEnvelope {
  project: { title: string; rootName: string };
  stateStatus: StateStatus;
  profileId: string;
  counts: {
    concepts: number;
    queries: number;
    sourceFiles: number;
    pendingReviews: number;
    compiledSources: number;
    stale: number;
    orphaned: number;
  };
  graph: { nodeCount: number; edgeCount: number; danglingCount: number };
  sourceFilenames: string[];
  index: { available: boolean };
  recentPages: RecentPage[];
  pages: PageRow[];
  updatedAt: string;
  profileProblems?: ProfileProblem[];
  profileProblemTotal?: number;
  profilePipeline?: { entityTypes: EntityTypeRow[] };
}

/** The last lint run, from `.llmwiki/last-lint.json`. */
export interface LintSummary {
  warnings: number;
  errors: number;
  at: string;
  rules?: { rule: string; severity: "error" | "warning"; count: number; fileCount: number; topFile: string }[];
}

/** Wiki health counts and the last lint run; `lint` is null when lint has never run. */
export interface HealthPayload {
  pendingReviews: number;
  sources: number;
  sourceFiles: number;
  concepts: number;
  queries: number;
  stale: number;
  orphaned: number;
  stateStatus: StateStatus;
  lint: LintSummary | null;
}

/** A cited span of a source file; `file` is relative to `sources/`. */
export interface SourceSpan {
  file: string;
  lines?: { start: number; end: number };
}

/** One structured citation of a page, as written in its record. */
export interface ClaimCitation {
  raw: string;
  spans: SourceSpan[];
}

/** One relation of a typed page, relative to that page. */
export interface EntityRelation {
  type: string;
  direction: "incoming" | "outgoing" | "symmetric";
  target: { id: string; resolved: boolean; title?: string };
}

/** The import a typed page's details came from. */
export interface ConnectorProvenance {
  connectorId: string;
  connectorVersion: string;
  fetchedAt: string;
  contentHash: string;
  sourceUrl?: string;
}

/** Relations and evidence of a typed page; the server caps both lists at 100. */
export interface EntityContext {
  relations: EntityRelation[];
  relationTotal: number;
  sources: (SourceSpan & { resolved: boolean })[];
  sourceTotal: number;
  connector?: ConnectorProvenance;
}

/** One rendered page. `html` is sanitized by the server. */
export interface PagePayload {
  id: string;
  title: string;
  pageDirectory: string;
  slug: string;
  html: string;
  citations: ClaimCitation[];
  updatedAt: string;
  createdAt: string;
  warnings: PageWarning[];
  freshness: PageFreshness;
  outgoingLinks: string[];
  frontmatter: { tags?: unknown; sources?: unknown; kind?: unknown; type?: unknown };
  entityType?: string;
  entityContext?: EntityContext;
}

/** One node of the wiki graph: a page, a typed record, or a dangling link target. */
export interface GraphNode {
  id: string;
  title: string;
  slug: string;
  directory: string;
  kind: string;
  degree: number;
  isDangling?: true;
  entityType?: string;
}

/** One edge of the wiki graph; a wikilink unless `edgeKind` says relation. */
export interface GraphEdge {
  source: string;
  target: string;
  edgeKind?: "relation";
  relationType?: string;
  direction?: "directed" | "symmetric";
}

/** The whole wiki graph the snapshot holds. */
export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/** One search hit. */
export interface SearchResult {
  id: string;
  pageDirectory: string;
  title: string;
  snippet: string;
  matchedIn: "title" | "body";
  entityType?: string;
}

/** Metadata of an ingested source. */
export interface SourceMeta {
  id: string;
  title?: string;
  health: string;
  locator?: string;
  /** Files in `sources/images/` this source declares; absent when it declares none. */
  images?: string[];
}

/** Read a JSON route, failing on any non-2xx status. */
async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`Request failed (${response.status}): ${path}`);
  return (await response.json()) as T;
}

/** The page list and project summary. */
export function fetchPages(): Promise<PagesEnvelope> {
  return getJson("/api/pages");
}

/** Health counts and the last lint run. */
export function fetchHealth(): Promise<HealthPayload> {
  return getJson("/api/health");
}

/** One page by directory and slug. */
export function fetchPage(directory: string, slug: string): Promise<PagePayload> {
  return getJson(`/api/page/${encodeURIComponent(directory)}/${encodeURIComponent(slug)}`);
}

/** The wiki graph: every page and every link between pages. */
export function fetchGraph(): Promise<GraphData> {
  return getJson("/api/graph");
}

/** The rendered `wiki/index.md`. */
export function fetchIndex(): Promise<{ html: string }> {
  return getJson("/api/index");
}

/** Pages matching a query. */
export function fetchSearch(query: string): Promise<{ results: SearchResult[] }> {
  return getJson(`/api/search?q=${encodeURIComponent(query)}`);
}

/** Metadata of one source. */
export function fetchSourceMeta(id: string): Promise<SourceMeta> {
  return getJson(`/api/source/${encodeURIComponent(id)}`);
}

/** Full text of one source, with its physical line numbers intact. */
export async function fetchSourceText(id: string): Promise<string> {
  const path = `/api/source/${encodeURIComponent(id)}/content`;
  const response = await fetch(path);
  if (!response.ok) throw new Error(`Request failed (${response.status}): ${path}`);
  return response.text();
}

/** URL of an image a source declares; the server serves it only through that source. */
export function sourceImageUrl(sourceId: string, file: string): string {
  return `/api/source-image/${encodeURIComponent(sourceId)}/${encodeURIComponent(file)}`;
}
