/**
 * `#/pipeline` route contract — hue follows reachability.
 *
 * The panel's whole claim is that its colours are DERIVED, never decorative: a
 * state is teal because the profile declares it terminal, red because no
 * declared transition can reach it, and violet in an order that came from
 * `initial` + `transitions` rather than from the order somebody happened to list
 * the enum in. Each of those is pinned below, and the enum in the fixture is
 * deliberately shuffled so a renderer that read it instead of the graph fails.
 *
 * The third column is a FINDING, not a warning: `entityCounts` validates and
 * `tallyLifecycleStates` does not, so the difference is exactly the rejected
 * pages that still declare the field. It has to say so, and say "every page
 * valid" when there is no difference at all.
 */

import { describe, expect, it } from "vitest";
import { envelopeBootstrapResponse, mountViewerDom } from "./fixtures/viewer-jsdom.js";

/** Articles: ordered chain, a declared terminal, and a state nothing can reach. */
const ARTICLES = {
  type: "articles",
  pageCount: 6,
  stateCounts: { draft: 4, edited: 1, published: 2, killed: 1 },
  lifecycle: {
    field: "stage",
    initial: "draft",
    terminal: ["published"],
    transitions: { draft: ["edited"], edited: ["published"], killed: [] },
    // Shuffled on purpose: enum order is NOT transition order.
    declaredStates: ["published", "killed", "draft", "edited"],
  },
};

/** Desks: the plain ordered case, and the tally that matches its valid count. */
const DESKS = {
  type: "desks",
  pageCount: 3,
  stateCounts: { active: 2, archived: 1 },
  lifecycle: {
    field: "stage",
    initial: "active",
    terminal: ["archived"],
    transitions: { active: ["archived"] },
    declaredStates: ["active", "archived"],
  },
};

/** Bylines: two declared states, no terminal, no edges — nothing orders them. */
const BYLINES = {
  type: "bylines",
  pageCount: 3,
  stateCounts: { confirmed: 3, pending: 1 },
  lifecycle: {
    field: "stage",
    initial: "pending",
    terminal: [],
    transitions: { pending: [], confirmed: [] },
    declaredStates: ["pending", "confirmed"],
  },
};

const ENVELOPE = {
  project: { title: "newsroom", rootName: "newsroom" },
  profileId: "newsroom",
  counts: {},
  pages: [],
  recentPages: [],
  index: { available: false },
  profileProblems: [{ kind: "field-violation", message: "missing headline" }],
  profileProblemTotal: 4,
  profilePipeline: {
    entityTypes: [ARTICLES, DESKS, BYLINES],
    relationTypes: [
      { type: "filed-under", from: ["articles"], to: ["desks"], direction: "directed", count: 6 },
    ],
  },
};

/** Mount at `#/pipeline` and return the rendered document. */
async function mountPipeline(): Promise<Document> {
  const { dom } = await mountViewerDom(envelopeBootstrapResponse(ENVELOPE), "#/pipeline");
  return dom.window.document;
}

/** The row element for one entity type. */
async function rowFor(type: string): Promise<HTMLElement> {
  const doc = await mountPipeline();
  return doc.querySelector(`[data-entity-type="${type}"]`) as HTMLElement;
}

describe("#/pipeline — the transition chain", () => {
  it("orders the chain from transitions + initial, not from enum order", async () => {
    const row = await rowFor("articles");
    expect(row.querySelector(".pipeline-chain")?.textContent).toBe("draft → edited → published");
  });

  it("names the declared initial and terminal states", async () => {
    const row = await rowFor("articles");
    expect(row.querySelector(".pipeline-declared")?.textContent).toBe(
      "initial draft · terminal published",
    );
  });

  it("implies no order for a type that declares no transitions and no terminal", async () => {
    const row = await rowFor("bylines");
    expect(row.querySelector(".pipeline-chain")).toBeNull();
    expect(row.querySelector(".pipeline-declared")?.textContent).toContain("order not derivable");
  });
});

describe("#/pipeline — hue follows reachability", () => {
  it("gives a declared terminal state the terminal treatment", async () => {
    const row = await rowFor("articles");
    const chip = row.querySelector('[data-state="published"]');
    expect(chip?.querySelector(".pipeline-swatch")?.className).toContain("is-terminal");
  });

  it("draws a state no transition reaches as unreachable", async () => {
    const row = await rowFor("articles");
    const chip = row.querySelector('[data-state="killed"]');
    expect(chip?.className).toContain("is-unreachable");
    expect(chip?.textContent).toContain("unreachable");
  });

  it("calls the unreachable state out by name, inline", async () => {
    const row = await rowFor("articles");
    const callout = row.querySelector(".pipeline-callout");
    expect(callout?.textContent).toContain("killed");
    expect(callout?.textContent).toContain("the lifecycle cannot produce it");
  });

  it("leaves every state of an orderless type fully neutral", async () => {
    const row = await rowFor("bylines");
    const marked = row.querySelectorAll(".is-terminal, .is-unreachable");
    expect(marked).toHaveLength(0);
    expect(row.querySelector(".pipeline-callout")).toBeNull();
  });
});

describe("#/pipeline — tally vs valid pages", () => {
  it("reports the tally sum and the rejected pages inside it", async () => {
    const row = await rowFor("articles");
    expect(row.querySelector(".pipeline-sum")?.textContent).toBe("8");
    expect(row.querySelector(".pipeline-gap")?.textContent).toBe("2 rejected pages counted here");
  });

  it("says every page is valid when the tally matches the count", async () => {
    const row = await rowFor("desks");
    expect(row.querySelector(".pipeline-gap")?.textContent).toBe("every page valid");
    expect(row.querySelector(".pipeline-gap")?.className).toContain("is-clean");
  });
});

describe("#/pipeline — the proportional bar", () => {
  /** Every segment width of one row, as the percentage number it was set to. */
  async function barWidths(type: string): Promise<number[]> {
    const row = await rowFor(type);
    return Array.from(row.querySelectorAll(".pipeline-seg")).map((seg) =>
      Number.parseFloat((seg as HTMLElement).style.width),
    );
  }

  it("sizes each segment by its share of the tally", async () => {
    expect(await barWidths("articles")).toEqual([50, 12.5, 25, 12.5]);
  });

  it("gives the last segment the remainder so the bar always fills", async () => {
    const widths = await barWidths("desks");
    expect(widths).toEqual([66.6, 33.4]);
    expect(widths.reduce((sum, width) => sum + width, 0)).toBe(100);
  });
});

describe("#/pipeline — relation types", () => {
  it("shows each relation's endpoints, direction and live count", async () => {
    const doc = await mountPipeline();
    const chip = doc.querySelector(".pipeline-relation-chip") as HTMLElement;
    expect(chip.textContent).toContain("filed-under");
    expect(chip.textContent).toContain("articles");
    expect(chip.textContent).toContain("desks");
    expect(chip.querySelector(".pipeline-relation-arrow")?.textContent).toBe("→");
    expect(chip.querySelector(".pipeline-relation-count")?.textContent).toBe("6");
  });

  it("summarises how many types and whether they are directed", async () => {
    const doc = await mountPipeline();
    expect(doc.querySelector(".pipeline-relations-summary")?.textContent).toBe("1 type · directed");
  });
});

describe("#/pipeline — the rejected-pages footer", () => {
  it("states how many rejected pages sit inside the tallies above", async () => {
    const doc = await mountPipeline();
    const footer = doc.querySelector(".pipeline-footer") as HTMLElement;
    expect(footer.textContent).toContain("3 rejected pages");
    expect(footer.querySelector("a")?.getAttribute("href")).toBe("#/health");
  });
});
