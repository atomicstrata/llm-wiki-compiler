/**
 * The timeline step over in-memory steps: which pages it writes on a first
 * compile, that a second compile with nothing changed writes nothing, that an
 * edited source rewrites only its days and their week, that a failed day holds
 * its week back, that periods without sources are removed, and that daily
 * prompts show each line under its original number.
 */
import { describe, expect, it } from "bun:test";
import { parseFrontmatter } from "../src/utils/markdown.js";
import type { CompilePageWrite } from "../src/compiler/compile-write.js";
import { generateTimelineWith, type TimelineSteps } from "../src/timeline/generate.js";
import { dayExcerpt, splitAnswer, type TimelineRequest } from "../src/timeline/prompts.js";
import { dayBuckets } from "../src/timeline/buckets.js";
import { citationsOutside, withRelated } from "../src/timeline/pages.js";

const CONFIG = { enabled: true, timeZone: "UTC" };
const CHAT = ["# Chat", "- 2026-05-04 09:00 A: plan the trip", "- 2026-05-05 10:00 B: booked it"].join("\n");
const NOTE = "Decided to hire.";

/** A citation of the first line a prompt shows, or the first citation a weekly prompt carries. */
function firstCitation(prompt: string): string {
  const line = /--- SOURCE: (\S+) ---\n\n\s*(\d+) \|/.exec(prompt);
  return line ? `^[${line[1]}:${line[2]}-${line[2]}]` : /\^\[[^\]]+\]/.exec(prompt)![0];
}

/** In-memory sources, pages and model; records every request and write. */
function memorySteps(sources: Record<string, string>, failOn: string[] = []) {
  const pages = new Map<string, string>();
  const requests: TimelineRequest[] = [];
  const batches: CompilePageWrite[][] = [];
  const steps: TimelineSteps = {
    listSources: async () => Object.entries(sources).map(([file, text]) => ({ file, hash: `h:${text.length}:${text}` })),
    readSource: async (file) => sources[file],
    listTimelineSlugs: async () => [...pages.keys()],
    readTimelinePage: async (slug) => pages.get(slug) ?? "",
    listConceptPages: async () => [{ slug: "trip", title: "Trip", body: "Booked. ^[chat.md:3-3]" }],
    complete: async (request) => {
      requests.push(request);
      const period = /for (\S+)\.$/.exec(request.messages[0].content)![1];
      if (failOn.includes(period)) throw new Error("provider down");
      return `SUMMARY: About ${period}.\nWhat happened on ${period}. ${firstCitation(request.messages[0].content)}`;
    },
    writePages: async (writes) => {
      batches.push(writes);
      for (const write of writes) write.deleting ? pages.delete(write.slug) : pages.set(write.slug, write.body);
      return { skipped: [] };
    },
    provenance: () => ({ modelId: "test-model" }),
    now: () => "2026-05-10T00:00:00.000Z",
  };
  return { steps, pages, requests, batches, sources };
}

describe("generateTimelineWith", () => {
  it("writes a page per day and per week, then nothing when nothing changed", async () => {
    const memory = memorySteps({ "chat.md": CHAT, "2026-05-11-standup.md": NOTE });
    const first = await generateTimelineWith(memory.steps, CONFIG, 2);
    expect(first.written.sort()).toEqual(["2026-05-04", "2026-05-05", "2026-05-11", "2026-W19", "2026-W20"]);
    expect(first.errors).toEqual([]);
    const again = await generateTimelineWith(memory.steps, CONFIG, 2);
    expect([again.written, memory.requests.length]).toEqual([[], 5]);
  });

  it("records what each page covers, keeps creation time, and links the day to concept pages citing its lines", async () => {
    const memory = memorySteps({ "chat.md": CHAT });
    await generateTimelineWith(memory.steps, CONFIG, 1);
    const { meta, body } = parseFrontmatter(memory.pages.get("2026-05-05")!);
    expect(meta).toMatchObject({ title: "Tuesday, May 5, 2026", summary: "About 2026-05-05.", timeline: "daily", date: "2026-05-05", sources: ["chat.md"], modelId: "test-model" });
    expect(body).toContain("## Pages from this day\n\n- [[trip|Trip]]");
    expect(memory.pages.get("2026-05-04")).not.toContain("[[trip|Trip]]");
    expect(parseFrontmatter(memory.pages.get("2026-W19")!).meta).toMatchObject({ title: "Week of May 4, 2026", timeline: "weekly", week: "2026-W19" });
  });

  it("rewrites only the edited source's days and their week", async () => {
    const memory = memorySteps({ "chat.md": CHAT, "2026-05-11-standup.md": NOTE });
    await generateTimelineWith(memory.steps, CONFIG, 1);
    memory.sources["2026-05-11-standup.md"] = "Decided to hire two.";
    const result = await generateTimelineWith(memory.steps, CONFIG, 1);
    expect(result.written.sort()).toEqual(["2026-05-11", "2026-W20"]);
  });

  it("holds a week back while one of its days failed, and builds it once the day succeeds", async () => {
    const memory = memorySteps({ "chat.md": CHAT }, ["2026-05-05"]);
    const failed = await generateTimelineWith(memory.steps, CONFIG, 1);
    expect([failed.written, failed.errors]).toEqual([["2026-05-04"], ['Timeline page "2026-05-05" failed: provider down']]);
    memory.steps.complete = memorySteps({}).steps.complete;
    const retried = await generateTimelineWith(memory.steps, CONFIG, 1);
    expect(retried.written.sort()).toEqual(["2026-05-05", "2026-W19"]);
  });

  it("removes the pages of days and weeks no source covers any more", async () => {
    const memory = memorySteps({ "chat.md": CHAT, "2026-05-11-standup.md": NOTE });
    await generateTimelineWith(memory.steps, CONFIG, 1);
    delete memory.sources["2026-05-11-standup.md"];
    const result = await generateTimelineWith(memory.steps, CONFIG, 1);
    expect([result.deleted.sort(), [...memory.pages.keys()].sort()]).toEqual([["2026-05-11", "2026-W20"], ["2026-05-04", "2026-05-05", "2026-W19"]]);
  });

  it("keeps a day's related pages current without asking the model, and never touches hand-written files", async () => {
    const memory = memorySteps({ "chat.md": CHAT });
    memory.pages.set("README", "---\ntitle: Notes\n---\n\nMine.\n");
    await generateTimelineWith(memory.steps, CONFIG, 1);
    const calls = memory.requests.length;
    memory.steps.listConceptPages = async () => [{ slug: "trip-plan", title: "Trip plan", body: "Planned. ^[chat.md:2-2]" }];
    const result = await generateTimelineWith(memory.steps, CONFIG, 1);
    expect([result.written.sort(), memory.requests.length, result.deleted]).toEqual([["2026-05-04", "2026-05-05"], calls, []]);
    expect(memory.pages.get("2026-05-04")).toContain("- [[trip-plan|Trip plan]]");
    expect(memory.pages.get("2026-05-05")).not.toContain("Pages from this day");
    expect(memory.pages.get("README")).toBe("---\ntitle: Notes\n---\n\nMine.\n");
  });

  it("reports a page that cites lines it was not shown, and still writes it", async () => {
    const memory = memorySteps({ "chat.md": CHAT });
    memory.steps.complete = async (request) => `SUMMARY: x.\nMade up. ^[chat.md:3-3] ^[other.md:1-1]`.replace("^[chat.md:3-3]", request.messages[0].content.includes("2026-05-05") ? "" : "^[chat.md:3-3]");
    const result = await generateTimelineWith(memory.steps, CONFIG, 1);
    expect(result.errors).toContain('Timeline page "2026-05-04" cites 2 spans outside the lines it was written from');
    expect(memory.pages.has("2026-05-04")).toBe(true);
  });

  it("leaves a hand-written file at a day's name alone, and says so", async () => {
    const memory = memorySteps({ "chat.md": CHAT });
    const mine = "---\ntitle: My notes\n---\n\nMine.\n";
    memory.pages.set("2026-05-04", mine);
    const result = await generateTimelineWith(memory.steps, CONFIG, 1);
    expect(memory.pages.get("2026-05-04")).toBe(mine);
    expect(result.errors).toContain("wiki/timeline/2026-05-04.md was not written by the timeline; left as it is");
    expect(result.errors).toContain('Timeline week "2026-W19" not written: one of its days is a hand-written page');
    expect(result.written).toEqual(["2026-05-05"]);
  });

  it("keeps the model's own text when refreshing related pages, even under a look-alike heading", async () => {
    const memory = memorySteps({ "chat.md": CHAT });
    memory.steps.complete = async () => "SUMMARY: x.\nTop. ^[chat.md:2-2]\n\n## Pages from this day\n\nKept. ^[chat.md:2-2]";
    await generateTimelineWith(memory.steps, CONFIG, 1);
    memory.steps.listConceptPages = async () => [{ slug: "trip-plan", title: "Trip plan", body: "^[chat.md:2-2]" }];
    await generateTimelineWith(memory.steps, CONFIG, 1);
    const day = memory.pages.get("2026-05-04")!;
    expect(day).toContain("Kept. ^[chat.md:2-2]");
    expect(day.trimEnd().endsWith("- [[trip-plan|Trip plan]]")).toBe(true);
  });

  it("hides its section marker from readers and rewrites a page that used the old HTML-comment marker once", () => {
    const old = "---\ntitle: Day\n---\n\nBody.\n\n<!-- llmwiki:timeline-related -->\n## Pages from this day\n\n- [[a|A]]\n";
    const fresh = withRelated(old, [{ slug: "b", title: "B", body: "" }]);
    expect(fresh).toBe("---\ntitle: Day\n---\n\nBody.\n\n[//]: # (llmwiki-timeline-related)\n## Pages from this day\n\n- [[b|B]]\n");
    expect(withRelated(fresh, [{ slug: "b", title: "B", body: "" }])).toBe(fresh);
  });

  it("does nothing at all when the timeline is off", async () => {
    const memory = memorySteps({ "chat.md": CHAT });
    expect(await generateTimelineWith(memory.steps, { ...CONFIG, enabled: false }, 1)).toEqual({ written: [], deleted: [], errors: [] });
    expect(memory.batches).toEqual([]);
  });
});

describe("timeline prompts", () => {
  it("cuts a day past the excerpt budget at a line, and says how much was cut", () => {
    const long = Array.from({ length: 3000 }, (_, index) => `- 2026-05-0${index < 2999 ? 4 : 5} 09:00 ${"x".repeat(40)}`).join("\n");
    const [day] = dayBuckets([{ file: "big.md", hash: "h", text: long }], "UTC");
    const excerpt = dayExcerpt(day, new Map([["big.md", long]])).text;
    expect(excerpt.length).toBeLessThan(61_000);
    expect(excerpt).toMatch(/^--- SOURCE: big\.md ---\n\n {3}1 \| /);
    expect(excerpt).toMatch(/\(\d+ more lines from this day not shown: over the excerpt budget\. Do not cite them\.\)$/);
  });

  it("shares the budget so a long chat cannot crowd out a short note, and reports the lines it did not show", () => {
    const chat = Array.from({ length: 3000 }, (_, index) => `- 2026-05-04 09:${String(index % 60).padStart(2, "0")} ${"x".repeat(40)}`).join("\n");
    const note = "---\ndate: 2026-05-04\n---\nDecided to hire.";
    const [day] = dayBuckets([{ file: "a-chat.md", hash: "1", text: chat }, { file: "b-note.md", hash: "2", text: note }], "UTC");
    const { text, shown } = dayExcerpt(day, new Map([["a-chat.md", chat], ["b-note.md", note]]));
    expect(text).toContain("--- SOURCE: b-note.md ---\n\n4 | Decided to hire.");
    expect(shown.sources.find((source) => source.file === "b-note.md")!.ranges).toEqual([{ start: 4, end: 4 }]);
    expect(citationsOutside("Late. ^[a-chat.md:2999-2999]", [shown])).toBe(1);
  });

  it("shows a day's lines under their original numbers, ranges apart", () => {
    const [, second] = dayBuckets([{ file: "chat.md", hash: "h", text: CHAT }], "UTC");
    expect(dayExcerpt(second, new Map([["chat.md", CHAT]])).text).toBe("--- SOURCE: chat.md ---\n\n3 | - 2026-05-05 10:00 B: booked it");
  });

  it("splits the summary line from the body, and keeps an answer without one whole", () => {
    expect(splitAnswer("SUMMARY: A day.\n\nBody ^[a.md:1-2]")).toEqual({ summary: "A day.", body: "Body ^[a.md:1-2]" });
    expect(splitAnswer("Just a body.")).toEqual({ summary: "", body: "Just a body." });
  });
});
