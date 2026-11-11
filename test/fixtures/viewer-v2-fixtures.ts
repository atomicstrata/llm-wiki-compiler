/** Builders for the v2 viewer's API payloads, with calm defaults every test can override. */
import type { HealthPayload, LintSummary, PageRow, PagesEnvelope } from "../../viewer-v2/src/api.js";

/** One concept page row; override any field. */
export function page(overrides: Partial<PageRow> = {}): PageRow {
  const id = overrides.id ?? "concepts/alpha";
  const [pageDirectory, slug = ""] = id.split("/");
  return {
    id,
    pageDirectory,
    slug,
    title: slug.charAt(0).toUpperCase() + slug.slice(1),
    kind: "concept",
    summary: "",
    updatedAt: "2026-11-10T12:00:00.000Z",
    createdAt: "2026-11-10T12:00:00.000Z",
    warnings: [],
    freshness: { freshnessStatus: "fresh", contradicted: false, archived: false },
    citationCount: 0,
    unresolvedCitationCount: 0,
    ...overrides,
  };
}

/** A default-project envelope; override any top-level field. */
export function envelope(overrides: Partial<PagesEnvelope> = {}): PagesEnvelope {
  return {
    project: { title: "my-wiki", rootName: "my-wiki" },
    stateStatus: "ok",
    profileId: "default",
    counts: { concepts: 0, queries: 0, sourceFiles: 0, pendingReviews: 0, compiledSources: 0, stale: 0, orphaned: 0 },
    graph: { nodeCount: 0, edgeCount: 0, danglingCount: 0 },
    sourceFilenames: [],
    index: { available: false },
    recentPages: [],
    pages: [],
    updatedAt: "2026-11-11T00:00:00.000Z",
    ...overrides,
  };
}

/** A health payload whose lint summary is `lint`. */
export function healthWith(lint: LintSummary | null): HealthPayload {
  return {
    pendingReviews: 0, sources: 0, sourceFiles: 0, concepts: 0, queries: 0, stale: 0, orphaned: 0,
    stateStatus: "ok", lint,
  };
}
