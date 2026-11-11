/** Derived facts of the v2 viewer: verdict, vocabulary, labels and totals. */
import { describe, expect, it } from "bun:test";
import type { HealthPayload, PagesEnvelope } from "../viewer-v2/src/api.js";
import { lintTotal, pagesIn, plural, profileVocabulary, typeLabel, wikiVerdict } from "../viewer-v2/src/wiki-model.js";
import { envelope, healthWith, page } from "./fixtures/viewer-v2-fixtures.js";

const CLEAN: HealthPayload = healthWith({ warnings: 0, errors: 0, at: "2026-11-11T00:00:00.000Z" });

describe("wikiVerdict", () => {
  it("reads all clear only when everything is measured and calm", () => {
    expect(wikiVerdict(envelope(), CLEAN)).toEqual({ text: "ALL CLEAR", tone: "ok" });
  });

  it("lets attention beat unmeasured, and names every unmeasured input", () => {
    const stale = envelope({ counts: { ...envelope().counts, stale: 2 }, stateStatus: "missing" });
    expect(wikiVerdict(stale, null)).toEqual({ text: "NEEDS ATTENTION", tone: "warn" });
    expect(wikiVerdict(envelope({ stateStatus: "missing" }), null)).toEqual({
      text: "FRESHNESS UNVERIFIED · LINT NEVER RUN", tone: "unknown",
    });
    expect(wikiVerdict(envelope(), healthWith({ warnings: 1, errors: 0, at: "" })).tone).toBe("warn");
  });
});

describe("profileVocabulary and labels", () => {
  it("is null on a default project and sums typed pages on a profile", () => {
    expect(profileVocabulary(envelope())).toBeNull();
    const profile: PagesEnvelope = envelope({
      profileId: "autosci",
      profilePipeline: { entityTypes: [{ type: "papers", directory: "wiki/papers", pageCount: 2 }] },
      pages: [page({ id: "papers/a", pageDirectory: "papers", citationCount: 3 }), page({ id: "concepts/b" })],
    });
    expect(profileVocabulary(profile)).toEqual({ typeCount: 1, pageCount: 2, citationCount: 3 });
  });

  it("spells type ids and plurals the way the sidebar does", () => {
    expect(typeLabel("instrument_calibrations")).toBe("Instrument calibrations");
    expect(plural(1, "page")).toBe("1 page");
    expect(plural(0, "citation")).toBe("0 citations");
    expect(lintTotal(null)).toBeNull();
    expect(lintTotal(CLEAN)).toBe(0);
  });
});

describe("pagesIn", () => {
  it("filters by directory and sorts newest first", () => {
    const wiki = envelope({ pages: [
      page({ id: "concepts/old", updatedAt: "2026-01-01T00:00:00Z" }),
      page({ id: "queries/q", pageDirectory: "queries" }),
      page({ id: "concepts/new", updatedAt: "2026-02-01T00:00:00Z" }),
    ] });
    expect(pagesIn(wiki, "concepts").map((row) => row.id)).toEqual(["concepts/new", "concepts/old"]);
  });
});
