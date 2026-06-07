/**
 * Support-rail + sidebar-grouping + stale-rail-clearing + freshness-badge tests.
 *
 * Mounts the real viewer assets through `mountViewerDom` and drives
 * hash-route navigation to assert the right metadata renders on the
 * right route. Covers every Slice-5 review finding that touches the
 * client's right-hand rail or the sidebar group structure, plus the
 * Slice-9 freshness badges and the "Freshness as of…" caption.
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

// --- Freshness badge tests ---

/** Build a page payload carrying the given freshness object. */
function freshnessPagePayload(slug: string, freshness: Record<string, unknown>): Record<string, unknown> {
  return {
    id: `concepts/${slug}`,
    pageDirectory: "concepts",
    slug,
    title: slug,
    html: "<p>Body</p>",
    citations: [],
    outgoingLinks: [],
    frontmatter: {},
    warnings: [],
    updatedAt: "",
    createdAt: "",
    generatedAt: "2026-05-14T00:00:00.000Z",
    freshness,
  };
}

/** Navigate to a concepts page with the given freshness and return the rail. */
async function railForFreshness(slug: string, freshness: Record<string, unknown>): Promise<HTMLElement> {
  const embedded: EmbeddedPage[] = [
    { id: `concepts/${slug}`, pageDirectory: "concepts", slug, title: slug, kind: "concept" },
  ];
  const responder: FetchResponder = (url) => {
    if (url.endsWith("/api/pages")) return pagesResponse(embedded);
    if (url.includes(`/api/page/concepts/${slug}`)) {
      return jsonResponse(freshnessPagePayload(slug, freshness));
    }
    return null;
  };
  const { dom } = await mountViewerDom(embedded, responder);
  dom.window.location.hash = `#/concepts/${slug}`;
  await flushMicrotasks();
  return dom.window.document.querySelector("[data-support-rail]") as HTMLElement;
}

describe("freshness badges", () => {
  it("renders .badge-stale for a stale page", async () => {
    const rail = await railForFreshness("stale-page", {
      freshnessStatus: "stale", contradicted: false, archived: false,
    });
    expect(rail.querySelector(".badge-stale")).not.toBeNull();
    expect(rail.querySelector(".badge-orphaned")).toBeNull();
  });

  it("renders .badge-orphaned for an orphaned page", async () => {
    const rail = await railForFreshness("orphaned-page", {
      freshnessStatus: "orphaned", contradicted: false, archived: false,
    });
    expect(rail.querySelector(".badge-orphaned")).not.toBeNull();
    expect(rail.querySelector(".badge-stale")).toBeNull();
  });

  it("renders .badge-contradicted for a contradicted page", async () => {
    const rail = await railForFreshness("contradicted-page", {
      freshnessStatus: "fresh", contradicted: true, archived: false,
    });
    expect(rail.querySelector(".badge-contradicted")).not.toBeNull();
  });

  it("renders .badge-archived for an archived page", async () => {
    const rail = await railForFreshness("archived-page", {
      freshnessStatus: "fresh", contradicted: false, archived: true,
    });
    expect(rail.querySelector(".badge-archived")).not.toBeNull();
  });

  it("renders NO freshness badge for a fresh page", async () => {
    const rail = await railForFreshness("fresh-page", {
      freshnessStatus: "fresh", contradicted: false, archived: false,
    });
    expect(rail.querySelector(".freshness-badge")).toBeNull();
  });

  it("renders NO freshness badge for an unverified (query/hand-authored) page", async () => {
    const rail = await railForFreshness("unverified-page", {
      freshnessStatus: "unverified", contradicted: false, archived: false,
    });
    expect(rail.querySelector(".freshness-badge")).toBeNull();
  });

  it("shows the 'Freshness as of' caption when generatedAt is present", async () => {
    const rail = await railForFreshness("any-page", {
      freshnessStatus: "fresh", contradicted: false, archived: false,
    });
    expect(rail.querySelector(".freshness-caption")).not.toBeNull();
    expect(rail.textContent).toContain("Freshness as of");
    expect(rail.textContent).toContain("2026-05-14T00:00:00.000Z");
  });

  it("stale+contradicted page shows both badges independently", async () => {
    const rail = await railForFreshness("multi-badge-page", {
      freshnessStatus: "stale", contradicted: true, archived: false,
    });
    expect(rail.querySelector(".badge-stale")).not.toBeNull();
    expect(rail.querySelector(".badge-contradicted")).not.toBeNull();
  });
});
