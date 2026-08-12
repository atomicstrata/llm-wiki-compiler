/**
 * Subprocess integration tests for the read-only `/api/reviews` viewer route.
 *
 * These spin up the compiled `llmwiki view` binary against a temp project whose
 * candidates were seeded through the project's own `writeCandidate`, then GET
 * `/api/reviews` and assert the projection contract.
 *
 * Two of the four tests exist because of real defects on this branch rather
 * than for coverage:
 *  - `body` (the ENTIRE generated page, frontmatter included) must never reach
 *    the client: a list view does not need it, and shipping it would push
 *    unbounded unreviewed LLM text over the wire.
 *  - No response field may carry an absolute path. `/api/reviews` — like
 *    `/api/health` and unlike `/api/page` — does not participate in the
 *    non-loopback `isLoopback` suppression, so a leaked machine-local path
 *    would be readable by every LAN client. Commit c5c9e5e fixed exactly this
 *    class of leak once already.
 */

import { describe, it, expect } from "vitest";
import path from "path";
import { makeTempRoot } from "./fixtures/temp-root.js";
import { writeCandidate, writeFreshCandidate } from "../src/compiler/candidates.js";
import type { CandidateDraft } from "../src/compiler/candidates.js";
import { REVIEW_LIST_LIMIT } from "../src/viewer/reviews.js";
import { useViewerProcessLifecycle } from "./fixtures/run-cli-server.js";
import { fetchJson } from "./fixtures/viewer-fetch.js";

const { start: startViewer } = useViewerProcessLifecycle();

/** A single `/api/reviews` row shape. */
interface ReviewRow {
  id: string;
  title: string;
  slug: string;
  summary: string;
  sources: string[];
  generatedAt: string;
  reviewMode: string;
  heldReasons: { code: string; detail?: string }[];
  targetDirectory?: string;
  targetEntityType?: string;
  body?: string;
}

/** Read the `reviews` array out of the `/api/reviews` envelope. */
function rowsOf(body: unknown): ReviewRow[] {
  return (body as { reviews: ReviewRow[] }).reviews;
}

/** Read the true pending-candidate total out of the `/api/reviews` envelope. */
function totalOf(body: unknown): number {
  return (body as { total: number }).total;
}

/**
 * Seed `count` distinct pending candidates. `writeFreshCandidate` rather than
 * `writeCandidate`: the latter re-lists the whole queue on every write to
 * canonicalize duplicates, which is O(n²) at the sizes this cap is about.
 * Every slug here is distinct, so there is nothing to canonicalize.
 */
async function seedQueue(root: string, count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    await writeFreshCandidate(root, {
      title: `Candidate ${i}`,
      slug: `candidate-${String(i).padStart(4, "0")}`,
      summary: `Summary ${i}`,
      sources: ["karpathy.md"],
      body: `---\ntitle: Candidate ${i}\n---\n\nBody ${i}.`,
    });
  }
}

/** Seed one pending candidate through the project's own writer, so the on-disk
 *  format cannot drift from what the compile pipeline actually produces. */
function seedCandidate(root: string, overrides: Partial<CandidateDraft> = {}) {
  return writeCandidate(root, {
    title: "Transformer attention",
    slug: "transformer-attention",
    summary: "Every token is weighted against every other token.",
    sources: ["karpathy.md"],
    body: "---\ntitle: Transformer attention\nconfidence: 0.4\n---\n\nFull page body.",
    reviewMode: "policy",
    heldReasons: [{ code: "low-confidence", detail: "confidence 0.4 < 0.6" }],
    ...overrides,
  });
}

/** Every string anywhere in `value` that reads as an absolute filesystem path. */
function absolutePathsIn(value: unknown): string[] {
  if (typeof value === "string") return /^(?:\/|[A-Za-z]:[\\/])/.test(value) ? [value] : [];
  if (Array.isArray(value)) return value.flatMap(absolutePathsIn);
  if (value && typeof value === "object") return Object.values(value).flatMap(absolutePathsIn);
  return [];
}

describe("llmwiki view — /api/reviews", () => {
  it("lists every pending candidate with the fields the list route renders", async () => {
    const root = await makeTempRoot("viewer-reviews-list");
    await seedCandidate(root);
    await seedCandidate(root, { title: "Backprop", slug: "backprop", sources: ["lecun.md"] });
    const handle = await startViewer(root);
    const { status, body } = await fetchJson(handle, "/api/reviews");
    expect(status).toBe(200);
    const rows = rowsOf(body);
    expect(rows).toHaveLength(2);
    const row = rows.find((r) => r.slug === "transformer-attention");
    expect(row?.title).toBe("Transformer attention");
    expect(row?.summary).toBe("Every token is weighted against every other token.");
    expect(row?.sources).toEqual(["karpathy.md"]);
    expect(row?.reviewMode).toBe("policy");
    expect(row?.heldReasons).toEqual([{ code: "low-confidence", detail: "confidence 0.4 < 0.6" }]);
    expect(typeof row?.generatedAt).toBe("string");
    expect(typeof row?.id).toBe("string");
  });

  // `routeApprovedPageWrite` branches on `targetEntityType`, not on
  // `targetDirectory`: a typed candidate lands in `wiki/<entityType>/`. Dropping
  // the field left the list route stating a destination approval never uses.
  it("carries a typed candidate's target entity type, which is where approval writes", async () => {
    const root = await makeTempRoot("viewer-reviews-typed");
    await seedCandidate(root, { slug: "attention", targetEntityType: "papers" });
    const handle = await startViewer(root);
    const { body } = await fetchJson(handle, "/api/reviews");
    expect(rowsOf(body)[0].targetEntityType).toBe("papers");
  });

  it("omits the typed target on a default candidate", async () => {
    const root = await makeTempRoot("viewer-reviews-untyped");
    await seedCandidate(root);
    const handle = await startViewer(root);
    const { body } = await fetchJson(handle, "/api/reviews");
    expect("targetEntityType" in rowsOf(body)[0]).toBe(false);
  });

  it("omits `body` — the whole generated page — from every row", async () => {
    const root = await makeTempRoot("viewer-reviews-nobody");
    await seedCandidate(root);
    const handle = await startViewer(root);
    const { body } = await fetchJson(handle, "/api/reviews");
    const row = rowsOf(body)[0];
    expect(row.body).toBeUndefined();
    expect("body" in row).toBe(false);
    expect(JSON.stringify(body)).not.toContain("Full page body.");
  });

  it("emits no absolute path, even when a candidate records one as a source", async () => {
    const root = await makeTempRoot("viewer-reviews-paths");
    await seedCandidate(root, { sources: [path.join(root, "sources", "karpathy.md")] });
    const handle = await startViewer(root);
    const { body } = await fetchJson(handle, "/api/reviews");
    expect(absolutePathsIn(body)).toEqual([]);
    expect(JSON.stringify(body)).not.toContain(root);
    expect(rowsOf(body)[0].sources).toEqual(["karpathy.md"]);
  });

  it("returns an empty list with no candidates, and existing routes still work", async () => {
    const root = await makeTempRoot("viewer-reviews-empty");
    const handle = await startViewer(root);
    const reviews = await fetchJson(handle, "/api/reviews");
    expect(reviews.status).toBe(200);
    expect(rowsOf(reviews.body)).toEqual([]);
    expect(totalOf(reviews.body)).toBe(0);
    // The sidebar's pending-review count and this list read the same store,
    // so the bootstrap envelope must agree with the empty queue.
    const pages = await fetchJson(handle, "/api/pages");
    expect(pages.status).toBe(200);
    expect((pages.body as { counts: { pendingReviews: number } }).counts.pendingReviews).toBe(0);
  });
});

describe("llmwiki view — /api/reviews is bounded", () => {
  // `heldReasons: "all"` holds every page, so a large corpus compiled under it
  // puts one candidate file per page behind this route — and the route re-reads
  // disk on every visit. The response is capped; `total` still tells the truth.
  it("caps the rows at the limit while reporting the true total", async () => {
    const root = await makeTempRoot("viewer-reviews-cap");
    await seedQueue(root, REVIEW_LIST_LIMIT + 3);
    const handle = await startViewer(root);
    const { status, body } = await fetchJson(handle, "/api/reviews");
    expect(status).toBe(200);
    expect(rowsOf(body)).toHaveLength(REVIEW_LIST_LIMIT);
    expect(totalOf(body)).toBe(REVIEW_LIST_LIMIT + 3);
  });

  it("reports a total equal to the row count when the queue fits under the cap", async () => {
    const root = await makeTempRoot("viewer-reviews-undercap");
    await seedQueue(root, 3);
    const handle = await startViewer(root);
    const { body } = await fetchJson(handle, "/api/reviews");
    expect(rowsOf(body)).toHaveLength(3);
    expect(totalOf(body)).toBe(3);
  });
});
