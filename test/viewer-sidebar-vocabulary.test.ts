/**
 * BROWSE is a projection of the active profile's declared entity types.
 *
 * The design's central claim is that "Concepts" was never a fixed label — it is
 * what the DEFAULT profile calls its one entity type. So a default project must
 * render exactly the sidebar it renders today, and a profile project renders its
 * own types in that same slot. Both halves are pinned here, the default one
 * first, because it is the regression this whole change risks.
 *
 * Dashboard sits above the section; Sources and Graph explorer follow the
 * category rows inside it.
 */

import { describe, expect, it } from "vitest";
import {
  browseEntries,
  browseProfileName,
  manyTypes,
  mountVocabularySidebar,
  typeRows,
  types,
} from "./fixtures/viewer-vocabulary.js";

/** The row count above which categories get a total. */
const CAP = 11;

describe("BROWSE on a default project", () => {
  it("keeps the default browse rows in order below the standalone Dashboard", async () => {
    const sidebar = await mountVocabularySidebar(undefined);
    expect(browseEntries(sidebar)).toEqual([
      { route: "concepts", href: "#/concepts", label: "Concepts" },
      { route: "queries", href: "#/queries", label: "Queries" },
    ]);
  });

  it("puts no profile name on the BROWSE header", async () => {
    const sidebar = await mountVocabularySidebar(undefined);
    expect(browseProfileName(sidebar)).toBeNull();
  });

  it("renders no type group at all", async () => {
    const sidebar = await mountVocabularySidebar(undefined);
    expect(sidebar.querySelector(".nav-type-group")).toBeNull();
  });
});

describe("BROWSE on a profile project", () => {
  it("places Dashboard before and outside the Categories section", async () => {
    const sidebar = await mountVocabularySidebar(types(["articles", 6]));
    const dashboard = sidebar.querySelector('a[data-route="home"]');
    const categories = sidebar.querySelector(".nav-section");
    expect(dashboard?.textContent).toContain("Dashboard");
    expect(dashboard?.getAttribute("href")).toBe("#/");
    expect(dashboard?.closest(".nav-section")).toBeNull();
    expect(dashboard!.compareDocumentPosition(categories!) & 4).toBe(4);
  });
  it("replaces Concepts and Queries with the profile's own types", async () => {
    const sidebar = await mountVocabularySidebar(types(["articles", 6], ["desks", 3]));
    const entries = browseEntries(sidebar);
    expect(entries.map((e) => e.route)).toEqual([
      "articles",
      "desks",
    ]);
  });

  it("puts source files and graph exploration outside Categories", async () => {
    const sidebar = await mountVocabularySidebar(types(["articles", 6]));
    const categories = sidebar.querySelector(".nav-section");
    const source = sidebar.querySelector('a[href="#/sources"]');
    const graph = sidebar.querySelector('a[href="#/graph"]');
    expect(categories?.contains(source)).toBe(false);
    expect(categories?.contains(graph)).toBe(false);
    expect(source?.closest(".nav-section")).toBe(graph?.closest(".nav-section"));
    expect(source?.closest(".nav-section")?.querySelector(".nav-section-label")?.textContent).toBe("EXPLORE");
  });

  it("links each type row at its own namespaced list route", async () => {
    // Namespaced under `#/_type/` so a type named after a route the viewer owns
    // still reaches its own pages — see test/viewer-typed-list-namespace.test.ts.
    const sidebar = await mountVocabularySidebar(types(["articles", 6]));
    const row = sidebar.querySelector('a[data-route="articles"]');
    expect(row?.getAttribute("href")).toBe("#/_type/articles");
  });

  it("title-cases the label while the type id stays the route", async () => {
    const sidebar = await mountVocabularySidebar(types(["instrument_calibrations", 14]));
    const row = sidebar.querySelector('a[data-route="instrument_calibrations"]');
    expect(row?.querySelector(".nav-label")?.textContent).toBe("Instrument calibrations");
  });
});

describe("type row ordering", () => {
  it("sorts by page count descending, declaration order breaking ties", async () => {
    // Declared desks-before-bylines with equal counts: declaration order keeps
    // desks first, alphabetical would put bylines first. articles jumping the
    // queue from second is the count-descending half.
    const sidebar = await mountVocabularySidebar(
      types(["desks", 3], ["articles", 6], ["bylines", 3]),
    );
    expect(typeRows(sidebar)).toEqual(["articles", "desks", "bylines"]);
  });

  it("never re-sorts alphabetically when counts already differ", async () => {
    const sidebar = await mountVocabularySidebar(types(["zebras", 9], ["ants", 2]));
    expect(typeRows(sidebar)).toEqual(["zebras", "ants"]);
  });
});

describe("a type with no pages", () => {
  it("still gets a row — its absence is information", async () => {
    const sidebar = await mountVocabularySidebar(types(["articles", 6], ["stringers", 0]));
    expect(typeRows(sidebar)).toEqual(["articles", "stringers"]);
  });

  it("shows a dim em dash rather than a zero", async () => {
    const sidebar = await mountVocabularySidebar(types(["stringers", 0]));
    const count = sidebar.querySelector('a[data-route="stringers"] .nav-count');
    expect(count?.textContent).toBe("—");
    expect(count?.className).toContain("nav-count-zero");
  });
});

describe("a long type name", () => {
  it("keeps its full text as a title attribute on the label", async () => {
    const sidebar = await mountVocabularySidebar(types(["instrument_calibrations", 14]));
    const label = sidebar.querySelector('a[data-route="instrument_calibrations"] .nav-label');
    expect(label?.getAttribute("title")).toBe("Instrument calibrations");
  });

  it("never truncates the count, which is the scanning target", async () => {
    const sidebar = await mountVocabularySidebar(types(["instrument_calibrations", 148]));
    const count = sidebar.querySelector('a[data-route="instrument_calibrations"] .nav-count');
    expect(count?.textContent).toBe("148");
  });
});

describe("a type named after a route the viewer already owns", () => {
  // The built-in `autosci` template declares both `sources` and `reviews`, so
  // this is a shipped case, not a hypothetical one.
  const SHADOWING = types(["papers", 4], ["sources", 2]);

  it("still gets its row — a declared type is never silently dropped", async () => {
    const sidebar = await mountVocabularySidebar(SHADOWING);
    expect(typeRows(sidebar)).toEqual(["papers", "sources"]);
  });

  it("marks the fixed entry at that hash, never the type row it shadows", async () => {
    const sidebar = await mountVocabularySidebar(SHADOWING, "#/sources");
    const marked = sidebar.querySelector('a[aria-current="page"]');
    expect(marked?.hasAttribute("data-nav-type")).toBe(false);
    expect(marked?.getAttribute("href")).toBe("#/sources");
  });

  it("relabels the FIXED row so the two are told apart, keeping the type's own name", async () => {
    // Identity here is the href, not the label: the fixed row yields its name
    // when a type takes it (see `disambiguated`, viewer-sidebar.js), because the
    // type name is the reader's data and "Source files" is the more precise
    // description of what that route lists anyway.
    const sidebar = await mountVocabularySidebar(SHADOWING);
    const labels = [...sidebar.querySelectorAll(".nav-link .nav-label")].map((el) => el.textContent);
    expect(labels).toContain("Sources");
    expect(labels).toContain("Source files");
    expect(labels.length).toBe(new Set(labels).size);
  });
});

describe("the profile name on the BROWSE header", () => {
  it("sits on the header itself, not on a row of its own", async () => {
    const sidebar = await mountVocabularySidebar(types(["articles", 6]));
    expect(browseProfileName(sidebar)).toBe("newsroom");
    expect(sidebar.querySelector(".nav-section-head .nav-section-label")?.textContent).toBe(
      "CATEGORIES",
    );
  });

  it("states the true total for a long category list", async () => {
    const sidebar = await mountVocabularySidebar(manyTypes(CAP + 1));
    expect(browseProfileName(sidebar)).toBe(`newsroom · ${CAP + 1}`);
  });
});

describe("long category lists", () => {
  it("does not cover the final category or claim rows are hidden", async () => {
    const sidebar = await mountVocabularySidebar(manyTypes(CAP + 3));
    expect(sidebar.querySelector(".nav-type-fade")).toBeNull();
    expect(sidebar.querySelector(".nav-type-residual")).toBeNull();
    expect(typeRows(sidebar)).toHaveLength(14);
  });

  it("keeps every type in the list", async () => {
    const sidebar = await mountVocabularySidebar(manyTypes(CAP + 3));
    expect(typeRows(sidebar)).toHaveLength(CAP + 3);
  });

  it("offers Pipeline only under Maintain, without a duplicate All types shortcut", async () => {
    const sidebar = await mountVocabularySidebar(manyTypes(CAP + 1));
    const links = sidebar.querySelectorAll('a[href="#/pipeline"]');
    expect(links).toHaveLength(1);
    expect(links[0]?.textContent).toContain("Lifecycle status");
    expect(links[0]?.closest(".nav-section")?.querySelector(".nav-section-label")?.textContent).toBe("MAINTAIN");
  });
});

describe("short category lists", () => {
  it("shows no fade, no residual and no All types", async () => {
    const sidebar = await mountVocabularySidebar(manyTypes(CAP));
    expect(sidebar.querySelector(".nav-type-group")?.className).not.toContain("is-capped");
    expect(sidebar.querySelector(".nav-type-residual")).toBeNull();
    expect(sidebar.querySelector(".nav-type-all")).toBeNull();
  });

  it("still names the profile on the header, without a count", async () => {
    const sidebar = await mountVocabularySidebar(manyTypes(CAP));
    expect(browseProfileName(sidebar)).toBe("newsroom");
  });
});
