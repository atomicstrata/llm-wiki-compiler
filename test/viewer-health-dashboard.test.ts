/**
 * DOM-level tests for the `#/health` page head and CONTENTS strip.
 *
 * The Nebula health screen replaced the route's five stat cards with one
 * bordered CONTENTS strip of five rule-divided columns. The whole-wiki
 * verdict is NOT stated here — it lives in the shared header, on every
 * route — so what this file guards about the verdict is that the page grew
 * no second copy of it (see test/viewer-header.test.ts for the verdict's own
 * branch coverage). The Lint panel and the right-hand column have their own
 * files (viewer-health-lint, viewer-health-panels) so no file approaches the
 * 400-line cap.
 *
 * The state-status banner block stays here because the banner is injected by
 * viewer.js around the health view rather than by the view itself.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { flushMicrotasks, jsonResponse, mountViewerDom, type FetchResponder } from "./fixtures/viewer-jsdom.js";
import {
  conceptPage,
  pagesEnvelope,
  renderHealthRoute,
  textOf,
  type Payload,
} from "./fixtures/viewer-health-fixture.js";

afterEach(() => {
  vi.restoreAllMocks();
});

/** Read one CONTENTS column's big figure by its data-contents key. */
function figure(main: HTMLElement, key: string): string {
  return textOf(main, `[data-contents="${key}"] .contents-value`);
}

/** Read one CONTENTS column's small mono suffix by its data-contents key. */
function suffix(main: HTMLElement, key: string): string {
  return textOf(main, `[data-contents="${key}"] .contents-suffix`);
}

/**
 * Five distinct primes, one per CONTENTS column, so no two figures can share
 * a rendered digit — a textContent assertion on one can never accidentally
 * pass because a different column printed it.
 */
const FULL_HEALTH: Payload = {
  concepts: 11, queries: 13, sources: 17, sourceFiles: 19,
  stale: 0, orphaned: 0, pendingReviews: 23,
  lint: { warnings: 1, errors: 2, at: "2026-08-05T19:01:00.000Z", rules: [] },
};

describe("health head — title, verdict pill, lint run caption", () => {
  it("renders the Health title and the lint last-run caption", async () => {
    const main = await renderHealthRoute(FULL_HEALTH);
    expect(textOf(main, ".health-title")).toBe("Health");
    expect(textOf(main, ".health-lint-run")).toContain("lint last run 2026-08-05 19:01Z");
  });

  it("says lint has never run when the cache is absent", async () => {
    const main = await renderHealthRoute({ ...FULL_HEALTH, lint: null });
    expect(textOf(main, ".health-lint-run")).toBe("lint has never run");
  });
});

describe("health verdict pill — stated once, in the shared header", () => {
  it("renders exactly one verdict pill, and not inside the page", async () => {
    const main = await renderHealthRoute(FULL_HEALTH);
    const doc = main.ownerDocument;
    expect(doc.querySelectorAll("[data-verdict]")).toHaveLength(1);
    expect(main.querySelector("[data-verdict]")).toBeNull();
  });

  it("puts that one pill in the header, where it speaks for every route", async () => {
    const main = await renderHealthRoute(FULL_HEALTH);
    const pill = main.ownerDocument.querySelector("[data-verdict]");
    expect(pill?.closest(".app-brand")).not.toBeNull();
    expect(pill?.textContent).toBe("NEEDS ATTENTION");
  });
});

describe("CONTENTS strip — one divided panel, five columns", () => {
  it("renders exactly five columns inside one strip, not five cards", async () => {
    const main = await renderHealthRoute(FULL_HEALTH);
    expect(main.querySelectorAll(".contents-strip")).toHaveLength(1);
    expect(main.querySelectorAll(".contents-cell")).toHaveLength(5);
    expect(main.querySelectorAll(".stat-card")).toHaveLength(0);
  });

  it("renders the concepts, sources and saved-query figures from /api/health", async () => {
    const main = await renderHealthRoute(FULL_HEALTH);
    expect(figure(main, "concepts")).toBe("11");
    expect(figure(main, "sources")).toBe("19");
    expect(figure(main, "queries")).toBe("13");
  });

  it("names the compiled-source count and the page noun in the suffixes", async () => {
    const main = await renderHealthRoute(FULL_HEALTH);
    expect(suffix(main, "concepts")).toBe("pages");
    expect(suffix(main, "sources")).toBe("17 compiled");
  });

  it("renders the awaiting-review figure and its queue-clear suffix at zero", async () => {
    const main = await renderHealthRoute({ ...FULL_HEALTH, pendingReviews: 0 });
    expect(figure(main, "reviews")).toBe("—");
    expect(suffix(main, "reviews")).toBe("queue clear");
  });

  it("totals citations across pages and names how many resolve", async () => {
    const pages = pagesEnvelope([
      conceptPage("alpha", { citationCount: 5, unresolvedCitationCount: 2 }),
      conceptPage("beta", { citationCount: 4, unresolvedCitationCount: 0 }),
    ]);
    const main = await renderHealthRoute(FULL_HEALTH, pages);
    expect(figure(main, "citations")).toBe("9");
    expect(suffix(main, "citations")).toBe("7 cited");
  });
});

describe("CONTENTS strip — zero renders as a dim dash, not a bold 0", () => {
  it("renders a dash carrying the zero modifier for every empty count", async () => {
    const main = await renderHealthRoute({ concepts: 0, queries: 0, sourceFiles: 0, pendingReviews: 0 });
    for (const key of ["concepts", "sources", "citations", "queries", "reviews"]) {
      expect(figure(main, key), key).toBe("—");
      expect(main.querySelector(`[data-contents="${key}"] .contents-value`)?.className).toContain("is-zero");
    }
  });

  it("drops the zero modifier as soon as a count has something to report", async () => {
    const main = await renderHealthRoute({ ...FULL_HEALTH, queries: 0 });
    expect(main.querySelector('[data-contents="concepts"] .contents-value')?.className).not.toContain("is-zero");
    expect(suffix(main, "queries")).toBe("none yet");
  });
});

/** Build a /api/pages responder carrying a given stateStatus, plus /api/health. */
function pagesResponder(stateStatus: string): FetchResponder {
  return (url) => {
    if (url.endsWith("/api/pages")) return jsonResponse(pagesEnvelope([], { stateStatus }));
    if (url.endsWith("/api/health")) return jsonResponse({ stateStatus });
    return null;
  };
}

/** Mount the viewer with a given bootstrap stateStatus and return its document. */
async function mountWithStateStatus(stateStatus: string): Promise<Document> {
  const { dom } = await mountViewerDom(pagesResponder(stateStatus));
  await flushMicrotasks();
  return dom.window.document;
}

describe("state-status banner — corrupt and too-new", () => {
  it("renders the corrupt banner when stateStatus is corrupt", async () => {
    const banner = (await mountWithStateStatus("corrupt")).querySelector(".corrupt-state-banner");
    expect(banner).not.toBeNull();
    expect(banner?.textContent).toContain("corrupt");
  });

  it("renders the too-new banner when stateStatus is too-new", async () => {
    const banner = (await mountWithStateStatus("too-new")).querySelector(".corrupt-state-banner");
    expect(banner).not.toBeNull();
    expect(banner?.textContent).toContain("newer version of llmwiki");
  });

  it("renders no banner when stateStatus is ok", async () => {
    const doc = await mountWithStateStatus("ok");
    expect(doc.querySelector(".corrupt-state-banner")).toBeNull();
  });
});
