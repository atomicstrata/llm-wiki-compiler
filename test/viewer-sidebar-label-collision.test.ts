/**
 * A profile type may take a name the sidebar's fixed rows already use.
 *
 * The shipped `autosci` template declares entity types called `sources` and
 * `reviews`, so its sidebar rendered two rows reading "Sources" and two reading
 * "Reviews" — identical accessible names, different destinations. Namespacing
 * the typed routes (`#/_type/<id>`) fixed where those rows GO; these tests pin
 * what they SAY.
 *
 * The fixed row yields, never the type row: an entity type's name is the
 * reader's own data, and renaming it would misreport their profile.
 */

import { describe, expect, it } from "vitest";
import { flushMicrotasks, jsonResponse, mountViewerDom, type FetchResponder } from "./fixtures/viewer-jsdom.js";

/** Entity types that collide with the viewer's own fixed rows, as autosci's do. */
const COLLIDING = [
  { type: "papers", pageCount: 4 },
  { type: "sources", pageCount: 2 },
  { type: "reviews", pageCount: 1 },
];

/** Entity types that collide with nothing, as newsroom's do. */
const CLEAR = [
  { type: "articles", pageCount: 6 },
  { type: "desks", pageCount: 3 },
];

function responderFor(entityTypes: { type: string; pageCount: number }[] | null): FetchResponder {
  const envelope: Record<string, unknown> = {
    project: { title: "demo", rootName: "demo" },
    profileId: entityTypes ? "autosci" : "default",
    counts: { concepts: 7, queries: 0, sourceFiles: 1, pendingReviews: 0 },
    pages: [],
    recentPages: [],
    index: { available: false },
    ...(entityTypes ? { profilePipeline: { entityTypes } } : {}),
  };
  return (url) => {
    if (url.endsWith("/api/pages")) return jsonResponse(envelope);
    if (url.endsWith("/api/health")) return jsonResponse({ lint: null });
    return null;
  };
}

/** Every nav label the sidebar renders, in order. */
async function navLabels(entityTypes: { type: string; pageCount: number }[] | null): Promise<string[]> {
  const { dom } = await mountViewerDom(responderFor(entityTypes));
  await flushMicrotasks();
  return [...dom.window.document.querySelectorAll("[data-sidebar] .nav-link .nav-label")].map(
    (el) => el.textContent ?? "",
  );
}

describe("a profile type taking a fixed row's name", () => {
  it("leaves no duplicate label anywhere in the sidebar", async () => {
    const labels = await navLabels(COLLIDING);
    expect(labels.length).toBe(new Set(labels).size);
  });

  it("keeps the profile's own type names untouched", async () => {
    const labels = await navLabels(COLLIDING);
    expect(labels).toContain("Sources");
    expect(labels).toContain("Reviews");
  });

  it("relabels the fixed rows instead, to what they actually list", async () => {
    const labels = await navLabels(COLLIDING);
    expect(labels).toContain("Source files");
    expect(labels).toContain("Review queue");
  });
});

describe("a profile that collides with nothing", () => {
  it("leaves the fixed labels alone", async () => {
    const labels = await navLabels(CLEAR);
    expect(labels).toContain("Sources");
    expect(labels).toContain("Reviews");
    expect(labels).not.toContain("Source files");
    expect(labels).not.toContain("Review queue");
  });
});

describe("a default project", () => {
  it("is untouched — no profile means no collision", async () => {
    const labels = await navLabels(null);
    expect(labels).toEqual([
      "Overview",
      "Concepts",
      "Sources",
      "Queries",
      "Graph explorer",
      "Health & lint",
      "Reviews",
    ]);
  });
});
