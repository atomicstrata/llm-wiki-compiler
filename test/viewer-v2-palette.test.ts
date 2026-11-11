/**
 * The v2 command palette and keyboard shortcuts: page ranking, the grouped
 * item list, recents in storage, the key resolution rules, and the rendered
 * shortcut list and palette shell. Everything here is pure or rendered to
 * static markup, so no browser globals are set up.
 */
import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { SearchResult } from "../viewer-v2/src/api.js";
import { CommandPalette, groupRuns, stepIndex } from "../viewer-v2/src/command-palette.js";
import { navDestinations } from "../viewer-v2/src/nav.js";
import { pageScore, paletteItems, rankPages, readRecent, rememberPage, RECENT_LIMIT, wordScore } from "../viewer-v2/src/palette-model.js";
import { isPaletteChord, isPlainKey, isTypingContext, resolveKey, ShortcutList } from "../viewer-v2/src/shortcuts.js";
import { envelope, memoryStore, page, text } from "./fixtures/viewer-v2-fixtures.js";

const ROWS = [
  page({ id: "concepts/founder-separation", title: "Founder Separation Negotiations", summary: "Terms of leaving." }),
  page({ id: "concepts/kiln", title: "Kiln Firing Log", summary: "Cone 6 notes from the founder's studio." }),
  page({ id: "concepts/retirement", title: "Retirement Assets Offset Against Joint Cash", summary: "" }),
];

describe("page ranking", () => {
  it("prefers a title start, then a word start, then inside a word, then a close subsequence", () => {
    expect(wordScore("found", "Founder Separation")).toBeGreaterThan(wordScore("sep", "Founder Separation"));
    expect(wordScore("sep", "Founder Separation")).toBeGreaterThan(wordScore("par", "Founder Separation"));
    expect(wordScore("fsep", "Founder Separation", true)).toBeGreaterThan(0);
    expect(wordScore("fsep", "Founder Separation")).toBe(0);
    expect(wordScore("josh", "Retirement Assets Offset Against Joint Cash", true)).toBe(0);
    expect(wordScore("art", "Smart Art")).toBe(wordScore("art", "Pop Art"));
  });

  it("needs every word, ranks title hits above summary hits, and drops non-matches", () => {
    expect(pageScore("founder kiln", ROWS[0])).toBeNull();
    expect(rankPages("founder", ROWS).map((row) => row.id)).toEqual(["concepts/founder-separation", "concepts/kiln"]);
    expect(rankPages("zzz", ROWS)).toEqual([]);
  });
});

describe("palette items", () => {
  const wiki = envelope({ pages: ROWS });
  const destinations = navDestinations(wiki, null);
  const textResults: SearchResult[] = [
    { id: "concepts/kiln", pageDirectory: "concepts", title: "Kiln Firing Log", snippet: "…[[cone 6]] glaze…", matchedIn: "body" },
    { id: "concepts/glaze", pageDirectory: "concepts", title: "Glaze Recipes", snippet: "…cone 6 [[Kiln|kiln]]…", matchedIn: "body" },
  ];

  it("shows recent pages then every destination before anything is typed", () => {
    const items = paletteItems("", { rows: ROWS, recentIds: ["concepts/kiln", "concepts/gone"], destinations, textResults: [] });
    expect(items[0]).toMatchObject({ group: "Recent", label: "Kiln Firing Log", href: "#/concepts/kiln" });
    expect(items.filter((item) => item.group === "Recent")).toHaveLength(1);
    expect(items.slice(1).map((item) => item.label)).toEqual(destinations.map((destination) => destination.label));
  });

  it("groups pages, matching screens, new full-text hits, and a full search row", () => {
    const items = paletteItems("kiln", { rows: ROWS, recentIds: [], destinations, textResults });
    expect(items.map((item) => `${item.group}:${item.label}`)).toEqual([
      "Pages:Kiln Firing Log",
      "In page text:Glaze Recipes",
      "Search:Search page text for “kiln”",
    ]);
    expect(items[1].detail).toBe("…cone 6 kiln…");
    expect(items[2].href).toBe("#/_search?q=kiln");
    expect(paletteItems("graph", { rows: ROWS, recentIds: [], destinations, textResults: [] })[0]).toMatchObject({ group: "Go to", href: "#/graph" });
  });

  it("splits rows into runs of one group, keeping each row's place in the whole list", () => {
    const items = paletteItems("kiln", { rows: ROWS, recentIds: [], destinations, textResults });
    expect(groupRuns(items).map((run) => [run.group, run.rows.map((row) => row.index)])).toEqual([["Pages", [0]], ["In page text", [1]], ["Search", [2]]]);
  });

  it("wraps the active row at either end", () => {
    expect(stepIndex(0, -1, 3)).toBe(2);
    expect(stepIndex(2, 1, 3)).toBe(0);
    expect(stepIndex(0, 1, 0)).toBe(0);
  });
});

describe("recent pages", () => {
  it("keeps the newest first without duplicates, capped, and survives junk or broken storage", () => {
    const store = memoryStore();
    for (let index = 0; index < RECENT_LIMIT + 2; index += 1) rememberPage(`concepts/p${index}`, store);
    rememberPage("concepts/p3", store);
    const recent = readRecent(store);
    expect(recent[0]).toBe("concepts/p3");
    expect(recent).toHaveLength(RECENT_LIMIT);
    expect(new Set(recent).size).toBe(RECENT_LIMIT);
    store.setItem("llmwiki.v2.recentPages", "{not json");
    expect(readRecent(store)).toEqual([]);
    expect(() => rememberPage("x", { getItem: () => null, setItem: () => { throw new Error("full"); } })).not.toThrow();
  });
});

describe("keyboard shortcuts", () => {
  it("resolves single keys and g sequences", () => {
    expect(resolveKey("/", false)).toEqual({ action: { kind: "palette" }, gPending: false });
    expect(resolveKey("j", false).action).toEqual({ kind: "row", step: 1 });
    expect(resolveKey("g", false)).toEqual({ action: null, gPending: true });
    expect(resolveKey("g", true).action).toEqual({ kind: "go", href: "#/graph" });
    expect(resolveKey("x", true)).toEqual({ action: null, gPending: false });
    expect(resolveKey("x", false).action).toBeNull();
  });

  it("stays out of fields and dialogs", () => {
    const inside = (selector: string) => ({ closest: (query: string) => (query.includes(selector) ? {} : null) });
    expect(isTypingContext(inside("input") as unknown as EventTarget)).toBe(true);
    expect(isTypingContext(inside("dialog[open]") as unknown as EventTarget)).toBe(true);
    expect(isTypingContext({ closest: () => null } as unknown as EventTarget)).toBe(false);
    expect(isTypingContext(null)).toBe(false);
    expect(isPaletteChord({ metaKey: true, ctrlKey: false, key: "K" })).toBe(true);
    expect(isPaletteChord({ metaKey: false, ctrlKey: false, key: "k" })).toBe(false);
    expect(isPlainKey({ metaKey: false, ctrlKey: false, altKey: true, target: null })).toBe(false);
    expect(isPlainKey({ metaKey: false, ctrlKey: false, altKey: false, target: null })).toBe(true);
  });

  it("lists every shortcut, and the palette renders closed", () => {
    const list = text(renderToStaticMarkup(createElement(ShortcutList)));
    expect(list).toContain("Search and jump ⌘ K or /");
    expect(list).toContain("Go to Graph explorer g g");
    const palette = renderToStaticMarkup(createElement(CommandPalette, { wiki: envelope({ pages: ROWS }), health: null }));
    expect(palette).toMatch(/^<dialog[^>]*aria-label="Command palette"[^>]*><\/dialog>$/);
  });
});
