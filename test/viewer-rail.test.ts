/**
 * Support-rail + sidebar-grouping + stale-rail-clearing tests.
 *
 * Mounts the real viewer assets through `mountViewerDom` and drives
 * hash-route navigation to assert the right metadata renders on the
 * right route. Covers every Slice-5 review finding that touches the
 * client's right-hand rail or the sidebar group structure.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  flushMicrotasks,
  jsonResponse,
  mountViewerDom,
  type EmbeddedPage,
  type FetchResponder,
} from "./fixtures/viewer-jsdom.js";

const PAGES_BASE = {
  project: { title: "demo", rootName: "demo" },
  counts: { concepts: 1, queries: 0, sourceFiles: 0, pendingReviews: 0 },
  index: { available: false, href: "/#/index" },
  recentPages: [],
  updatedAt: "2026-05-14T00:00:00.000Z",
};

function pagesResponse(pages: EmbeddedPage[]): Response {
  return jsonResponse({ ...PAGES_BASE, pages });
}

interface PageFixture {
  id: string;
  slug: string;
  pageDirectory: "concepts" | "queries";
  title: string;
  html?: string;
  frontmatter?: Record<string, unknown>;
  warnings?: Array<{ code: string; message: string }>;
}

function pagePayload(fixture: PageFixture): Record<string, unknown> {
  return {
    id: fixture.id,
    pageDirectory: fixture.pageDirectory,
    slug: fixture.slug,
    title: fixture.title,
    html: fixture.html ?? "<p>Body</p>",
    citations: [],
    outgoingLinks: [],
    frontmatter: fixture.frontmatter ?? {},
    warnings: fixture.warnings ?? [],
    updatedAt: "",
    createdAt: "",
    generatedAt: "2026-05-14T00:00:00.000Z",
  };
}

function responderFor(
  embeddedPages: EmbeddedPage[],
  pageFixtures: PageFixture[],
  extras: { health?: Record<string, unknown>; index?: Record<string, unknown> } = {},
): FetchResponder {
  return (url) => {
    if (url.endsWith("/api/pages")) return pagesResponse(embeddedPages);
    const pageMatch = url.match(/\/api\/page\/([^/]+)\/([^/?]+)/);
    if (pageMatch) {
      const slug = decodeURIComponent(pageMatch[2]);
      const fixture = pageFixtures.find(
        (p) => p.pageDirectory === pageMatch[1] && p.slug === slug,
      );
      if (!fixture) return new Response(null, { status: 404 });
      return jsonResponse(pagePayload(fixture));
    }
    if (url.endsWith("/api/index")) {
      if (extras.index) return jsonResponse(extras.index);
      return new Response(null, { status: 404 });
    }
    if (url.endsWith("/api/health")) return jsonResponse(extras.health ?? {});
    return null;
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("support rail — every spec field renders", () => {
  it("renders kind, sources, confidence, provenanceState, contradictedBy, tags, aliases, timestamps, warnings", async () => {
    const embedded: EmbeddedPage[] = [
      { id: "concepts/alpha", pageDirectory: "concepts", slug: "alpha", title: "Alpha", kind: "concept" },
    ];
    const fixture: PageFixture = {
      id: "concepts/alpha",
      pageDirectory: "concepts",
      slug: "alpha",
      title: "Alpha",
      frontmatter: {
        kind: "concept",
        sources: ["paper.md", "talk.md"],
        confidence: 0.8,
        provenanceState: "merged",
        contradictedBy: [
          { slug: "beta", reason: "newer evidence" },
          { slug: "gamma" },
        ],
        tags: ["machine-learning", "attention"],
        aliases: ["attn", "self-attention"],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-05-14T00:00:00.000Z",
      },
      warnings: [
        { code: "unresolved_citation", message: "Source not found: ghost.md" },
        { code: "malformed_citation", message: "Malformed citation entry: x.md:0-5" },
      ],
    };
    const { dom } = await mountViewerDom(embedded, responderFor(embedded, [fixture]));
    dom.window.location.hash = "#/concepts/alpha";
    await flushMicrotasks();

    const rail = dom.window.document.querySelector("[data-support-rail]") as HTMLElement;
    const text = rail.textContent ?? "";
    expect(text).toContain("Kind");
    expect(text).toContain("concept");
    expect(text).toContain("Sources");
    expect(text).toContain("paper.md, talk.md");
    expect(text).toContain("Confidence");
    expect(text).toContain("80%");
    expect(text).toContain("Provenance state");
    expect(text).toContain("merged");
    expect(text).toContain("Contradicted by");
    expect(text).toContain("Tags");
    expect(text).toContain("machine-learning, attention");
    expect(text).toContain("Aliases");
    expect(text).toContain("attn, self-attention");
    expect(text).toContain("Created");
    expect(text).toContain("2026-01-01T00:00:00.000Z");
    expect(text).toContain("Updated");
    expect(text).toContain("2026-05-14T00:00:00.000Z");

    // contradictedBy renders as a list of <li> items each carrying a slug anchor.
    const contradictionItems = rail.querySelectorAll("[data-contradiction-slug]");
    expect(contradictionItems.length).toBe(2);
    const firstItem = contradictionItems[0] as HTMLElement;
    const firstAnchor = firstItem.querySelector("a") as HTMLAnchorElement;
    expect(firstAnchor.getAttribute("href")).toBe("#/concepts/beta");
    expect(firstItem.textContent).toContain("beta");
    expect(firstItem.textContent).toContain("newer evidence");

    // Warnings block carries codes for unresolved + malformed citations.
    const warningCodes = Array.from(rail.querySelectorAll(".support-rail-warnings li")).map(
      (li) => (li as HTMLElement).dataset.code,
    );
    expect(warningCodes).toEqual(
      expect.arrayContaining(["unresolved_citation", "malformed_citation"]),
    );
  });

  it("omits rail rows when the frontmatter field is missing/empty (legacy pages still render)", async () => {
    const embedded: EmbeddedPage[] = [
      { id: "concepts/legacy", pageDirectory: "concepts", slug: "legacy", title: "Legacy", kind: "concept" },
    ];
    const fixture: PageFixture = {
      id: "concepts/legacy",
      pageDirectory: "concepts",
      slug: "legacy",
      title: "Legacy",
      frontmatter: {},
    };
    const { dom } = await mountViewerDom(embedded, responderFor(embedded, [fixture]));
    dom.window.location.hash = "#/concepts/legacy";
    await flushMicrotasks();
    const rail = dom.window.document.querySelector("[data-support-rail]") as HTMLElement;
    expect(rail.textContent).not.toContain("Kind");
    expect(rail.textContent).not.toContain("Confidence");
  });
});

describe("sidebar — concept grouping by kind", () => {
  it("groups concepts by frontmatter `kind`, missing kind falls back to concept", async () => {
    const embedded: EmbeddedPage[] = [
      { id: "concepts/a", pageDirectory: "concepts", slug: "a", title: "Alpha", kind: "concept" },
      { id: "concepts/b", pageDirectory: "concepts", slug: "b", title: "Beta", kind: "entity" },
      { id: "concepts/c", pageDirectory: "concepts", slug: "c", title: "Gamma", kind: "" },
      { id: "queries/q1", pageDirectory: "queries", slug: "q1", title: "Q1", kind: "" },
    ];
    const { dom } = await mountViewerDom(embedded, responderFor(embedded, []));
    const groups = dom.window.document.querySelectorAll(
      "[data-sidebar] details[data-kind]",
    ) as NodeListOf<HTMLDetailsElement>;
    const kinds = Array.from(groups).map((d) => d.dataset.kind);
    expect(kinds).toContain("concept");
    expect(kinds).toContain("entity");
    expect(kinds).toContain("query");
    expect(dom.window.document.querySelector("[data-sidebar] section h2")?.textContent).toBe("Project");
    // The fallback "concept" kind appears first among page groups.
    expect(kinds[0]).toBe("concept");
    // Two pages classified as concept (a + c with missing kind).
    const conceptGroup = Array.from(groups).find((d) => d.dataset.kind === "concept");
    expect(conceptGroup!.querySelectorAll("li").length).toBe(2);
  });

  it("renders groups as collapsible <details> elements (keyboard-toggleable by default)", async () => {
    const embedded: EmbeddedPage[] = [
      { id: "concepts/a", pageDirectory: "concepts", slug: "a", title: "Alpha", kind: "concept" },
    ];
    const { dom } = await mountViewerDom(embedded, responderFor(embedded, []));
    const group = dom.window.document.querySelector(
      "[data-sidebar] details[data-kind='concept']",
    ) as HTMLDetailsElement;
    expect(group).not.toBeNull();
    expect(group.tagName).toBe("DETAILS");
    expect(group.open).toBe(true);
    group.open = false;
    expect(group.open).toBe(false);
  });
});

const STICKY_EMBEDDED: EmbeddedPage[] = [
  { id: "concepts/alpha", pageDirectory: "concepts", slug: "alpha", title: "Alpha", kind: "concept" },
];

const STICKY_FIXTURE: PageFixture = {
  id: "concepts/alpha",
  pageDirectory: "concepts",
  slug: "alpha",
  title: "Alpha",
  frontmatter: { kind: "concept", tags: ["sticky-marker"] },
};

async function loadStickyPageAndNavigate(
  toHash: string,
  extras: { health?: Record<string, unknown>; index?: Record<string, unknown> } = {},
): Promise<HTMLElement> {
  const { dom } = await mountViewerDom(
    STICKY_EMBEDDED,
    responderFor(STICKY_EMBEDDED, [STICKY_FIXTURE], extras),
  );
  dom.window.location.hash = "#/concepts/alpha";
  await flushMicrotasks();
  const rail = dom.window.document.querySelector("[data-support-rail]") as HTMLElement;
  expect(rail.textContent).toContain("sticky-marker");
  dom.window.location.hash = toHash;
  await flushMicrotasks();
  return rail;
}

describe("stale support rail clearing", () => {
  it("clears the rail when navigating from a page to /#/index", async () => {
    const rail = await loadStickyPageAndNavigate("#/index", {
      index: { html: "<p>idx</p>", outgoingLinks: [], generatedAt: "x" },
    });
    expect(rail.textContent ?? "").not.toContain("sticky-marker");
  });

  it("clears the rail when navigating from a page to /#/health", async () => {
    const rail = await loadStickyPageAndNavigate("#/health", {
      health: { concepts: 1, lint: null },
    });
    expect(rail.textContent ?? "").not.toContain("sticky-marker");
  });

  it("clears the rail when navigating from a page to home (/)", async () => {
    const rail = await loadStickyPageAndNavigate("");
    expect(rail.textContent ?? "").not.toContain("sticky-marker");
  });

  it("clears the rail when navigating to a 404 page", async () => {
    const rail = await loadStickyPageAndNavigate("#/concepts/ghost");
    expect(rail.textContent ?? "").not.toContain("sticky-marker");
  });
});
