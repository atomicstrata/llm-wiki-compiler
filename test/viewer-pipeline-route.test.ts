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
 * pages that still declare the field. Clean copy is scoped to counted records,
 * not a claim that missing-state records were included or work was executed.
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
    declaredStates: ["active", "archived", "paused"],
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
    expect(callout?.textContent).toContain("the configured transitions cannot reach it");
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

  it("limits the clean verdict to counted records", async () => {
    const row = await rowFor("desks");
    expect(row.querySelector(".pipeline-gap")?.textContent).toBe("All counted records have recognized states");
    expect(row.querySelector(".pipeline-gap")?.className).toContain("is-clean");
  });
});

describe("#/pipeline — explicit record counts", () => {
  it("shows an empty category without claiming its records passed validation", async () => {
    const envelope = { ...ENVELOPE, profilePipeline: { ...ENVELOPE.profilePipeline,
      entityTypes: [{ ...DESKS, pageCount: 0, stateCounts: {} }] } };
    const { dom } = await mountViewerDom(envelopeBootstrapResponse(envelope), "#/pipeline");
    const row = dom.window.document.querySelector('[data-entity-type="desks"]')!;
    expect(row.querySelector(".pipeline-none")?.textContent).toBe("No records");
    expect(row.querySelector('[data-state="active"]')?.textContent).toBe("0 active");
    expect(row.querySelector(".pipeline-gap")?.textContent).not.toContain("recognized");
    expect(row.querySelector(".pipeline-callout")).toBeNull();
    dom.window.close();
  });

  it("shows exact counts including unused declared states without progress bars", async () => {
    const row = await rowFor("desks");
    expect(row.querySelector('[data-state="active"]')?.textContent).toBe("2 active");
    expect(row.querySelector('[data-state="archived"]')?.textContent).toBe("1 archived · terminal");
    expect(row.querySelector('[data-state="paused"]')?.textContent).toBe("0 paused");
    expect(row.querySelector(".pipeline-bar")).toBeNull();
    expect(row.querySelector(".pipeline-callout")).toBeNull();
  });

  it("keeps relationship definitions collapsed separately from current states", async () => {
    const doc = await mountPipeline();
    const details = doc.querySelector("details.pipeline-relations");
    expect(details).not.toBeNull();
    expect(details?.hasAttribute("open")).toBe(false);
    expect(details?.querySelector("summary")?.textContent).toContain("How records connect");
    expect(doc.querySelector(".panel-title")?.textContent).toBe("Lifecycle status");
  });
});

describe("#/pipeline — relation types", () => {
  it("shows each relation's endpoints, direction and live count", async () => {
    const doc = await mountPipeline();
    const chip = doc.querySelector(".pipeline-relation-chip") as HTMLElement;
    expect(chip.textContent).toContain("Filed under");
    expect(chip.textContent).toContain("Articles");
    expect(chip.textContent).toContain("Desks");
    expect(chip.querySelector(".pipeline-relation-arrow")?.textContent?.trim()).toBe("→");
    expect(chip.querySelector(".pipeline-relation-count")?.textContent).toBe("6 recorded links");
  });

  it("summarises how many types and whether they are directed", async () => {
    const doc = await mountPipeline();
    expect(doc.querySelector(".pipeline-relations .technical-details")?.textContent).toContain('"direction": "directed"');
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
