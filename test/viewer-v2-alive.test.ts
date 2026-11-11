/**
 * The v2 live dashboard and its neighbours: visit stamps and what changed
 * since, the activity calendar, tag counts and the topic map, the tag route
 * and list, the cited-by list, and the signature that decides whether a
 * background refresh re-renders.
 */
import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { changedSince, dailyActivity, heatLevel, stampVisit, tagCounts, tagWeight } from "../viewer-v2/src/activity-model.js";
import { CitedByList } from "../viewer-v2/src/cited-by.js";
import { rangeLabel } from "../viewer-v2/src/page-model.js";
import { ActivityCard, SinceLastVisit, TopicsCard } from "../viewer-v2/src/dashboard-panels.js";
import { bootstrapSignature, nextBootstrapState } from "../viewer-v2/src/live-bootstrap.js";
import { TagList } from "../viewer-v2/src/lists.js";
import { parseRoute, tagHref } from "../viewer-v2/src/route.js";
import { envelope, healthWith, memoryStore, page, text } from "./fixtures/viewer-v2-fixtures.js";

const PAGES = [
  page({ id: "concepts/a", title: "A", updatedAt: "2026-11-09T10:00:00.000Z", tags: ["kiln", "glaze"] }),
  page({ id: "concepts/b", title: "B", updatedAt: "2026-11-10T09:00:00.000Z", tags: ["kiln"] }),
  page({ id: "concepts/c", title: "C", updatedAt: "2026-11-01T09:00:00.000Z", tags: ["kiln", "kiln"] }),
];

describe("visits", () => {
  it("ends a visit after half an hour without activity, and counts new from the last activity before it", () => {
    const store = memoryStore();
    expect(stampVisit(store, new Date("2026-11-09T08:00:00Z"))).toBeNull();
    expect(stampVisit(store, new Date("2026-11-09T08:10:00Z"))).toBeNull();
    expect(stampVisit(store, new Date("2026-11-10T08:00:00Z"))).toBe("2026-11-09T08:10:00.000Z");
    expect(stampVisit(store, new Date("2026-11-10T08:05:00Z"))).toBe("2026-11-09T08:10:00.000Z");
    expect(stampVisit(undefined, new Date())).toBeNull();
  });

  it("keeps a reader who stays active in one visit, however long it runs", () => {
    const store = memoryStore();
    stampVisit(store, new Date("2026-11-09T07:00:00Z"));
    stampVisit(store, new Date("2026-11-10T08:00:00Z"));
    for (const minute of [20, 40, 60, 80]) {
      expect(stampVisit(store, new Date(Date.UTC(2026, 10, 10, 8, minute)))).toBe("2026-11-09T07:00:00.000Z");
    }
  });

  it("lists pages changed since a time, newest first", () => {
    expect(changedSince(PAGES, "2026-11-05T00:00:00Z").map((row) => row.id)).toEqual(["concepts/b", "concepts/a"]);
  });
});

describe("activity", () => {
  it("counts updates per local day over whole weeks ending this week", () => {
    const days = dailyActivity(PAGES, new Date(2026, 10, 10, 12), 2);
    expect(days).toHaveLength(14);
    expect(new Date(`${days[0].date}T12:00:00`).getDay()).toBe(0);
    expect(days.reduce((sum, day) => sum + day.count, 0)).toBe(3);
  });

  it("shades counts against the busiest day", () => {
    expect([0, 1, 2, 4].map((count) => heatLevel(count, 4))).toEqual([0, 1, 2, 4]);
    expect(heatLevel(3, 0)).toBe(0);
  });
});

describe("topics", () => {
  it("counts each tag once per page and orders by use, then name", () => {
    expect(tagCounts(PAGES, 5)).toEqual([{ tag: "kiln", count: 3 }, { tag: "glaze", count: 1 }]);
    expect([0, 1, 3, 4].map((count) => tagWeight(count, 4))).toEqual([0, 1, 3, 3]);
  });

  it("draws tags as links to their pages, and says when there are none", () => {
    const html = renderToStaticMarkup(createElement(TopicsCard, { pages: PAGES }));
    expect(html).toContain(`href="${tagHref("kiln")}"`);
    expect(text(html)).toContain("kiln 3 glaze 1");
    expect(text(renderToStaticMarkup(createElement(TopicsCard, { pages: [page()] })))).toContain("No page carries a tag yet.");
  });
});

describe("dashboard panels", () => {
  it("hides the since-last-visit panel on a first visit and lists changes after one", () => {
    expect(renderToStaticMarkup(createElement(SinceLastVisit, { pages: PAGES, since: null }))).toBe("");
    expect(text(renderToStaticMarkup(createElement(SinceLastVisit, { pages: PAGES, since: "2026-11-05T00:00:00Z" })))).toMatch(/^2 pages changed since your last visit on/);
  });

  it("labels the activity calendar for screen readers", () => {
    expect(renderToStaticMarkup(createElement(ActivityCard, { pages: PAGES }))).toMatch(/role="img" aria-label="\d+ pages? updated in the last 16 weeks/);
  });
});

describe("tags and citations", () => {
  it("routes a tag and lists only its pages", () => {
    expect(parseRoute(tagHref("open source"))).toEqual({ view: "tag", tag: "open source" });
    const html = text(renderToStaticMarkup(createElement(TagList, { wiki: envelope({ pages: PAGES }), tag: "glaze" })));
    expect(html).toContain("#glaze 1 page");
    expect(html).not.toContain(" B ");
  });

  it("labels cited ranges and lists citing pages with links back to the lines", () => {
    expect([rangeLabel(null), rangeLabel({ start: 4, end: 4 }), rangeLabel({ start: 4, end: 9 })]).toEqual(["whole file", "L4", "L4–9"]);
    const payload = { source: "notes.md", pages: [{ id: "concepts/a", title: "A", spans: [{ start: 2, end: 3 }] }] };
    const html = renderToStaticMarkup(createElement(CitedByList, { payload }));
    expect(html).toContain('href="#/_source/notes.md?start=2&amp;end=3"');
    expect(text(renderToStaticMarkup(createElement(CitedByList, { payload: { source: "x.md", pages: [] } })))).toBe("No page cites this source yet.");
  });
});

describe("live refresh", () => {
  it("changes signature only when something shown would change", () => {
    const base = { wiki: envelope({ pages: PAGES }), health: healthWith(null) };
    const same = { wiki: envelope({ pages: [...PAGES], updatedAt: "2099-01-01T00:00:00.000Z" }), health: healthWith(null) };
    expect(bootstrapSignature(same)).toBe(bootstrapSignature(base));
    expect(bootstrapSignature({ ...base, wiki: envelope({ pages: PAGES.slice(1) }) })).not.toBe(bootstrapSignature(base));
    expect(bootstrapSignature({ ...base, health: healthWith(null, { pendingReviews: 2 }) })).not.toBe(bootstrapSignature(base));
  });

  it("keeps the same state for an unchanged reload, and recovers from a failed first load", () => {
    const base = { wiki: envelope({ pages: PAGES }), health: healthWith(null) };
    const ready = nextBootstrapState({ status: "loading" }, base);
    expect(ready).toEqual({ status: "ready", data: base });
    expect(nextBootstrapState(ready, { ...base, wiki: envelope({ pages: [...PAGES] }) })).toBe(ready);
    expect(nextBootstrapState({ status: "error", message: "down" }, base)).toEqual({ status: "ready", data: base });
  });
});
