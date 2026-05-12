/**
 * DOM-level tests for the viewer's client script.
 *
 * Mounts `src/viewer/assets/viewer.js` into a JSDOM instance carrying
 * the same shell template the server renders, stubs `fetch` to return a
 * fixture `/api/pages` envelope, and asserts the script renders the
 * sidebar groups, the home dashboard, and a placeholder for the
 * render-pending page payload Slice 4 will replace with real HTML.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { readFile } from "fs/promises";
import path from "path";
import { JSDOM, VirtualConsole } from "jsdom";

const SHELL_PATH = path.resolve("src/viewer/assets/index.html");
const SCRIPT_PATH = path.resolve("src/viewer/assets/viewer.js");

interface FixturePage {
  id: string;
  pageDirectory: "concepts" | "queries";
  slug: string;
  title: string;
  kind?: string;
  summary?: string;
  updatedAt?: string;
  warnings?: Array<{ code: string; message: string }>;
}

function pagesEnvelope(pages: FixturePage[]): Record<string, unknown> {
  return {
    project: { title: "demo-wiki", rootName: "demo-wiki" },
    counts: { concepts: 1, queries: 1, sourceFiles: 0, pendingReviews: 0 },
    index: { available: false, href: "/#/index" },
    recentPages: [],
    pages,
    updatedAt: "2026-05-12T00:00:00.000Z",
  };
}

function pagePayload(page: FixturePage, html: string): Record<string, unknown> {
  return {
    id: page.id,
    title: page.title,
    pageDirectory: page.pageDirectory,
    slug: page.slug,
    html,
    citations: [],
    outgoingLinks: [],
    frontmatter: {},
    warnings: html === "" ? [{ code: "render_pending", message: "Markdown rendering ships in Slice 4." }] : [],
    updatedAt: "",
    createdAt: "",
    generatedAt: "2026-05-12T00:00:00.000Z",
  };
}

interface ViewerHarness {
  dom: JSDOM;
  fetchMock: ReturnType<typeof vi.fn>;
  bootViewer(): Promise<void>;
}

async function mountViewer(pages: FixturePage[]): Promise<ViewerHarness> {
  const [shell, script] = await Promise.all([
    readFile(SHELL_PATH, "utf-8"),
    readFile(SCRIPT_PATH, "utf-8"),
  ]);
  const embedded = `<script type="application/json" id="page-index">${
    JSON.stringify({ pages }).replace(/</g, "\\u003c")
  }</script>`;
  const html = shell.replace("<!--PAGE_INDEX-->", embedded);

  const fetchMock = vi.fn(async (input: string | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.endsWith("/api/pages")) return jsonResponse(pagesEnvelope(pages));
    const pageMatch = url.match(/\/api\/page\/([^/]+)\/([^/]+)$/);
    if (pageMatch) {
      const page = pages.find(
        (p) =>
          p.pageDirectory === pageMatch[1] && p.slug === decodeURIComponent(pageMatch[2]),
      );
      if (!page) return new Response(null, { status: 404 });
      return jsonResponse(pagePayload(page, ""));
    }
    return new Response(null, { status: 404 });
  });

  const virtualConsole = new VirtualConsole();
  const dom = new JSDOM(html, {
    url: "http://127.0.0.1:0/",
    runScripts: "outside-only",
    virtualConsole,
  });
  (dom.window as unknown as { fetch: typeof fetchMock }).fetch = fetchMock;

  return {
    dom,
    fetchMock,
    bootViewer: () =>
      new Promise<void>((resolve) => {
        dom.window.eval(script);
        // Allow microtasks (the initial /api/pages fetch + render) to settle.
        setTimeout(() => resolve(), 25);
      }),
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("viewer.js — first paint + sidebar", () => {
  it("renders the embedded page-index blob into sidebar groups before any fetch", async () => {
    const pages: FixturePage[] = [
      { id: "concepts/alpha", pageDirectory: "concepts", slug: "alpha", title: "Alpha" },
      { id: "queries/q1", pageDirectory: "queries", slug: "q1", title: "Q1" },
    ];
    const { dom, bootViewer } = await mountViewer(pages);
    await bootViewer();
    const sidebar = dom.window.document.querySelector("[data-sidebar]")!;
    expect(sidebar.textContent).toContain("Concepts");
    expect(sidebar.textContent).toContain("Alpha");
    expect(sidebar.textContent).toContain("Saved Queries");
    expect(sidebar.textContent).toContain("Q1");
  });

  it("renders the home dashboard with project title from /api/pages", async () => {
    const pages: FixturePage[] = [
      { id: "concepts/alpha", pageDirectory: "concepts", slug: "alpha", title: "Alpha" },
    ];
    const { dom, bootViewer } = await mountViewer(pages);
    await bootViewer();
    expect(dom.window.document.querySelector("[data-app-title]")!.textContent).toBe("demo-wiki");
    const main = dom.window.document.querySelector("[data-main-pane]")!;
    expect(main.textContent).toContain("demo-wiki");
  });
});

describe("viewer.js — hash router", () => {
  it("renders the render_pending placeholder when /api/page returns empty html", async () => {
    const pages: FixturePage[] = [
      { id: "concepts/alpha", pageDirectory: "concepts", slug: "alpha", title: "Alpha" },
    ];
    const { dom, bootViewer } = await mountViewer(pages);
    await bootViewer();
    dom.window.location.hash = "#/concepts/alpha";
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    const main = dom.window.document.querySelector("[data-main-pane]")!;
    expect(main.textContent).toContain("Alpha");
    expect(main.textContent).toContain("Page rendering ships in Slice 4.");
  });
});

describe("viewer.js — malformed hash routes", () => {
  it("treats a hash with malformed percent-encoding as the home route, without throwing", async () => {
    const pages: FixturePage[] = [
      { id: "concepts/alpha", pageDirectory: "concepts", slug: "alpha", title: "Alpha" },
    ];
    const { dom, fetchMock, bootViewer } = await mountViewer(pages);
    await bootViewer();
    fetchMock.mockClear();
    dom.window.location.hash = "#/concepts/%E0%A4%A";
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    // No /api/page fetch was issued (the malformed slug fell back to home),
    // and the dashboard re-renders rather than the browser tab crashing.
    const fetchedPaths = fetchMock.mock.calls.map((args) => String(args[0]));
    expect(fetchedPaths.some((p) => p.includes("/api/page/"))).toBe(false);
    const main = dom.window.document.querySelector("[data-main-pane]")!;
    expect(main.textContent).toContain("demo-wiki");
  });
});

describe("viewer.js — accessibility landmarks", () => {
  it("ships header, nav, main, aside, and a skip link", async () => {
    const { dom, bootViewer } = await mountViewer([]);
    await bootViewer();
    const doc = dom.window.document;
    expect(doc.querySelector("header")).not.toBeNull();
    expect(doc.querySelector("nav")).not.toBeNull();
    expect(doc.querySelector("main")).not.toBeNull();
    expect(doc.querySelector("aside")).not.toBeNull();
    const skip = doc.querySelector(".skip-link") as HTMLAnchorElement | null;
    expect(skip).not.toBeNull();
    expect(skip!.getAttribute("href")).toBe("#main-pane");
  });
});
