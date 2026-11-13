/**
 * Regression guard for the saved-query writer/reader field mismatch.
 *
 * `llmwiki query --save` (src/commands/query-save.ts) writes EXACTLY
 * `title`/`summary`/`type: "query"`/`createdAt` — no `kind`, no `updatedAt`.
 * The viewer used to read only `frontmatter.kind` and `frontmatter.updatedAt`,
 * so every genuinely-saved query rendered with a blank age, a "concept" kind,
 * and a permanent last place in the dashboard's recent list.
 *
 * These tests are written against the writer's REAL field set. If
 * `query-save.ts` ever changes what it emits, this file is the thing that
 * should notice.
 */

import { describe, it, expect } from "bun:test";
import path from "path";
import { makeTempRoot } from "./fixtures/temp-root.js";
import { writePage } from "./fixtures/write-page.js";
import { buildViewerSnapshot } from "../src/viewer/snapshot.js";
import { pageTimestamp, resolvePageKind } from "../src/viewer/page-fields.js";
import { useViewerProcessLifecycle } from "./fixtures/run-cli-server.js";
import { fetchJson } from "./fixtures/viewer-fetch.js";

const SAVED_AT = "2026-08-01T07:30:12.889Z";

/** Frontmatter byte-for-byte matching what `query-save.ts` emits today. */
function realWriterFrontmatter(title: string, createdAt = SAVED_AT): Record<string, unknown> {
  return { title, summary: `${title} — one-line summary.`, type: "query", createdAt };
}

/** Snapshot a root holding one real-writer-shaped query page. */
async function snapshotWithSavedQuery(prefix: string) {
  const root = await makeTempRoot(prefix);
  await writePage(
    path.join(root, "wiki/queries"),
    "what-is-vibe-coding",
    realWriterFrontmatter("What is vibe coding?"),
    "An answer body.",
  );
  return buildViewerSnapshot(root);
}

describe("page-fields helpers", () => {
  it("prefers updatedAt over createdAt when both are present", () => {
    const fm = { updatedAt: "2026-08-02T00:00:00.000Z", createdAt: "2026-07-01T00:00:00.000Z" };
    expect(pageTimestamp(fm)).toBe("2026-08-02T00:00:00.000Z");
  });

  it("falls back to createdAt when updatedAt is absent", () => {
    expect(pageTimestamp({ createdAt: SAVED_AT })).toBe(SAVED_AT);
  });

  it("degrades to the empty string when neither timestamp is present", () => {
    expect(pageTimestamp({ title: "No timestamps" })).toBe("");
    expect(pageTimestamp({ updatedAt: 42, createdAt: null })).toBe("");
  });

  it("prefers kind over type, and falls back to type when kind is absent", () => {
    expect(resolvePageKind({ kind: "comparison", type: "query" })).toBe("comparison");
    expect(resolvePageKind({ type: "query" })).toBe("query");
  });

  it("still defaults to concept when neither kind nor type is a non-empty string", () => {
    expect(resolvePageKind({})).toBe("concept");
    expect(resolvePageKind({ kind: "", type: "" })).toBe("concept");
  });
});

describe("saved query carrying only the real writer's fields", () => {
  it("gets a non-empty timestamp from createdAt", async () => {
    const snapshot = await snapshotWithSavedQuery("query-fm-age");
    expect(pageTimestamp(snapshot.pages[0].frontmatter)).toBe(SAVED_AT);
  });

  it("is not mislabelled as a concept in the graph", async () => {
    const snapshot = await snapshotWithSavedQuery("query-fm-kind");
    const node = snapshot.graph.nodes.find((n) => n.slug === "what-is-vibe-coding");
    expect(node?.kind).toBe("query");
  });

  it("carries its createdAt into the recent-pages row", async () => {
    const snapshot = await snapshotWithSavedQuery("query-fm-recent");
    expect(snapshot.recentPages[0].updatedAt).toBe(SAVED_AT);
  });
});

describe("recent-pages ordering with mixed frontmatter shapes", () => {
  /** Concepts (kind/updatedAt) plus one newer real-writer-shaped query. */
  async function mixedRoot(): Promise<string> {
    const root = await makeTempRoot("query-fm-order");
    for (const [slug, day] of [["older", "10"], ["oldest", "01"]] as const) {
      await writePage(
        path.join(root, "wiki/concepts"),
        slug,
        { title: slug, kind: "concept", createdAt: `2026-07-${day}T00:00:00.000Z`,
          updatedAt: `2026-07-${day}T00:00:00.000Z` },
        "Body.",
      );
    }
    await writePage(
      path.join(root, "wiki/queries"),
      "fresh-answer",
      realWriterFrontmatter("Fresh answer"),
      "Body.",
    );
    return root;
  }

  it("ranks a freshly saved query above concepts compiled weeks earlier", async () => {
    const snapshot = await buildViewerSnapshot(await mixedRoot());
    expect(snapshot.recentPages.map((p) => p.slug)).toEqual(["fresh-answer", "older", "oldest"]);
  });

  it("still sorts a page with no timestamp at all to the end", async () => {
    const root = await mixedRoot();
    await writePage(path.join(root, "wiki/concepts"), "undated", { title: "Undated" }, "Body.");
    const snapshot = await buildViewerSnapshot(root);
    expect(snapshot.recentPages.at(-1)?.slug).toBe("undated");
  });
});

describe("/api/pages for a real-writer-shaped saved query", () => {
  const { start: startViewer } = useViewerProcessLifecycle();

  /** Serve a root holding one dated concept plus one newer saved query. */
  async function envelopeForMixedRoot(): Promise<Record<string, unknown>> {
    const root = await makeTempRoot("query-fm-api");
    await writePage(
      path.join(root, "wiki/concepts"),
      "older-concept",
      { title: "Older concept", kind: "concept", updatedAt: "2026-07-01T00:00:00.000Z" },
      "Body.",
    );
    await writePage(
      path.join(root, "wiki/queries"),
      "what-is-vibe-coding",
      realWriterFrontmatter("What is vibe coding?"),
      "An answer body.",
    );
    const { body } = await fetchJson(await startViewer(root), "/api/pages");
    return body as Record<string, unknown>;
  }

  it("reports a non-empty age and a non-concept kind for the saved query", async () => {
    const rows = (await envelopeForMixedRoot()).pages as Array<Record<string, unknown>>;
    const query = rows.find((row) => row.slug === "what-is-vibe-coding");
    expect(query?.updatedAt).toBe(SAVED_AT);
    expect(query?.kind).toBe("query");
  });

  it("does not pin the saved query to the bottom of the recent list", async () => {
    const recent = (await envelopeForMixedRoot()).recentPages as Array<Record<string, unknown>>;
    expect(recent[0].slug).toBe("what-is-vibe-coding");
  });
});
