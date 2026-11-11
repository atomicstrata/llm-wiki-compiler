/**
 * The v2 timeline screen: generated day and week pages grouped into ISO weeks,
 * newest first, with each week's summary above its days; the empty state that
 * says how to turn the timeline on; the recently updated list and the
 * dashboard's count leaving the generated pages to the timeline; the step
 * links on a timeline page; and the rail describing a day as a day.
 */
import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Dashboard } from "../viewer-v2/src/dashboard.js";
import { PageRail } from "../viewer-v2/src/page-rail.js";
import { RecentView } from "../viewer-v2/src/recent-view.js";
import { isoWeek, timelineLinks, timelineWeeks } from "../viewer-v2/src/timeline-model.js";
import { TimelineNav, TimelineView } from "../viewer-v2/src/timeline-view.js";
import { envelope, page, pagePayload, text } from "./fixtures/viewer-v2-fixtures.js";

const DAYS = [
  page({ id: "timeline/2026-05-04", title: "Monday, May 4, 2026", summary: "Planned the trip." }),
  page({ id: "timeline/2026-05-11", title: "Monday, May 11, 2026", summary: "Hired." }),
  page({ id: "timeline/2026-05-12", title: "Tuesday, May 12, 2026", summary: "Onboarded." }),
  page({ id: "timeline/2026-W20", title: "Week of May 11, 2026", summary: "A hiring week." }),
  page({ id: "timeline/notes", title: "Stray file" }),
  page({ id: "concepts/trip", title: "Trip" }),
];

describe("timelineWeeks", () => {
  it("groups day pages into ISO weeks, newest week and day first, and ignores anything else", () => {
    const weeks = timelineWeeks(DAYS);
    expect(weeks.map((week) => [week.week, week.page?.slug ?? null, week.days.map((day) => day.slug)])).toEqual([
      ["2026-W20", "2026-W20", ["2026-05-12", "2026-05-11"]],
      ["2026-W19", null, ["2026-05-04"]],
    ]);
    expect([isoWeek("2027-01-01"), isoWeek("2026-12-28")]).toEqual(["2026-W53", "2026-W53"]);
  });
});

describe("TimelineView", () => {
  it("shows each week's summary above its days, linking to the pages", () => {
    const html = renderToStaticMarkup(createElement(TimelineView, { wiki: envelope({ pages: DAYS }) }));
    expect(text(html)).toMatch(/^Timeline 3 days across 2 weeks, newest first Week of May 11, 2026 A hiring week\. Tuesday, May 12, 2026 Onboarded\./);
    expect(html).toContain('href="#/timeline/2026-W20"');
    expect(html).toContain('href="#/timeline/2026-05-04"');
    expect(text(html)).toContain("2026-W19 Monday, May 4, 2026 Planned the trip.");
  });

  it("says how to turn the timeline on when there are no timeline pages", () => {
    const html = text(renderToStaticMarkup(createElement(TimelineView, { wiki: envelope({ pages: [page()] }) })));
    expect(html).toContain("No timeline yet");
    expect(html).toContain('"timeline": { "enabled": true }');
  });
});

describe("RecentView", () => {
  it("leaves the generated day and week pages to the timeline", () => {
    const html = text(renderToStaticMarkup(createElement(RecentView, { wiki: envelope({ pages: DAYS }) })));
    expect(html).toContain("Recently updated 1 page, newest first");
    expect(html).not.toContain("Monday, May 4");
  });
});

describe("stepping through time", () => {
  it("links a day to the days around it and its week, and a week to its days", () => {
    const day = timelineLinks(DAYS, "2026-05-11");
    expect([day.previous?.slug, day.next?.slug, day.week?.slug, day.days]).toEqual(["2026-05-04", "2026-05-12", "2026-W20", []]);
    const week = timelineLinks(DAYS, "2026-W20");
    expect([week.previous, week.next, week.days.map((row) => row.slug)]).toEqual([null, null, ["2026-05-11", "2026-05-12"]]);
    expect(timelineLinks(DAYS, "2026-05-04").week).toBeNull();
  });

  it("shows the step links, and the Timeline when a day has no week page", () => {
    const html = text(renderToStaticMarkup(createElement(TimelineNav, { slug: "2026-05-04", wiki: envelope({ pages: DAYS }) })));
    expect(html).toBe("Timeline Monday, May 11 →");
    const week = renderToStaticMarkup(createElement(TimelineNav, { slug: "2026-W20", wiki: envelope({ pages: DAYS }) }));
    expect(text(week)).toContain("Days Monday Tuesday");
    expect(week).toContain('href="#/timeline/2026-05-12"');
  });

  it("calls a timeline page a day or a week, and leaves out freshness", () => {
    const rail = (slug: string) => text(renderToStaticMarkup(createElement(PageRail, { page: pagePayload({ id: `timeline/${slug}` }), wiki: envelope({ pages: DAYS }) })));
    expect(rail("2026-05-04")).toMatch(/Kind day/);
    expect(rail("2026-W20")).toMatch(/Kind week/);
    expect(rail("2026-05-04")).not.toContain("Freshness");
    // Controls: a concept page keeps freshness, and a stray file in the directory is not a day.
    const concept = text(renderToStaticMarkup(createElement(PageRail, { page: pagePayload(), wiki: envelope({ pages: DAYS }) })));
    expect(concept).toMatch(/Kind concept Freshness fresh/);
    expect(rail("notes")).toContain("Freshness");
  });

  it("counts only knowledge pages on the dashboard", () => {
    expect(text(renderToStaticMarkup(createElement(Dashboard, { wiki: envelope({ pages: DAYS }), health: null })))).toContain("All 1 page →");
  });
});

