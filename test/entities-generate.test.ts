/**
 * @file test/entities-generate.test.ts
 * @description Compile's entity step over in-memory steps: one page per record
 * plus the owner's hub, model calls only where inputs changed, the generated tail
 * refreshed without a call, hand-written pages left alone, and pages for records
 * that are gone removed.
 */

import { describe, expect, it } from "bun:test";
import { parseFrontmatter } from "../src/utils/markdown.js";
import { generateEntitiesWith } from "../src/entities/generate.js";
import { withAliases } from "../src/entities/pages.js";
import { entityConfig, memoryEntitySteps, type FakePerson } from "./entity-steps.js";

const CHAT = ["# Chat", "- 2026-05-04 09:00 Sam: Ana is coming", "- 2026-05-05 10:00 Ana: hi", "- 2026-05-05 10:01 Alex: hey"].join("\n");
const NOTE = "Alex Kim joined the team.";
const PEOPLE: Record<string, FakePerson[]> = {
  "chat.md": [{ name: "Ana", relationship: "friend", line: 2 }, { name: "Ana", line: 3 }, { name: "Alex", line: 4 }, { name: "Sam", line: 2 }],
  "note.md": [{ name: "Alex Kim", relationship: "family", line: 1 }],
};
const OWNER = { owner: { type: "person", names: ["Sam", "Sam Rivera"] }, entities: {} };

describe("entity pages", () => {
  it("writes a cited page per record with its agreed fields, and never one for the owner", async () => {
    const memory = memoryEntitySteps({ "chat.md": CHAT, "note.md": NOTE }, PEOPLE, OWNER);
    const result = await generateEntitiesWith(memory.steps, entityConfig());
    expect(result.errors).toEqual([]);
    expect([...memory.pages.keys()].sort()).toEqual(["person/alex", "person/alex-kim", "person/ana", "person/sam"]);
    const ana = parseFrontmatter(memory.pages.get("person/ana")!);
    expect(ana.meta).toMatchObject({ title: "Ana", relationship: "friend", sources: ["chat.md"], summary: "Ana is someone the owner knows." });
    expect(ana.body).toContain("- Mentioned. ^[chat.md:1-1]");
  });

  it("writes how the sources spelled a person as aliases", async () => {
    const memory = memoryEntitySteps({ "chat.md": CHAT }, { "chat.md": [{ name: "Ana Lee", writtenAs: ["Annna", "ana"], line: 2 }] }, OWNER);
    await generateEntitiesWith(memory.steps, entityConfig());
    expect(parseFrontmatter(memory.pages.get("person/ana-lee")!).meta.aliases).toEqual(["Annna", "ana"]);
  });

  it("refreshes a page's aliases without a model call when only the spellings change", async () => {
    const people: Record<string, FakePerson[]> = { "chat.md": [{ name: "Ana Lee", writtenAs: ["Annna"], line: 2 }] };
    const memory = memoryEntitySteps({ "chat.md": CHAT }, people, OWNER);
    await generateEntitiesWith(memory.steps, entityConfig());
    const before = memory.pages.get("person/ana-lee")!;
    expect(withAliases(before, ["Annna"])).toBe(before);
    people["chat.md"][0].writtenAs = ["Annna", "Ana L"];
    memory.state.cache = null;
    const requests = memory.pageRequests.length;
    await generateEntitiesWith(memory.steps, entityConfig());
    expect(memory.pageRequests.length).toBe(requests);
    expect(parseFrontmatter(memory.pages.get("person/ana-lee")!).meta.aliases).toEqual(["Annna", "Ana L"]);
    expect(parseFrontmatter(memory.pages.get("person/ana-lee")!).body).toBe(parseFrontmatter(before).body);
  });

  it("lists each record's days and flags possible duplicates without merging them", async () => {
    const memory = memoryEntitySteps({ "chat.md": CHAT, "note.md": NOTE }, PEOPLE, OWNER);
    await generateEntitiesWith(memory.steps, entityConfig());
    const ana = memory.pages.get("person/ana")!;
    expect(ana).toContain("## Days\n\n- [[timeline/2026-05-04|May 4, 2026]]\n- [[timeline/2026-05-05|May 5, 2026]]");
    expect(memory.pages.get("person/alex")).toContain("## Might be the same as\n\n- [[person/alex-kim|Alex Kim]]");
    expect(memory.pages.get("person/alex-kim")).not.toContain("## Days");
  });

  it("builds the owner's hub with no model call, grouped by relationship", async () => {
    const memory = memoryEntitySteps({ "chat.md": CHAT, "note.md": NOTE }, PEOPLE, OWNER);
    await generateEntitiesWith(memory.steps, entityConfig());
    const hub = parseFrontmatter(memory.pages.get("person/sam")!);
    expect(hub.meta).toMatchObject({ title: "Sam", aliases: ["Sam Rivera"] });
    expect(hub.body).toContain("## Friend\n\n- [[person/ana|Ana]] — Ana is someone the owner knows.");
    expect(hub.body).toContain("## Family\n\n- [[person/alex-kim|Alex Kim]]");
    expect(hub.body).toContain("## Not stated\n\n- [[person/alex|Alex]]");
    expect(memory.pageRequests.sort()).toEqual(["Alex", "Alex Kim", "Ana"]);
  });

  it("makes no model call and writes nothing when nothing changed", async () => {
    const memory = memoryEntitySteps({ "chat.md": CHAT, "note.md": NOTE }, PEOPLE, OWNER);
    await generateEntitiesWith(memory.steps, entityConfig());
    const [extractions, pageRequests, batches] = [memory.extractions.length, memory.pageRequests.length, memory.batches.length];
    const result = await generateEntitiesWith(memory.steps, entityConfig());
    expect([memory.extractions.length, memory.pageRequests.length, memory.batches.length]).toEqual([extractions, pageRequests, batches]);
    expect(result).toEqual({ extracted: 0, written: [], deleted: [], errors: [] });
  });

  it("re-reads only a changed source and rewrites only the pages it touches", async () => {
    const sources = { "chat.md": CHAT, "note.md": NOTE };
    const memory = memoryEntitySteps(sources, PEOPLE, OWNER);
    await generateEntitiesWith(memory.steps, entityConfig());
    memory.extractions.length = 0;
    memory.pageRequests.length = 0;
    sources["note.md"] = "Alex Kim left the team.";
    await generateEntitiesWith(memory.steps, entityConfig());
    expect(memory.extractions).toEqual(["note.md"]);
    expect(memory.pageRequests).toEqual(["Alex Kim"]);
  });
});

describe("entity pages over time", () => {
  it("refreshes the tail without a model call when only the days change", async () => {
    const memory = memoryEntitySteps({ "chat.md": CHAT, "note.md": NOTE }, PEOPLE, OWNER);
    await generateEntitiesWith(memory.steps, entityConfig({ timeZone: null }));
    expect(memory.pages.get("person/ana")).not.toContain("## Days");
    memory.pageRequests.length = 0;
    await generateEntitiesWith(memory.steps, entityConfig());
    expect(memory.pageRequests).toEqual([]);
    expect(memory.pages.get("person/ana")).toContain("## Days");
  });

  it("removes the page of a record no source names any more, and leaves hand-written pages alone", async () => {
    const sources: Record<string, string> = { "chat.md": CHAT, "note.md": NOTE };
    const memory = memoryEntitySteps(sources, PEOPLE, OWNER);
    memory.pages.set("person/ana", "---\ntitle: Ana\n---\n\nWritten by hand.\n");
    const first = await generateEntitiesWith(memory.steps, entityConfig());
    expect(first.errors).toEqual(["wiki/person/ana.md was not written by entity extraction; left as it is"]);
    delete sources["note.md"];
    const second = await generateEntitiesWith(memory.steps, entityConfig());
    expect(second.deleted).toEqual(["person/alex-kim"]);
    expect(memory.pages.get("person/ana")).toBe("---\ntitle: Ana\n---\n\nWritten by hand.\n");
  });

  it("reports a source whose extraction failed and leaves it out of the cache for the next compile", async () => {
    const memory = memoryEntitySteps({ "chat.md": CHAT, "note.md": NOTE }, PEOPLE, OWNER);
    const complete = memory.steps.complete;
    memory.steps.complete = async (request) => (request.messages[0].content.includes("note.md") && request.tools.length > 0 ? Promise.reject(new Error("down")) : complete(request));
    const result = await generateEntitiesWith(memory.steps, entityConfig());
    expect(result.errors).toEqual(["Records not read from note.md: down"]);
    expect(Object.keys(memory.state.cache!.sources)).toEqual(["chat.md"]);
    expect(memory.pages.has("person/alex-kim")).toBe(false);
  });

  it("does nothing when no type opts in", async () => {
    const memory = memoryEntitySteps({ "chat.md": CHAT }, PEOPLE);
    expect(await generateEntitiesWith(memory.steps, { types: [], timeZone: "UTC", concurrency: 1 })).toEqual({ extracted: 0, written: [], deleted: [], errors: [] });
    expect(memory.extractions).toEqual([]);
  });
});
