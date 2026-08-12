/**
 * Typed LIST routes live in their own namespace: `#/_type/<entity-type>`.
 *
 * The single-segment form they shipped with (`#/articles`) collided with the
 * viewer's own fixed routes. The built-in `autosci` template declares entity
 * types named `sources` and `reviews`, and the viewer owns `#/sources` and
 * `#/reviews` — so on an autosci project those two type rows navigated to the
 * viewer's own surfaces instead of the type's pages. Namespacing the list route
 * fixes that without making the profile schema depend on the viewer's route
 * list, which is what reserving the viewer's route names would have meant.
 *
 * `_type` is a prefix no profile can ever claim: entity type keys must be
 * slug-safe (`^[a-z0-9][a-z0-9-]*$`, src/profile/identity.ts) and a leading
 * underscore is not, so `#/_type/<x>` can never also be a legitimate page route.
 *
 * It is still TWO segments, so it also matches the page-hash pattern — the
 * router has to resolve the namespace FIRST, and the tests below pin that order
 * from both sides: a namespaced hash never reaches `/api/page`, and a real page
 * hash still does.
 */

import { describe, expect, it } from "vitest";
import { flushMicrotasks, jsonResponse, mountViewerDom } from "./fixtures/viewer-jsdom.js";
import {
  typedPage,
  types,
  vocabularyEnvelope,
  vocabularyResponder,
} from "./fixtures/viewer-vocabulary.js";

/** The shipped autosci collision, reduced to its two colliding names. */
const AUTOSCI = types(["papers", 2], ["sources", 2], ["reviews", 1]);

const PAGES = [
  typedPage("papers", "alpha", "2026-08-02T00:00:00.000Z"),
  typedPage("papers", "beta", "2026-08-03T00:00:00.000Z"),
  typedPage("sources", "corpus-a", "2026-08-02T00:00:00.000Z"),
  typedPage("sources", "corpus-b", "2026-08-03T00:00:00.000Z"),
  typedPage("reviews", "round-one", "2026-08-01T00:00:00.000Z"),
];

/** The viewer's own source-file list has to have something in it to be told apart. */
const SOURCE_FILENAMES = ["karpathy.md", "sutton.md"];

/** Mount an autosci-shaped project at `hash`, serving every route it can reach. */
async function mountAutosci(hash?: string) {
  const envelope = vocabularyEnvelope(AUTOSCI, PAGES, { sourceFilenames: SOURCE_FILENAMES });
  const served = vocabularyResponder(envelope);
  const mounted = await mountViewerDom(
    (url) =>
      url.includes("/api/page/")
        ? jsonResponse({ title: "ALPHA", pageDirectory: "papers", html: "<p>body</p>", warnings: [] })
        : served(url),
    hash,
  );
  await flushMicrotasks();
  return mounted;
}

/** The main pane of an autosci project mounted at `hash`. */
async function mainAt(hash: string): Promise<HTMLElement> {
  const { dom } = await mountAutosci(hash);
  return dom.window.document.querySelector("[data-main-pane]") as HTMLElement;
}

/** The nav link the sidebar marks current, or null when it marks none. */
async function markedAt(hash: string): Promise<Element | null> {
  const { dom } = await mountAutosci(hash);
  return dom.window.document.querySelector('.sidebar a[aria-current="page"]');
}

describe("a typed list route at its namespaced hash", () => {
  it("renders that type's pages under its title-cased name", async () => {
    const main = await mainAt("#/_type/papers");
    expect(main.querySelector("h1")?.textContent).toBe("Papers");
    expect(main.querySelectorAll(".list-row")).toHaveLength(2);
  });

  it("is where the sidebar's type row points", async () => {
    const { dom } = await mountAutosci();
    const row = dom.window.document.querySelector('.sidebar a[data-nav-type][data-route="papers"]');
    expect(row?.getAttribute("href")).toBe("#/_type/papers");
  });

  it("marks its own type row current", async () => {
    const marked = await markedAt("#/_type/papers");
    expect(marked?.getAttribute("data-route")).toBe("papers");
    expect(marked?.hasAttribute("data-nav-type")).toBe(true);
  });
});

describe("an entity type named after a route the viewer owns", () => {
  it("lands on ITS pages, not the viewer's source-file list", async () => {
    const main = await mainAt("#/_type/sources");
    const titles = Array.from(main.querySelectorAll(".list-row .list-title")).map(
      (n) => n.textContent,
    );
    expect(titles).toEqual(["CORPUS-B", "CORPUS-A"]);
    expect(main.textContent).not.toContain("karpathy.md");
  });

  it("highlights its own type row rather than the fixed Sources entry", async () => {
    const marked = await markedAt("#/_type/sources");
    expect(marked?.getAttribute("data-route")).toBe("sources");
    expect(marked?.hasAttribute("data-nav-type")).toBe(true);
  });

  it("leaves the viewer's own #/sources list exactly where it was", async () => {
    const main = await mainAt("#/sources");
    expect(main.textContent).toContain("karpathy.md");
    const marked = await markedAt("#/sources");
    expect(marked?.hasAttribute("data-nav-type")).toBe(false);
  });

  it("leaves #/reviews on the review queue, not the reviews entity type", async () => {
    const marked = await markedAt("#/reviews");
    expect(marked?.getAttribute("data-route")).toBe("reviews");
    expect(marked?.hasAttribute("data-nav-type")).toBe(false);
  });
});

describe("the namespace resolves before the page pattern", () => {
  it("never asks /api/page for a namespaced list hash", async () => {
    // `#/_type/papers` matches `#/<directory>/<slug>` too. Resolving the page
    // pattern first would fetch `/api/page/_type/papers`, 400, and paint a
    // not-found placeholder over the list.
    const { fetchMock } = await mountAutosci("#/_type/papers");
    const requested = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(requested.some((url) => url.includes("/api/page/"))).toBe(false);
  });

  it("still resolves a real typed page hash through the page pattern", async () => {
    const main = await mainAt("#/papers/alpha");
    expect(main.querySelector("h1")?.textContent).toBe("ALPHA");
    expect(main.querySelector(".rendered-body")).toBeTruthy();
  });
});

describe("a hash the namespace does not claim", () => {
  it("falls back to home for an undeclared type", async () => {
    const main = await mainAt("#/_type/nonsense");
    expect(main.className).toContain("dashboard");
  });

  it("still falls back to home for #/nonsense", async () => {
    // The nav-integrity guard (test/viewer-sidebar-nav.test.ts) uses this
    // fallback to tell a real route from a dead href.
    const main = await mainAt("#/nonsense");
    expect(main.className).toContain("dashboard");
  });

  it("no longer treats the bare type name as a route", async () => {
    const main = await mainAt("#/papers");
    expect(main.className).toContain("dashboard");
  });
});
