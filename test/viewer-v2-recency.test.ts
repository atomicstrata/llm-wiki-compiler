/**
 * Recency buckets and ages of the v2 viewer, against a frozen local clock.
 * Wednesday 2026-11-11 15:00 local time is "now" throughout.
 */
import { describe, expect, it } from "bun:test";
import { groupByRecency, recencyBucket, relativeAge, UNDATED } from "../viewer-v2/src/recency.js";

const NOW = new Date(2026, 10, 11, 15, 0);

/** A local timestamp `daysAgo` days before NOW, at the given hour. */
function daysAgo(days: number, hour = 12): string {
  return new Date(2026, 10, 11 - days, hour).toISOString();
}

describe("recencyBucket", () => {
  it("follows the calendar, not rolling windows", () => {
    expect(recencyBucket(daysAgo(0, 1), NOW)).toBe("Today");
    expect(recencyBucket(daysAgo(1, 23), NOW)).toBe("Yesterday");
    expect(recencyBucket(daysAgo(2), NOW)).toBe("Earlier this week");
    expect(recencyBucket(daysAgo(3), NOW)).toBe("Last week");
    expect(recencyBucket(daysAgo(9), NOW)).toBe("Last week");
    expect(recencyBucket(daysAgo(10), NOW)).toBe("Earlier this month");
    expect(recencyBucket(new Date(2026, 9, 31).toISOString(), NOW)).toBe("October 2026");
    expect(recencyBucket(new Date(2025, 11, 5).toISOString(), NOW)).toBe("December 2025");
  });

  it("puts missing and unparseable timestamps under Undated", () => {
    expect(recencyBucket("", NOW)).toBe(UNDATED);
    expect(recencyBucket("not a date", NOW)).toBe(UNDATED);
  });
});

describe("relativeAge", () => {
  it("names the largest whole unit", () => {
    expect(relativeAge(new Date(NOW.getTime() - 20_000).toISOString(), NOW)).toBe("moments");
    expect(relativeAge(new Date(NOW.getTime() - 20 * 60_000).toISOString(), NOW)).toBe("20 min");
    expect(relativeAge(new Date(NOW.getTime() - 3 * 3_600_000).toISOString(), NOW)).toBe("3 h");
    expect(relativeAge(daysAgo(2, 15), NOW)).toBe("2 d");
    expect(relativeAge("", NOW)).toBe("");
  });
});

describe("groupByRecency", () => {
  it("sorts newest first and keeps each bucket together with Undated last", () => {
    const pages = [
      { id: "old", updatedAt: daysAgo(40) },
      { id: "none", updatedAt: "" },
      { id: "today", updatedAt: daysAgo(0, 9) },
      { id: "today-late", updatedAt: daysAgo(0, 14) },
      { id: "yesterday", updatedAt: daysAgo(1) },
    ];
    const groups = groupByRecency(pages, (page) => page.updatedAt, NOW);
    expect(groups.map((group) => group.label)).toEqual(["Today", "Yesterday", "October 2026", UNDATED]);
    expect(groups[0].items.map((page) => page.id)).toEqual(["today-late", "today"]);
    expect(groups[3].items.map((page) => page.id)).toEqual(["none"]);
  });
});
