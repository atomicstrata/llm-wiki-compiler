/**
 * `#/reviews` list-route contract.
 *
 * The sidebar's "Reviews" entry pointed at `#/health` and no `#/reviews` route
 * existed, so clicking it navigated somewhere the label did not promise AND
 * highlighted "Health & lint" instead of itself (`markActive` maps the hash, and
 * both entries shared one). The last describe block below is the regression
 * guard for exactly that report.
 *
 * The route is a peer of #/concepts / #/queries / #/sources, so it reuses their
 * `.list-row` language — but it fetches `/api/reviews` per visit rather than
 * reading the bootstrap envelope, because candidates live on disk outside the
 * frozen snapshot. An empty queue is the COMMON case and a good one, so it
 * renders the design system's empty state, never the italic loading placeholder.
 */

import { describe, expect, it } from "vitest";
import {
  emptyBootstrapResponse,
  jsonResponse,
  mountViewerDom,
  type FetchResponder,
} from "./fixtures/viewer-jsdom.js";

const REVIEWS = [
  {
    id: "transformer-attention-a1b2c3d4",
    title: "Transformer attention",
    slug: "transformer-attention",
    summary: "Every token is weighted against every other token.",
    sources: ["karpathy.md", "lecun.md"],
    generatedAt: "2026-08-01T00:00:00.000Z",
    reviewMode: "policy",
    heldReasons: [{ code: "low-confidence", detail: "confidence 0.4 < 0.6" }],
    targetDirectory: "concepts",
  },
  {
    id: "backprop-e5f6a7b8",
    title: "Backprop",
    slug: "backprop",
    summary: "Gradients flow backwards through the network.",
    sources: ["lecun.md"],
    generatedAt: "2026-08-02T00:00:00.000Z",
    reviewMode: "imported",
    heldReasons: [{ code: "imported-okf" }, { code: "contradicted" }],
    targetDirectory: "concepts",
  },
];

/**
 * A TYPED candidate: staged by the typed planner, so `review approve` routes it
 * on `targetEntityType` to `wiki/papers/`. It carries no `targetDirectory` —
 * typed staging sets the entity type, not the directory — which is exactly the
 * shape that used to fall through to the literal "concepts".
 */
const TYPED_REVIEW = {
  id: "attention-is-all-you-need-c9d0e1f2",
  title: "Attention Is All You Need",
  slug: "attention-is-all-you-need",
  summary: "The transformer architecture.",
  sources: ["crossref.json"],
  generatedAt: "2026-08-03T00:00:00.000Z",
  reviewMode: "connector-fetched",
  heldReasons: [{ code: "connector-fetched" }],
  targetEntityType: "papers",
};

/**
 * Responder serving the given `/api/reviews` payload over an empty project.
 * `total` defaults to the row count — the un-truncated case — and is passed
 * explicitly to mimic a queue the endpoint's cap cut short.
 */
function responderWithReviews(reviews: unknown[], total = reviews.length): FetchResponder {
  return (url) => {
    if (url.endsWith("/api/reviews")) return jsonResponse({ reviews, total });
    return emptyBootstrapResponse(url);
  };
}

/** Mount at `#/reviews` with the given rows and return the main pane. */
async function mountReviews(reviews: unknown[], total?: number): Promise<HTMLElement> {
  const { dom } = await mountViewerDom(responderWithReviews(reviews, total), "#/reviews");
  return dom.window.document.querySelector("[data-main-pane]") as HTMLElement;
}

describe("#/reviews", () => {
  it("renders one row per pending candidate", async () => {
    const main = await mountReviews(REVIEWS);
    expect(main.querySelectorAll(".list-row")).toHaveLength(2);
    expect(main.textContent).toContain("Transformer attention");
    expect(main.textContent).toContain("Backprop");
  });

  it("shows each candidate's summary, sources, and age", async () => {
    const main = await mountReviews(REVIEWS);
    const row = main.querySelector(".list-row") as HTMLElement;
    expect(row.textContent).toContain("Every token is weighted against every other token.");
    expect(row.textContent).toContain("karpathy.md");
    expect(row.textContent).toContain("lecun.md");
    expect(row.querySelector(".list-age")?.textContent).toBeTruthy();
  });

  it("states why a candidate is held in human wording, not the raw policy code", async () => {
    const main = await mountReviews(REVIEWS);
    const reasons = Array.from(main.querySelectorAll(".review-reason")).map((n) => n.textContent);
    expect(reasons).toContain("Low confidence");
    expect(reasons).not.toContain("low-confidence");
    expect(reasons).toContain("Imported from an OKF bundle");
    expect(reasons).toContain("Contradicts its sources");
  });

  it("does not link a candidate title — the page it proposes does not exist yet", async () => {
    const main = await mountReviews(REVIEWS);
    expect(main.querySelector(".list-row a")).toBeNull();
  });
});

describe("#/reviews — where approval actually writes", () => {
  // `routeApprovedPageWrite` branches on `targetEntityType` FIRST: a typed
  // candidate goes through the profile-validated planner to
  // `wiki/<entityType>/<slug>.md`, and only a candidate without one takes the
  // concepts/queries path. The review queue is the screen whose whole job is to
  // tell a reviewer what they are about to accept, so it must name the same
  // destination approval uses.
  it("names the declared entity type for a typed candidate", async () => {
    const main = await mountReviews([TYPED_REVIEW]);
    expect(main.querySelector(".review-sources")?.textContent).toContain("→ wiki/papers/");
  });

  it("does not label a typed candidate a concept", async () => {
    const main = await mountReviews([TYPED_REVIEW]);
    expect(main.querySelector(".review-sources")?.textContent).not.toContain("concepts");
  });

  it("still names the directory for a default candidate", async () => {
    const main = await mountReviews(REVIEWS);
    expect(main.querySelector(".review-sources")?.textContent).toContain("→ wiki/concepts/");
  });

  it("falls back to concepts only when the candidate declares neither", async () => {
    const { targetDirectory: _omitted, ...untargeted } = REVIEWS[0];
    const main = await mountReviews([untargeted]);
    expect(main.querySelector(".review-sources")?.textContent).toContain("→ wiki/concepts/");
  });
});

describe("#/reviews — empty queue", () => {
  it("renders the design system's empty state with the real CLI command", async () => {
    const main = await mountReviews([]);
    const state = main.querySelector(".empty-state");
    expect(state).toBeTruthy();
    expect(state?.querySelector(".empty-state-title")?.textContent).toBe("Nothing awaiting review");
    expect(state?.querySelector(".empty-state-command")?.textContent).toBe(
      "$ llmwiki compile --review",
    );
  });

  it("is neither the italic loading placeholder nor a blank pane", async () => {
    const main = await mountReviews([]);
    expect(main.querySelector(".placeholder")).toBeNull();
    expect(main.textContent?.trim()).not.toBe("");
    expect(main.querySelector("h1")?.textContent).toBe("Reviews");
  });
});

describe("#/reviews — a queue larger than the endpoint's cap", () => {
  // `/api/reviews` is bounded (see src/viewer/reviews.ts), so a long queue
  // arrives already cut short. A list that quietly stops at the cap reads as
  // "you have 200 pending reviews", so the pane must state the slice — the
  // same honesty the Lint panel's `other · N rules` roll-up follows.
  it("says how many it is showing out of how many exist", async () => {
    const main = await mountReviews(REVIEWS, 5000);
    expect(main.querySelector(".list-caption")?.textContent).toContain(
      "Showing 2 of 5000 pending candidates",
    );
  });

  it("names the CLI that shows the whole queue, since the viewer cannot", async () => {
    const main = await mountReviews(REVIEWS, 5000);
    expect(main.querySelector(".list-caption")?.textContent).toContain("llmwiki review list");
  });

  it("shows no truncation notice when the whole queue is on screen", async () => {
    const main = await mountReviews(REVIEWS);
    expect(main.querySelector(".list-caption")).toBeNull();
    expect(main.querySelectorAll(".list-row")).toHaveLength(2);
  });

  it("shows no truncation notice for an empty queue", async () => {
    const main = await mountReviews([]);
    expect(main.querySelector(".list-caption")).toBeNull();
  });
});

/** Mount on the home route, click the sidebar's Reviews entry, and settle. */
async function clickSidebarReviews(): Promise<Window> {
  const mounted = await mountViewerDom(responderWithReviews(REVIEWS));
  const win = mounted.dom.window as unknown as Window;
  (win.document.querySelector('a[data-route="reviews"]') as HTMLElement).click();
  await mounted.flush();
  return win;
}

describe("sidebar Reviews entry", () => {
  it("points at #/reviews, not #/health", async () => {
    const { dom } = await mountViewerDom(responderWithReviews([]));
    const link = dom.window.document.querySelector('a[data-route="reviews"]');
    expect(link?.getAttribute("href")).toBe("#/reviews");
  });

  it("lands on #/reviews and highlights Reviews, not Health & lint", async () => {
    const { document: doc, location } = await clickSidebarReviews();
    expect(location.hash).toBe("#/reviews");
    expect(doc.querySelector('a[data-route="reviews"]')?.getAttribute("aria-current")).toBe("page");
    expect(doc.querySelector('a[data-route="health"]')?.getAttribute("aria-current")).toBeNull();
  });

  it("renders the pending candidates once navigated there", async () => {
    const { document: doc } = await clickSidebarReviews();
    expect(doc.querySelectorAll("[data-main-pane] .list-row")).toHaveLength(2);
  });
});
