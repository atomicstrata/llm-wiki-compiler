/**
 * DOM-level tests for the `#/health` route's Lint panel.
 *
 * The panel is the largest object on the health screen: total figures, a
 * stacked proportion bar with a legend, a row-per-rule table, and a footer
 * naming the highest-leverage rule. Every one of those is derived from
 * `lint.rules[]` (persisted by the linter's cache), so a payload without a
 * lint cache at all must degrade to the placeholder rather than render an
 * empty table — asserted explicitly below.
 *
 * The fixtures deliberately disagree with both the mockup (which showed
 * exactly four rules) and the demo wiki (which fires two): sixteen lint rules
 * exist, so the panel is driven here with six — past the four-colour palette
 * — and with a dominant rule that is not about the link graph, which are the
 * two shapes the mockup and the demo agreed to never produce.
 */

import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import os from "os";
import path from "path";
import { describe, expect, it } from "bun:test";
import { readLintCache } from "../src/linter/cache.js";
import { LAST_LINT_FILE, LLMWIKI_DIR } from "../src/utils/constants.js";
import {
  conceptPage,
  pagesEnvelope,
  renderHealthRoute,
  textOf,
  type Payload,
} from "./fixtures/viewer-health-fixture.js";

/** One persisted rule-aggregate row; defaults describe a rule confined to one page. */
function ruleRow(name: string, count: number, overrides: Payload = {}): Payload {
  return {
    rule: name,
    severity: "warning",
    count,
    fileCount: 1,
    topFile: "wiki/concepts/alpha.md",
    topFileCount: count,
    ...overrides,
  };
}

/** Two rules with a deliberately lopsided 3:1 split, so proportions are checkable. */
const LINT: Payload = {
  warnings: 5,
  errors: 15,
  at: "2026-08-05T19:01:00.000Z",
  rules: [
    { rule: "broken-wikilink", severity: "error", count: 15, fileCount: 3, topFile: "wiki/concepts/alpha.md", topFileCount: 11 },
    { rule: "missing-summary", severity: "warning", count: 5, fileCount: 5, topFile: "wiki/concepts/beta.md", topFileCount: 1 },
  ],
};

/** Six rules — two more than the palette can colour — dominated by a rule the graph says nothing about. */
const SIX: Payload = {
  warnings: 26,
  errors: 9,
  at: LINT.at,
  rules: [
    ruleRow("missing-summary", 12, { fileCount: 12, topFile: "wiki/concepts/beta.md", topFileCount: 1 }),
    ruleRow("broken-wikilink", 9, { severity: "error", fileCount: 2, topFileCount: 7 }),
    ruleRow("empty-page", 6, { fileCount: 6, topFile: "wiki/concepts/gamma.md", topFileCount: 1 }),
    ruleRow("low-confidence", 4, { fileCount: 4, topFile: "wiki/concepts/delta.md", topFileCount: 1 }),
    ruleRow("duplicate-concept", 3, { fileCount: 3, topFile: "wiki/concepts/epsilon.md", topFileCount: 1 }),
    ruleRow("journal-health", 1, { topFile: ".llmwiki/journal" }),
  ],
};

/** A pages envelope containing the two concept pages the rules above point at. */
const PAGES = pagesEnvelope([conceptPage("alpha"), conceptPage("beta")]);

/** Every page the six-rule fixture points at, so no row is unroutable by accident. */
const WIDE_PAGES = pagesEnvelope(
  ["alpha", "beta", "gamma", "delta", "epsilon"].map((slug) => conceptPage(slug)),
);

/** Render the health route with a lint cache attached to an otherwise clean wiki. */
function withLint(lint: Payload | null, pages = PAGES): Promise<HTMLElement> {
  return renderHealthRoute({ concepts: 2, queries: 0, sourceFiles: 1, sources: 1, lint }, pages);
}

/** Read the rendered rule rows' cells for one column class. */
function column(main: HTMLElement, cls: string): string[] {
  return [...main.querySelectorAll(`.lint-row:not(.is-head) ${cls}`)].map(
    (n) => n.textContent?.trim() ?? "",
  );
}

describe("lint panel — headline totals", () => {
  it("chips the combined problem count and prints both figures", async () => {
    const main = await withLint(LINT);
    expect(textOf(main, ".lint-chip")).toBe("20 PROBLEMS");
    expect(textOf(main, ".lint-figure.is-errors")).toBe("15");
    expect(textOf(main, ".lint-figure.is-warnings")).toBe("5");
  });

  it("pluralizes the figure labels against their own counts", async () => {
    const main = await withLint({ ...LINT, errors: 1, warnings: 1 });
    const labels = [...main.querySelectorAll(".lint-figure-label")].map((n) => n.textContent);
    expect(labels).toEqual(["error", "warning"]);
  });

  it("marks the panel warm only while problems remain", async () => {
    expect((await withLint(LINT)).querySelector("[data-lint-panel]")?.className).toContain("has-problems");
    const clean = await withLint({ warnings: 0, errors: 0, at: LINT.at, rules: [] });
    expect(clean.querySelector("[data-lint-panel]")?.className).not.toContain("has-problems");
  });
});

describe("lint panel — stacked proportion bar and legend", () => {
  it("sizes one segment per rule in proportion to its share of the total", async () => {
    const main = await withLint(LINT);
    const widths = [...main.querySelectorAll(".lint-bar-seg")].map((n) => (n as HTMLElement).style.width);
    expect(widths).toEqual(["75%", "25%"]);
  });

  it("ranks segments so each rule takes the next colour in the palette", async () => {
    const main = await withLint(LINT);
    const ranks = [...main.querySelectorAll(".lint-bar-seg")].map((n) => n.getAttribute("data-rank"));
    expect(ranks).toEqual(["0", "1"]);
  });

  it("labels each legend entry with its rule name and count", async () => {
    const main = await withLint(LINT);
    const legend = [...main.querySelectorAll(".lint-legend-item")].map((n) => n.textContent?.trim());
    expect(legend).toEqual(["broken-wikilink 15", "missing-summary 5"]);
  });
});

describe("lint panel — one table row per rule", () => {
  it("renders a row per rule, naming each rule and its count", async () => {
    const main = await withLint(LINT);
    expect(main.querySelectorAll(".lint-row:not(.is-head)")).toHaveLength(2);
    expect(column(main, ".lint-rule")).toEqual(["broken-wikilink", "missing-summary"]);
    expect(column(main, ".lint-count")).toEqual(["15", "5"]);
  });

  it("names the dominant file and its share when one page carries most findings", async () => {
    const main = await withLint(LINT);
    expect(column(main, ".lint-affected")[0]).toBe("alpha · 11 of 15");
  });

  it("names the file alone when it is the only one a rule flagged", async () => {
    const rules = [{ ...(LINT.rules as Payload[])[0], fileCount: 1, topFileCount: 15 }];
    const main = await withLint({ ...LINT, rules });
    expect(column(main, ".lint-affected")).toEqual(["alpha"]);
  });

  it("counts the files instead when a rule is spread across many", async () => {
    const main = await withLint(LINT);
    expect(column(main, ".lint-affected")[1]).toBe("5 files");
  });
});

describe("lint panel — the FIX cell navigates only to routes that exist", () => {
  it("links the most-affected page when its path maps to a real page route", async () => {
    const main = await withLint(LINT);
    const link = main.querySelector(".lint-row:not(.is-head) a.lint-fix");
    expect(link?.getAttribute("href")).toBe("#/concepts/alpha");
    expect(link?.textContent).toBe("view →");
  });

  it("renders plain text when the flagged file is not a wiki page", async () => {
    const rules = [{ ...(LINT.rules as Payload[])[0], topFile: ".llmwiki/journal.json" }];
    const main = await withLint({ ...LINT, rules });
    expect(main.querySelector(".lint-row:not(.is-head) a.lint-fix")).toBeNull();
    expect(column(main, ".lint-fix")).toEqual(["—"]);
  });

  it("renders plain text when the path looks routable but no such page exists", async () => {
    const rules = [{ ...(LINT.rules as Payload[])[0], topFile: "wiki/concepts/ghost.md" }];
    const main = await withLint({ ...LINT, rules });
    expect(main.querySelector(".lint-row:not(.is-head) a.lint-fix")).toBeNull();
  });
});

describe("lint panel — footer insight", () => {
  it("names the dominant rule's share of the problems", async () => {
    const main = await withLint(LINT);
    expect(textOf(main, ".lint-insight")).toBe("15 of 20 problems come from broken-wikilink.");
  });

  it("omits the footer band entirely on a clean run", async () => {
    const main = await withLint({ warnings: 0, errors: 0, at: LINT.at, rules: [] });
    expect(main.querySelector(".lint-footer")).toBeNull();
    expect(main.querySelector(".lint-row:not(.is-head)")).toBeNull();
  });
});

describe("lint panel — the footer's button goes where its label says", () => {
  it("opens the graph explorer for every rule that is about the link graph", async () => {
    for (const name of ["broken-wikilink", "orphaned-page", "schema-cross-link-minimum"]) {
      const main = await withLint({ ...LINT, warnings: 20, errors: 0, rules: [ruleRow(name, 20)] });
      const action = main.querySelector(".lint-action");
      expect(action?.getAttribute("href"), name).toBe("#/graph");
      expect(action?.textContent, name).toBe("Open the graph explorer");
    }
  });

  it("opens the most affected page, and names it, when the dominant rule is not", async () => {
    const main = await withLint(SIX, WIDE_PAGES);
    expect(textOf(main, ".lint-insight")).toBe("12 of 35 problems come from missing-summary.");
    const action = main.querySelector(".lint-action");
    expect(action?.getAttribute("href")).toBe("#/concepts/beta");
    expect(action?.textContent).toBe("Open beta");
  });

  it("keeps the insight but drops the button when neither destination resolves", async () => {
    const rules = [ruleRow("journal-health", 20, { topFile: ".llmwiki/journal" })];
    const main = await withLint({ ...LINT, warnings: 20, errors: 0, rules });
    expect(textOf(main, ".lint-insight")).toBe("20 of 20 problems come from journal-health.");
    expect(main.querySelector(".lint-action")).toBeNull();
  });
});

describe("lint panel — more rules than the palette can colour", () => {
  it("keeps the top four rules and folds the rest into one aggregate row", async () => {
    const main = await withLint(SIX, WIDE_PAGES);
    expect(column(main, ".lint-rule")).toEqual([
      "missing-summary",
      "broken-wikilink",
      "empty-page",
      "low-confidence",
      "other",
    ]);
  });

  it("counts the folded row as the sum of the rules it covers, and says how many", async () => {
    const main = await withLint(SIX, WIDE_PAGES);
    expect(column(main, ".lint-count")).toEqual(["12", "9", "6", "4", "4"]);
    expect(column(main, ".lint-affected")[4]).toBe("2 rules");
  });

  it("says one rule, not one rules, when the fold covers a single rule", async () => {
    const rules = (SIX.rules as Payload[]).slice(0, 5);
    const main = await withLint({ ...SIX, warnings: 25, rules }, WIDE_PAGES);
    expect(column(main, ".lint-affected")[4]).toBe("1 rule");
    expect(column(main, ".lint-count")[4]).toBe("3");
  });

  it("leaves the folded row unroutable, like every other row with no single page", async () => {
    const main = await withLint(SIX, WIDE_PAGES);
    expect(column(main, ".lint-fix")[4]).toBe("—");
  });
});

describe("lint panel — the legend stays unambiguous past four rules", () => {
  it("draws five legend entries for six rules, the last one the aggregate", async () => {
    const main = await withLint(SIX, WIDE_PAGES);
    const legend = [...main.querySelectorAll(".lint-legend-item")].map((n) => n.textContent?.trim());
    expect(legend).toEqual([
      "missing-summary 12",
      "broken-wikilink 9",
      "empty-page 6",
      "low-confidence 4",
      "other 4",
    ]);
  });

  it("gives no two visible swatches the same colour", async () => {
    const main = await withLint(SIX, WIDE_PAGES);
    const swatches = [...main.querySelectorAll(".lint-swatch")];
    const colours = swatches.map((n) => n.getAttribute("data-rank") ?? "neutral");
    expect(colours).toEqual(["0", "1", "2", "3", "neutral"]);
    expect(new Set(colours).size).toBe(swatches.length);
  });

  it("keeps the aggregate off the rank palette in the bar, legend and table alike", async () => {
    const main = await withLint(SIX, WIDE_PAGES);
    for (const selector of [".lint-bar-seg", ".lint-swatch", ".lint-rule"]) {
      const last = [...main.querySelectorAll(selector)].pop() as HTMLElement;
      expect(last.className, selector).toContain("is-other");
      expect(last.getAttribute("data-rank"), selector).toBeNull();
    }
  });

  it("still spends the whole bar once the remainder is folded in", async () => {
    const main = await withLint(SIX, WIDE_PAGES);
    const widths = [...main.querySelectorAll(".lint-bar-seg")].map((n) =>
      parseFloat((n as HTMLElement).style.width),
    );
    expect(widths).toHaveLength(5);
    expect(widths.reduce((sum, width) => sum + width, 0)).toBeCloseTo(100, 6);
  });
});

/**
 * The entry `readLintCache` actually yields for a cache whose rows contradict
 * its totals — read through the real reader, not hand-shaped, so the panel is
 * proven to degrade against exactly what `/api/health` would hand it.
 */
async function readInconsistentCache(): Promise<Payload> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lint-panel-"));
  await mkdir(path.join(dir, LLMWIKI_DIR), { recursive: true });
  const rules = [ruleRow("broken-wikilink", 65, { topFileCount: 99 })];
  const contradictory = JSON.stringify({ warnings: 4, errors: 6, at: LINT.at, rules });
  await writeFile(path.join(dir, LAST_LINT_FILE), contradictory, "utf-8");
  const entry = await readLintCache(dir);
  await rm(dir, { recursive: true, force: true });
  return entry as unknown as Payload;
}

describe("lint panel — an internally inconsistent cache degrades to totals only", () => {
  it("keeps the chip and both figures once the reader has dropped the rows", async () => {
    const main = await withLint(await readInconsistentCache());
    expect(textOf(main, ".lint-chip")).toBe("10 PROBLEMS");
    expect(textOf(main, ".lint-figure.is-errors")).toBe("6");
    expect(textOf(main, ".lint-figure.is-warnings")).toBe("4");
  });

  it("renders no table, legend or footer rather than contradicting the chip", async () => {
    const main = await withLint(await readInconsistentCache());
    for (const selector of [".lint-row", ".lint-bar-seg", ".lint-legend-item", ".lint-footer"]) {
      expect(main.querySelector(selector), selector).toBeNull();
    }
  });
});

describe("lint panel — degrades when lint has never run", () => {
  it("shows the run-lint placeholder instead of an empty table", async () => {
    const main = await withLint(null);
    expect(textOf(main, "[data-lint-panel] .placeholder")).toBe(
      "No cached lint summary yet — run `llmwiki lint`.",
    );
  });

  it("renders no table, bar, chip or footer without a lint cache", async () => {
    const main = await withLint(null);
    for (const sel of [".lint-row", ".lint-bar", ".lint-chip", ".lint-footer", ".lint-figure"]) {
      expect(main.querySelector(sel), sel).toBeNull();
    }
  });

  it("keeps the panel and its title so the screen's layout does not collapse", async () => {
    const main = await withLint(null);
    expect(main.querySelector("[data-lint-panel]")).not.toBeNull();
    expect(textOf(main, "[data-lint-panel] .panel-title")).toBe("Lint");
  });
});
