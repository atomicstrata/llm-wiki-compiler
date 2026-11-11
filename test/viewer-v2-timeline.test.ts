/**
 * The v2 timeline screen: generated day and week pages grouped into ISO weeks,
 * newest first, with each week's summary above its days; the empty state that
 * says how to turn the timeline on; and the recently updated list leaving the
 * generated pages to the timeline.
 */
import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { RecentView } from "../viewer-v2/src/recent-view.js";
import { isoWeek, timelineWeeks } from "../viewer-v2/src/timeline-model.js";
import { TimelineView } from "../viewer-v2/src/timeline-view.js";
import { envelope, page, text } from "./fixtures/viewer-v2-fixtures.js";

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
