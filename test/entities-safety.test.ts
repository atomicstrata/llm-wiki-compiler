/**
 * @file test/entities-safety.test.ts
 * @description The entity step under failure and edge cases: a failed read keeps
 * its pages, a page that cannot pass the field contract costs no model call,
 * names that make the same slug stay separate records, the hub's id is its own,
 * ids fit a filename, the hub groups by the first declared enum field, and a
 * source that grows re-reads only its changed chunk.
 */

import { describe, expect, it } from "bun:test";
import { parseFrontmatter } from "../src/utils/markdown.js";
import type { ProfilePack } from "../src/profile/types.js";
import { extractableTypes } from "../src/entities/schema.js";
import { generateEntitiesWith, type EntityConfig } from "../src/entities/generate.js";
import { recordId, resolveRecords, type Mention } from "../src/entities/identity.js";
import { memoryEntitySteps, personProfile, type FakePerson } from "./entity-steps.js";

const CHAT = ["# Chat", "- 2026-05-04 09:00 Sam: Ana is coming", "- 2026-05-05 10:00 Ana: hi", "- 2026-05-05 10:01 Alex: hey"].join("\n");
const PEOPLE: Record<string, FakePerson[]> = { "chat.md": [{ name: "Ana", relationship: "friend", line: 2 }, { name: "Alex", line: 4 }] };

/** The step's config for `profile`. */
function config(profile: ProfilePack = personProfile()): EntityConfig {
  return { types: extractableTypes(profile), timeZone: "UTC", concurrency: 2 };
}

/** A mention of `name`. */
function mention(name: string): Mention {
  return { file: "chat.md", name, fields: {}, lines: [{ start: 1, end: 1 }] };
}

describe("entity pages when things go wrong", () => {
  it("keeps every page when extraction fails, and retries the source next time", async () => {
    const memory = memoryEntitySteps({ "chat.md": CHAT }, PEOPLE);
    await generateEntitiesWith(memory.steps, config());
    const widened = personProfile();
    widened.entities.person.fields!.role = { type: "string" };
    memory.steps.complete = async () => { throw new Error("rate limited"); };
    const result = await generateEntitiesWith(memory.steps, config(widened));
    expect(result.deleted).toEqual([]);
    expect([...memory.pages.keys()].sort()).toEqual(["person/alex", "person/ana"]);
    expect(memory.state.cache!.sources["chat.md"].hash).toBe("");
  });

  it("makes no model call for a page that cannot pass the field contract, on any compile", async () => {
    const strict = personProfile();
    strict.entities.person.requiredFields = ["relationship"];
    const memory = memoryEntitySteps({ "chat.md": CHAT }, PEOPLE);
    const first = await generateEntitiesWith(memory.steps, config(strict));
    expect(first.errors).toEqual([expect.stringContaining('Page "person/alex" not written: Required field "relationship"')]);
    await generateEntitiesWith(memory.steps, config(strict));
    expect(memory.pageRequests).toEqual(["Ana"]);
  });

  it("writes the name under the type's own title field", async () => {
    const named = personProfile();
    named.entities.person.titleField = "name";
    named.entities.person.fields!.name = { type: "string", required: true };
    const memory = memoryEntitySteps({ "chat.md": CHAT }, PEOPLE);
    expect((await generateEntitiesWith(memory.steps, config(named))).errors).toEqual([]);
    expect(parseFrontmatter(memory.pages.get("person/ana")!).meta).toMatchObject({ title: "Ana", name: "Ana" });
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

  it("keeps the hub's id for the hub, even when a record is registered under the owner's slug", async () => {
    const registry = { owner: { type: "person", names: ["Ana"] }, entities: { person: { ana: ["Ana Lee"] } } };
    const memory = memoryEntitySteps({ "chat.md": CHAT }, { "chat.md": [{ name: "Ana Lee", line: 2 }] }, registry);
    await generateEntitiesWith(memory.steps, config());
    const requests = memory.pageRequests.length;
    await generateEntitiesWith(memory.steps, config());
    expect(memory.pageRequests.length).toBe(requests);
    expect(parseFrontmatter(memory.pages.get("person/ana")!).meta.title).toBe("Ana Lee");
    expect(memory.pages.get("person/ana-owner")).toContain("[[person/ana|Ana Lee]]");
  });

  it("fits a very long name into a filename", () => {
    const id = recordId("A ".repeat(200) + "very long name");
    expect(id.length).toBeLessThanOrEqual(80);
    expect(id).toMatch(/^[a-z0-9][a-z0-9-]*$/);
    expect(recordId("B ".repeat(200))).not.toBe(id);
  });
});

describe("the hub and long sources", () => {
  it("groups the hub by the first enum field as declared, and keeps a value outside it", async () => {
    const profile = personProfile();
    profile.entities.person.fields = { title: { type: "string" }, relationship: profile.entities.person.fields!.relationship, closeness: { type: "enum", enum: ["close"] } };
    const memory = memoryEntitySteps({ "chat.md": CHAT }, PEOPLE, { owner: { type: "person", names: ["Sam"] }, entities: {} });
    await generateEntitiesWith(memory.steps, config(profile));
    memory.pages.set("person/alex", memory.pages.get("person/alex")!.replace("title: Alex", "title: Alex\nrelationship: mentor"));
    profile.entities.person.fields.relationship.enum!.push("partner");
    await generateEntitiesWith(memory.steps, config(profile));
    expect(memory.pages.get("person/sam")).toContain("## Friend\n\n- [[person/ana|Ana]]");
    expect(memory.pages.get("person/sam")).toContain("## Mentor\n\n- [[person/alex|Alex]]");
  });

  it("re-reads only the changed last chunk of a source that grows", async () => {
    const long = ["# Chat", ...Array.from({ length: 1200 }, (_, i) => `- 2026-05-04 09:00 Sam: line ${i} ${"x".repeat(80)}`)].join("\n");
    const sources = { "chat.md": long };
    const memory = memoryEntitySteps(sources, { "chat.md": [{ name: "Ana", line: 2 }] });
    await generateEntitiesWith(memory.steps, config());
    const first = memory.extractions.length;
    sources["chat.md"] = `${long}\n- 2026-05-05 10:00 Ana: one more`;
    await generateEntitiesWith(memory.steps, config());
    expect(first).toBeGreaterThan(1);
    expect(memory.extractions.length - first).toBe(1);
  });
});
