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
  tags: string[];
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

/** One field a profile declares on an entity or artifact type. */
export interface PipelineFieldDef {
  name: string;
  type: string;
  required?: boolean;
  enum?: string[];
  artifactTypes?: string[];
  format?: string;
}

/** The lifecycle a profile declares for an entity type. */
export interface PipelineLifecycle {
  field: string;
  initial: string;
  terminal: string[];
  transitions: Record<string, string[]>;
  /** The lifecycle field's enum, when the profile declares one. */
  declaredStates?: string[];
}

/** One entity type a profile declares, with its page count and per-state tally. */
export interface EntityTypeRow {
  type: string;
  /** The declared project-relative directory, printed verbatim. */
  directory: string;
  titleField?: string;
  fields?: PipelineFieldDef[];
  lifecycle?: PipelineLifecycle;
  /** Pages of this type that pass validation. */
  pageCount: number;
  /** Unfiltered tally of lifecycle states; absent when no page records one. */
  stateCounts?: Record<string, number>;
}

/** One relation type a profile declares, with its live count. */
export interface RelationTypeRow {
  type: string;
  from: string[];
  to: string[];
  direction: "directed" | "symmetric";
  count: number;
}

/** One artifact type a profile declares. */
export interface ArtifactTypeDef {
  type: string;
  fileName: string;
  contentKind: "json" | "text";
  metadata?: PipelineFieldDef[];
}

/** The profile's vocabulary: its entity, relation and artifact types, and the workflows it declares. */
export interface PipelineEnvelope {
  entityTypes: EntityTypeRow[];
  relationTypes?: RelationTypeRow[];
  artifactTypes?: ArtifactTypeDef[];
  /** Declared workflow ids; absent when the profile declares none. */
  workflows?: string[];
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
  profilePipeline?: PipelineEnvelope;
}

/** One rule's findings in the last lint run; `topFile` is root-relative. */
export interface LintRule {
  rule: string;
  severity: "error" | "warning";
  count: number;
  fileCount: number;
  topFile: string;
  topFileCount: number;
}

/** The last lint run, from `.llmwiki/last-lint.json`; `rules` is absent on a clean run or an old cache. */
export interface LintSummary {
  warnings: number;
  errors: number;
  at: string;
  rules?: LintRule[];
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
  /** Every other page whose wikilinks name this one: concepts, queries, timeline days and typed pages. */
  backlinks: string[];
  /** The page's raw frontmatter; a typed page's declared fields are read from it. */
  frontmatter: Record<string, unknown>;
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
  nodeKind?: "entity";
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

/** Why a review candidate was held back instead of written live. */
export interface HeldReason {
  code: string;
  detail?: string;
}

/** One candidate in the review queue; no body is served. */
export interface ReviewCandidate {
  id: string;
  title: string;
  slug: string;
  summary: string;
  sources: string[];
  generatedAt: string;
  reviewMode: string;
  heldReasons: HeldReason[];
  targetDirectory?: string;
  targetEntityType?: string;
}

/** The review queue: at most 200 rows with the true depth; `sourceChanges` only when that screen is enabled. */
export interface ReviewsEnvelope {
  reviews: ReviewCandidate[];
  total: number;
  sourceChanges?: true;
}

/** A source that state.json records as owning a page, and whether it still matches. */
export interface SourceChangeOwner {
  file: string;
  status: "unavailable" | "unchanged" | "changed";
}

/** A pending proposal for a page, with the checks the server ran against its recorded expectations. */
export interface SourceChangeCandidate {
  id: string;
  generatedAt: string;
  body: string;
  truncated: boolean;
  checks: { target: string; sources: string };
  reasons: HeldReason[];
}

/** A numbered excerpt of one owning source; `text` is absent when the source could not be read. */
export interface SourceExcerpt {
  file: string;
  status: string;
  text?: string;
  truncated?: boolean;
}

/** One page the source comparison reports on. */
export interface SourceChangePage {
  slug: string;
  title: string;
  owners: SourceChangeOwner[];
  candidates: SourceChangeCandidate[];
  excerpts: SourceExcerpt[];
  current: string | null;
  truncated: boolean;
  readStatus: string;
  reconciliationPending: boolean;
  impact: string;
}

/** One bounded comparison of changed sources with their pages and proposals. */
export interface SourceChangesReport {
  projectRoot: string;
  stateStatus: StateStatus;
  pages: SourceChangePage[];
  totalPages: number;
  candidateTotal: number;
  candidateShown: number;
  observedAt: string;
}

/** Read a JSON route, failing on any non-2xx status. */
export async function getJson<T>(path: string): Promise<T> {
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

/** The review queue, read from disk on every request. */
export function fetchReviews(): Promise<ReviewsEnvelope> {
  return getJson("/api/reviews");
}

const NOT_FOUND = 404;
const SOURCE_CHANGES_TIMEOUT_MS = 10_000;

/**
 * The source comparison, or null when the server has it switched off. It
 * reads every owning source on request, so the call is bounded and never cached.
 */
export async function fetchSourceChanges(): Promise<SourceChangesReport | null> {
  const path = "/api/source-changes";
  const response = await fetch(path, { cache: "no-store", signal: AbortSignal.timeout(SOURCE_CHANGES_TIMEOUT_MS) });
  if (response.status === NOT_FOUND) return null;
  if (!response.ok) throw new Error(`Request failed (${response.status}): ${path}`);
  return (await response.json()) as SourceChangesReport;
}

/** URL of an image a source declares; the server serves it only through that source. */
export function sourceImageUrl(sourceId: string, file: string): string {
  return `/api/source-image/${encodeURIComponent(sourceId)}/${encodeURIComponent(file)}`;
}
