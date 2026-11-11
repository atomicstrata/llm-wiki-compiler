/**
 * The timeline's pure date logic: which days a source's lines belong to (per
 * stamped line for multi-day exports, whole file otherwise), day and ISO-week
 * bucketing, and the signatures that keep regeneration incremental.
 */
import { describe, expect, it } from "bun:test";
import { dayBuckets, isoWeek, weekBuckets, weekStart } from "../src/timeline/buckets.js";
import { sourceDayRanges } from "../src/timeline/event-days.js";

const ZONE = "America/New_York";

const CHAT = [
  "---", "source: chat", "created_at: \"2026-05-04T12:33:02-04:00\"", "---", // 1-4
  "# Texts", "", "## Transcript", // 5-7
  "- 2026-05-04 12:33 A: hi", // 8
  "- 2026-05-04 23:59 B: a long message", // 9
  "  that wraps onto a second line", // 10
  "- 2026-05-05 08:00 A: morning", // 11
  "- 2026-05-07 09:00 B: later", // 12
  "", "", // 13-14
].join("\n");

describe("sourceDayRanges", () => {
  it("splits a multi-day export by its stamped lines, keeping wrapped lines with their entry", () => {
    expect(Object.fromEntries(sourceDayRanges("chat.md", CHAT, ZONE))).toEqual({
      "2026-05-04": [{ start: 8, end: 10 }],
      "2026-05-05": [{ start: 11, end: 11 }],
      "2026-05-07": [{ start: 12, end: 12 }],
    });
  });

  it("converts stamps with an offset into the configured zone, and takes plain stamps as written", () => {
    const text = ["- 2026-05-05T02:00:00Z A: late", "- 2026-05-05 02:00 B: local"].join("\n");
    expect([...sourceDayRanges("x.md", text, ZONE).keys()]).toEqual(["2026-05-04", "2026-05-05"]);
  });

  it("dates a single-day file by frontmatter date, then created_at, then its filename", () => {
    const note = (meta: string) => ["---", meta, "---", "Body line", ""].join("\n");
    expect(Object.fromEntries(sourceDayRanges("n.md", note("date: 2026-01-02"), ZONE))).toEqual({ "2026-01-02": [{ start: 4, end: 4 }] });
    expect([...sourceDayRanges("n.md", note("created_at: 2026-01-03T01:00:00Z"), ZONE).keys()]).toEqual(["2026-01-02"]);
    expect([...sourceDayRanges("2026-02-09-standup.md", note("source: x"), ZONE).keys()]).toEqual(["2026-02-09"]);
  });

  it("treats stamps that all fall on one day as a whole-file source", () => {
    const text = ["---", "date: 2026-03-01", "---", "Notes", "- 2026-03-01 10:00 a"].join("\n");
    expect(Object.fromEntries(sourceDayRanges("m.md", text, ZONE))).toEqual({ "2026-03-01": [{ start: 4, end: 5 }] });
  });

  it("ignores dates that are not real days, and reads offsets written without a colon", () => {
    const text = ["- 0000-00-00 00:00 placeholder", "- 2026-02-30 10:00 typo", "- 2026-05-05T02:00:00-0400 a", "- 2026-05-06 09:00 b"].join("\n");
    expect([...sourceDayRanges("x.md", text, "UTC").keys()]).toEqual(["2026-05-05", "2026-05-06"]);
    expect(sourceDayRanges("2026-13-01-x.md", "Body", ZONE).size).toBe(0);
  });

  it("keeps a note in one piece when a few dated lines are not most of it, or sit in code", () => {
    const plan = ["---", "date: 2026-03-01", "---", "Plan for spring", "Context line", "More context", "- 2026-04-01 10:00 kickoff", "- 2026-05-01 10:00 review"].join("\n");
    expect([...sourceDayRanges("plan.md", plan, ZONE).keys()]).toEqual(["2026-03-01"]);
    const fenced = ["---", "date: 2026-03-01", "---", "```", "2026-04-01 10:00 log", "2026-04-02 10:00 log", "```"].join("\n");
    expect([...sourceDayRanges("log.md", fenced, ZONE).keys()]).toEqual(["2026-03-01"]);
  });

  it("dates a one-day chat with no other date by its stamps, and reads a date past a comment", () => {
    expect(Object.fromEntries(sourceDayRanges("chat.md", "- 2026-05-04 09:00 a\n- 2026-05-04 10:00 b", ZONE))).toEqual({ "2026-05-04": [{ start: 1, end: 2 }] });
    expect([...sourceDayRanges("n.md", "---\ndate: 2026-01-02 # the call\n---\nBody", ZONE).keys()]).toEqual(["2026-01-02"]);
  });

  it("splits a chat of wrapped messages by line, dated or not, and keeps a short dated chat with two stamps whole", () => {
    const wrapped = ["# Chat", "- 2026-05-04 09:00 A: first line", "second line", "third line", "- 2026-05-05 09:00 B: reply", "more", "more"].join("\n");
    expect(Object.fromEntries(sourceDayRanges("chat.md", wrapped, ZONE))).toEqual({ "2026-05-04": [{ start: 2, end: 4 }], "2026-05-05": [{ start: 5, end: 7 }] });
    const dated = `---\ncreated_at: 2026-05-04\n---\n${["- 2026-05-04 09:00 a", "- 2026-05-04 10:00 b", "- 2026-05-05 09:00 c"].join("\n")}`;
    expect([...sourceDayRanges("chat.md", dated, ZONE).keys()]).toEqual(["2026-05-04", "2026-05-05"]);
  });

  it("splits a newest-first export with a header date by line", () => {
    const text = ["---", "date: 2026-05-07", "---", "- 2026-05-07 09:00 c", "- 2026-05-05 09:00 b", "- 2026-05-04 09:00 a"].join("\n");
    expect([...sourceDayRanges("2026-05-07-chat.md", text, ZONE).keys()].sort()).toEqual(["2026-05-04", "2026-05-05", "2026-05-07"]);
  });

  it("reads stamps past a code fence that never closes", () => {
    const text = ["```", "- 2026-05-04 09:00 a", "- 2026-05-05 09:00 b"].join("\n");
    expect([...sourceDayRanges("log.md", text, ZONE).keys()]).toEqual(["2026-05-04", "2026-05-05"]);
  });

  it("leaves an undated or empty source off the timeline", () => {
    expect(sourceDayRanges("notes.md", "just text", ZONE).size).toBe(0);
    expect(sourceDayRanges("2026-01-01-empty.md", "---\ndate: 2026-01-01\n---\n\n", ZONE).size).toBe(0);
  });
});

describe("buckets", () => {
  const sources = [
    { file: "chat.md", hash: "h1", text: CHAT },
    { file: "2026-05-05-meeting.md", hash: "h2", text: "Met about the plan." },
  ];

  it("merges sources per day in filename order, oldest day first", () => {
    const days = dayBuckets(sources, ZONE);
    expect(days.map((day) => day.day)).toEqual(["2026-05-04", "2026-05-05", "2026-05-07"]);
    expect(days[1].sources.map((source) => source.file)).toEqual(["2026-05-05-meeting.md", "chat.md"]);
  });

  it("changes a day's signature only when its own inputs change, and the week's with it", () => {
    const before = dayBuckets(sources, ZONE);
    const after = dayBuckets([sources[0], { ...sources[1], hash: "h2b" }], ZONE);
    expect(after[0].signature).toBe(before[0].signature);
    expect(after[1].signature).not.toBe(before[1].signature);
    expect(weekBuckets(after)[0].signature).not.toBe(weekBuckets(before)[0].signature);
  });

  it("numbers ISO weeks across year boundaries, starting on Monday", () => {
    expect(["2026-05-04", "2026-05-10", "2026-05-11", "2027-01-01", "2026-12-31"].map(isoWeek))
      .toEqual(["2026-W19", "2026-W19", "2026-W20", "2026-W53", "2026-W53"]);
    expect(weekStart("2026-W19")).toBe("2026-05-04");
    expect(weekStart("2026-W53")).toBe("2026-12-28");
  });
});
