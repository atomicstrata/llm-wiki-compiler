/**
 * Typed entity LIST routes — the destination every profile type row needs.
 *
 * There was no such route at first: `STATIC_ROUTES` is an exact map with no
 * typed entries and the page pattern needs two segments, so a typed list hash
 * fell through to home. A nav row pointing at one would have been a dead link
 * that renders the dashboard and looks fine — the defect this branch has already
 * shipped once.
 *
 * Entity types are per-project, so the route table cannot be static: a hash is a
 * list route only when the envelope DECLARES the type it names. `#/nonsense`
 * must still fall back to home, because that fallback is what the nav-integrity
 * guard uses to tell a real route from a dead href.
 *
 * These routes are namespaced under `#/_type/` so a type named after a route the
 * viewer owns still reaches its own pages; the namespace itself is pinned in
 * test/viewer-typed-list-namespace.test.ts. Here it is only the form the hashes
 * take.
 */

import { describe, expect, it } from "vitest";
import { flushMicrotasks, mountViewerDom } from "./fixtures/viewer-jsdom.js";
import {
  deferredVocabularyResponder,
  mountVocabulary,
  typedPage,
  types,
  vocabularyEnvelope,
} from "./fixtures/viewer-vocabulary.js";

const NEWSROOM = types(["articles", 2], ["desks", 0]);

const PAGES = [
  typedPage("articles", "alpha", "2026-08-02T00:00:00.000Z"),
  typedPage("articles", "beta", "2026-08-03T00:00:00.000Z"),
];

/** Mount at `hash` and return the main pane. */
async function mainAt(hash: string): Promise<HTMLElement> {
  const doc = await mountVocabulary(NEWSROOM, { pages: PAGES, hash });
  return doc.querySelector("[data-main-pane]") as HTMLElement;
}

describe("a typed entity list route", () => {
  it("renders that type's pages under its title-cased name", async () => {
    const main = await mainAt("#/_type/articles");
    expect(main.querySelector("h1")?.textContent).toBe("Articles");
    expect(main.querySelectorAll(".list-row")).toHaveLength(2);
  });

  it("links each row at the typed page route that already resolves", async () => {
    const main = await mainAt("#/_type/articles");
    const hrefs = Array.from(main.querySelectorAll(".list-row a")).map((a) =>
      a.getAttribute("href"),
    );
    expect(hrefs).toEqual(["#/articles/beta", "#/articles/alpha"]);
  });

  it("marks its own sidebar entry current", async () => {
    const doc = await mountVocabulary(NEWSROOM, { pages: PAGES, hash: "#/_type/articles" });
    const current = doc.querySelector('.sidebar a[aria-current="page"]');
    expect(current?.getAttribute("data-route")).toBe("articles");
  });

  it("marks the type entry current for one of its pages too", async () => {
    const doc = await mountVocabulary(NEWSROOM, { pages: PAGES, hash: "#/articles/alpha" });
    const current = doc.querySelector('.sidebar a[aria-current="page"]');
    expect(current?.getAttribute("data-route")).toBe("articles");
  });
});

describe("a declared but empty type", () => {
  it("renders the teaching empty state, not the transient placeholder", async () => {
    const main = await mainAt("#/_type/desks");
    expect(main.querySelector(".empty-state-title")?.textContent).toBe("No desks yet");
    expect(main.querySelector(".placeholder")).toBeNull();
  });

  it("names the type in its body rather than talking about concepts", async () => {
    const main = await mainAt("#/_type/desks");
    expect(main.querySelector(".empty-state-body")?.textContent).toContain("desks");
  });
});

/**
 * `EntityTypeDef.directory` is required and declared independently of the type
 * id, and `profile/collect.ts` scans the DIRECTORY. So an empty state that
 * reconstructs the path from the id misdirects every profile where the two
 * differ: the author writes pages under the named directory, the collector never
 * reads it, nothing appears, and this same screen still reports the type empty.
 */
describe("the directory a declared-but-empty type points an author at", () => {
  const RENAMED = types(["articles", 2], ["ideas", 0, "wiki/ideas-v2"]);

  /** Mount `entityTypes` at `hash` and return the empty state's body text. */
  async function emptyBodyFor(entityTypes: unknown, hash: string): Promise<string> {
    const doc = await mountVocabulary(entityTypes as never, { hash });
    return doc.querySelector(".empty-state-body")?.textContent ?? "";
  }

  it("names the declared directory, not the type id", async () => {
    const body = await emptyBodyFor(RENAMED, "#/_type/ideas");
    expect(body).toContain("under wiki/ideas-v2/");
    expect(body).not.toContain("wiki/ideas/");
  });

  // `EntityTypeDef.directory` is a canonical PROJECT-RELATIVE path — every
  // shipped template spells it `wiki/<name>` and `scanEntityDir` resolves it
  // against the project root — so the renderer prints it verbatim. Re-adding a
  // `wiki/` prefix here would send an author to `wiki/wiki/desks/`.
  it("prints the project-relative path verbatim, without re-prefixing it", async () => {
    const body = await emptyBodyFor(types(["desks", 0]), "#/_type/desks");
    expect(body).toContain("under wiki/desks/");
    expect(body).not.toContain("wiki/wiki/");
  });

  it("does not double a prefix for a directory outside wiki/ either", async () => {
    const body = await emptyBodyFor(types(["desks", 0, "newsroom/desks"]), "#/_type/desks");
    expect(body).toContain("under newsroom/desks/");
    expect(body).not.toContain("wiki/newsroom");
  });

  it("names no path at all when the envelope declares none", async () => {
    const body = await emptyBodyFor([{ type: "desks", pageCount: 0 }], "#/_type/desks");
    expect(body).not.toContain("wiki/");
    expect(body).toContain("the directory your profile declares");
  });
});

describe("a hash naming no declared type", () => {
  it("still falls back to home", async () => {
    const main = await mainAt("#/nonsense");
    expect(main.className).toContain("dashboard");
  });

  it("falls back to home on a default project, where no type is declared", async () => {
    const doc = await mountVocabulary(undefined, { hash: "#/_type/articles" });
    const main = doc.querySelector("[data-main-pane]") as HTMLElement;
    expect(main.className).toContain("dashboard");
  });
});

describe("a cold deep link to a typed list route", () => {
  it("holds the shell's loading state until the envelope settles, then paints once", async () => {
    // The first pass cannot know `articles` is a type. It must not answer
    // "home" either: that render is async and would land AFTER the corrected
    // second pass, overwriting the list it had just drawn. Holding leaves the
    // shell's own "Loading…" line up, which is what the wait actually is.
    const { responder, release } = deferredVocabularyResponder(
      vocabularyEnvelope(NEWSROOM, PAGES),
    );
    const { dom } = await mountViewerDom(responder, "#/_type/articles");
    const main = dom.window.document.querySelector("[data-main-pane]") as HTMLElement;
    expect(main.querySelector(".placeholder")?.textContent).toContain("Loading");
    release();
    await flushMicrotasks();
    expect(main.className).toContain("list-pane");
    expect(main.querySelector("h1")?.textContent).toBe("Articles");
  });
});

/** Every nav entry the profile sidebar renders, read from the DOM. */
async function profileNavEntries(): Promise<{ route: string; href: string }[]> {
  const doc = await mountVocabulary(NEWSROOM, { pages: PAGES });
  return Array.from(doc.querySelectorAll(".sidebar a[data-route]")).map((a) => ({
    route: a.getAttribute("data-route") ?? "",
    href: a.getAttribute("href") ?? "",
  }));
}

describe("profile sidebar navigation — every rendered entry resolves to its own route", () => {
  // The same guard test/viewer-sidebar-nav.test.ts applies to a default project.
  // A dead href renders the dashboard and looks fine; only the aria-current
  // assertion separates a real route from one that fell through to home.
  it("navigating an entry's own href renders a route and marks that same entry current", async () => {
    const entries = await profileNavEntries();
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      const doc = await mountVocabulary(NEWSROOM, { pages: PAGES, hash: entry.href });
      const main = doc.querySelector("[data-main-pane]") as HTMLElement;
      const current = doc.querySelector('.sidebar a[aria-current="page"]');
      expect(main.childElementCount > 0 || main.className !== "main-pane").toBe(true);
      expect(current?.getAttribute("data-route"), `${entry.href} did not mark ${entry.route}`).toBe(
        entry.route,
      );
    }
  });
});
