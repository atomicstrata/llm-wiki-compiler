/**
 * @file test/entities-safety.test.ts
 * @description The entity step under failure and edge cases: a failed read keeps
 * its pages, a page that cannot pass the field contract costs no model call,
 * names that make the same slug stay separate records, the owner page's id is
 * its own, ids fit a filename, and a source that grows re-reads only its
 * changed chunk.
 */

import { describe, expect, it } from "bun:test";
import { parseFrontmatter } from "../src/utils/markdown.js";
import type { ProfilePack } from "../src/profile/types.js";
import { generateEntitiesWith } from "../src/entities/generate.js";
import { ownerPageId, parseRegistry, recordId, resolveRecords } from "../src/entities/identity.js";
import { CHAT, entityConfig, memoryEntitySteps, mention, personProfile, type FakePerson } from "./entity-steps.js";

const PEOPLE: Record<string, FakePerson[]> = { "chat.md": [{ name: "Ana", relationship: "friend", line: 2 }, { name: "Alex", line: 4 }] };

describe("entity pages when things go wrong", () => {
  it("keeps every page when extraction fails, and retries the source next time", async () => {
    const memory = memoryEntitySteps({ "chat.md": CHAT }, PEOPLE);
    await generateEntitiesWith(memory.steps, entityConfig());
    const widened = personProfile();
    widened.entities.person.fields!.role = { type: "string" };
    memory.steps.complete = async () => { throw new Error("rate limited"); };
    const result = await generateEntitiesWith(memory.steps, entityConfig({ profile: widened }));
    expect(result.deleted).toEqual([]);
    expect([...memory.pages.keys()].sort()).toEqual(["person/alex", "person/ana"]);
    expect(memory.state.cache!.sources["chat.md"].hash).toBe("");
  });

  it("makes no model call for a page that cannot pass the field contract, on any compile", async () => {
    const strict = personProfile();
    strict.entities.person.requiredFields = ["relationship"];
    const memory = memoryEntitySteps({ "chat.md": CHAT }, PEOPLE);
    const first = await generateEntitiesWith(memory.steps, entityConfig({ profile: strict }));
    expect(first.errors).toEqual([expect.stringContaining('Page "person/alex" not written: Required field "relationship"')]);
    await generateEntitiesWith(memory.steps, entityConfig({ profile: strict }));
    expect(memory.pageRequests).toEqual(["Ana"]);
  });

  it("writes the name under the type's own title field", async () => {
    const named = personProfile();
    named.entities.person.titleField = "fullName";
    named.entities.person.fields!.fullName = { type: "string", required: true };
    const memory = memoryEntitySteps({ "chat.md": CHAT }, PEOPLE);
    expect((await generateEntitiesWith(memory.steps, entityConfig({ profile: named }))).errors).toEqual([]);
    expect(parseFrontmatter(memory.pages.get("person/ana")!).meta).toMatchObject({ title: "Ana", fullName: "Ana" });
  });
});

describe("the alias registry's exclude list", () => {
  it("reports an exclude key that names no extracted type", async () => {
    const memory = memoryEntitySteps({ "chat.md": CHAT }, PEOPLE, { entities: {}, exclude: { people: ["Alex"] } });
    const result = await generateEntitiesWith(memory.steps, entityConfig());
    expect(result.errors).toEqual(['.llmwiki/aliases.json excludes names from "people", which is not an extracted type; ignored']);
    expect(memory.pages.has("person/alex")).toBe(true);
  });

  it("removes an excluded person's page with no model call", async () => {
    const memory = memoryEntitySteps({ "chat.md": CHAT }, PEOPLE, { owner: { type: "person", names: ["Sam"] }, entities: {} });
    await generateEntitiesWith(memory.steps, entityConfig());
    const [extractions, pageRequests] = [memory.extractions.length, memory.pageRequests.length];
    memory.state.registry = { ...memory.state.registry, exclude: { person: ["Alex"] } };
    const result = await generateEntitiesWith(memory.steps, entityConfig());
    expect(result.deleted).toEqual(["person/alex"]);
    expect([memory.extractions.length, memory.pageRequests.length]).toEqual([extractions, pageRequests]);
  });
});

describe("citations on a page already written", () => {
  it("fits a citation across a gap to the lines shown, with no model call", async () => {
    const lines = ["# Notes", ...Array.from({ length: 20 }, (_, index) => `line ${index + 2}`)];
    const memory = memoryEntitySteps({ "notes.md": lines.join("\n") }, { "notes.md": [{ name: "Ana", line: 3 }, { name: "Ana", line: 16 }] });
    await generateEntitiesWith(memory.steps, entityConfig({ timeZone: null }));
    const page = memory.pages.get("person/ana")!;
    memory.pages.set("person/ana", page.replace(/\^\[notes\.md:\d+-\d+\]/, "^[notes.md:4-15]"));
    const requests = memory.pageRequests.length;
    await generateEntitiesWith(memory.steps, entityConfig({ timeZone: null }));
    expect(memory.pageRequests.length).toBe(requests);
    expect(memory.pages.get("person/ana")).toContain("^[notes.md:4-5, 14-15]");
  });
});

describe("record ids", () => {
  it("never merges a name into a registered record because their slugs match", () => {
    const registry = { entities: { person: { alex: ["Alex Johnson", "AJ"] } } };
    const records = resolveRecords("person", [mention("Alex"), mention("AJ"), mention("Anne-Marie"), mention("Anne Marie")], registry);
    expect(records.map((record) => [record.id, record.names])).toEqual([
      ["alex", ["AJ"]], ["alex-2", ["Alex"]], ["anne-marie", ["Anne Marie"]], ["anne-marie-2", ["Anne-Marie"]],
    ]);
  });

  it("keeps the owner page's id for it, even when a record is registered under the owner's slug", async () => {
    const registry = { owner: { type: "person", names: ["Ana"] }, entities: { person: { ana: ["Ana Lee"] } } };
    const memory = memoryEntitySteps({ "chat.md": CHAT }, { "chat.md": [{ name: "Ana Lee", line: 2 }] }, registry);
    await generateEntitiesWith(memory.steps, entityConfig());
    expect(ownerPageId(parseRegistry(JSON.stringify(registry)), "person")).toBe("ana-owner");
    expect(parseFrontmatter(memory.pages.get("person/ana")!).meta.title).toBe("Ana Lee");
  });

  it("fits a very long name into a filename", () => {
    const id = recordId("A ".repeat(200) + "very long name");
    expect(id.length).toBeLessThanOrEqual(80);
    expect(id).toMatch(/^[a-z0-9][a-z0-9-]*$/);
    expect(recordId("B ".repeat(200))).not.toBe(id);
  });
});

describe("long sources", () => {
  it("re-reads only the changed last chunk of a source that grows", async () => {
    const long = ["# Chat", ...Array.from({ length: 1200 }, (_, i) => `- 2026-05-04 09:00 Sam: line ${i} ${"x".repeat(80)}`)].join("\n");
    const sources = { "chat.md": long };
    const memory = memoryEntitySteps(sources, { "chat.md": [{ name: "Ana", line: 2 }] });
    await generateEntitiesWith(memory.steps, entityConfig());
    const first = memory.extractions.length;
    sources["chat.md"] = `${long}\n- 2026-05-05 10:00 Ana: one more`;
    await generateEntitiesWith(memory.steps, entityConfig());
    expect(first).toBeGreaterThan(1);
    expect(memory.extractions.length - first).toBe(1);
  });
});
