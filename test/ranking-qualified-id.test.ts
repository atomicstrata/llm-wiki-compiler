/**
 * @file test/ranking-qualified-id.test.ts
 * @description Task D3 — `findPageByQualifiedId` resolves a page by its
 * qualified id (`<namespace>/<pagePart>`) uniformly across namespaces, so
 * `concepts/foo` and a typed `papers/foo` resolve to DISTINCT pages (no
 * concepts-over-queries bare-slug guessing).
 */

import { describe, it, expect } from "vitest";
import { findPageByQualifiedId } from "../src/context/ranking.js";
import type { ViewerPage, ViewerSnapshot } from "../src/viewer/types.js";

/** Build a minimal ViewerPage carrying only the fields the resolver reads. */
function page(id: string, dir: string, slug: string, title: string): ViewerPage {
  return { id, pageDirectory: dir, slug, title } as unknown as ViewerPage;
}

/** A snapshot with a concept `foo`, a query `foo`, and a typed `papers/foo`. */
function snapshot(): ViewerSnapshot {
  return {
    pages: [
      page("concepts/foo", "concepts", "foo", "Concept Foo"),
      page("queries/foo", "queries", "foo", "Query Foo"),
      page("papers/foo", "papers", "foo", "Paper Foo"),
    ],
  } as unknown as ViewerSnapshot;
}

describe("findPageByQualifiedId", () => {
  it("resolves concepts/foo and papers/foo to DISTINCT pages", () => {
    const snap = snapshot();
    expect(findPageByQualifiedId(snap, "concepts/foo")?.title).toBe("Concept Foo");
    expect(findPageByQualifiedId(snap, "papers/foo")?.title).toBe("Paper Foo");
    expect(findPageByQualifiedId(snap, "queries/foo")?.title).toBe("Query Foo");
  });

  it("returns null for an absent qualified id", () => {
    expect(findPageByQualifiedId(snapshot(), "concepts/missing")).toBeNull();
  });

  it("returns null for a malformed (no-slash) id", () => {
    expect(findPageByQualifiedId(snapshot(), "foo")).toBeNull();
  });
});
