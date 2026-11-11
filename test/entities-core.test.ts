/**
 * @file test/entities-core.test.ts
 * @description The pure parts of entity extraction: which types opt in, the
 * structural digest the cache keys on, the answer schema, identity (registry,
 * exact names, flagged-not-merged duplicates), and how a model answer is read.
 */

import { describe, expect, it } from "bun:test";
import { personProfile } from "./entity-steps.js";
import { extractableTypes, extractionTool, structuralDigest } from "../src/entities/schema.js";
import { displayName, parseRegistry, possibleDuplicates, recordId, resolveRecords, type Mention } from "../src/entities/identity.js";
import { extractionRequest, parseRecords } from "../src/entities/extract.js";

/** A mention of `name` in `file` at `line`. */
function mention(name: string, file = "chat.md", line = 1): Mention {
  return { file, name, fields: {}, lines: [{ start: line, end: line }] };
}

describe("extractable types and the structural digest", () => {
  it("lists only opted-in types, with their fields in name order and without the title field", () => {
    const [person, ...rest] = extractableTypes(personProfile());
    expect(rest).toEqual([]);
    expect(person.type).toBe("person");
    expect(person.fields.map(([name]) => name)).toEqual(["aliases", "organization", "relationship"]);
  });

  it("keeps the digest when only prompt text changes, and changes it when structure does", () => {
    const base = structuralDigest(extractableTypes(personProfile()));
    expect(structuralDigest(extractableTypes(personProfile("Anyone named")))).toBe(base);
    const widened = personProfile();
    widened.entities.person.fields!.relationship.enum!.push("coworker");
    expect(structuralDigest(extractableTypes(widened))).not.toBe(base);
  });

  it("answers in a closed schema: nullable enum fields and line ranges, all required", () => {
    const schema = extractionTool(extractableTypes(personProfile())).input_schema as { properties: { person: { items: { required: string[]; properties: Record<string, unknown> } } } };
    const record = schema.properties.person.items;
    expect(record.required).toEqual(["name", "aliases", "organization", "relationship", "lines"]);
    expect(record.properties.relationship).toEqual({ type: ["string", "null"], enum: ["friend", "family", "unknown", null] });
  });
});

describe("identity", () => {
  it("joins names that normalize the same, keeps other names apart, and drops the owner", () => {
    const registry = parseRegistry(JSON.stringify({ owner: { type: "person", names: ["Sam"] } }));
    const records = resolveRecords("person", [mention("Alex"), mention("alex "), mention("Alex Kim"), mention("SAM")], registry);
    expect(records.map((record) => [record.id, record.names])).toEqual([["alex", ["Alex", "alex"]], ["alex-kim", ["Alex Kim"]]]);
  });

  it("leaves out the names the registry excludes for a type, in any spelling, and only for that type", () => {
    const registry = parseRegistry(JSON.stringify({ exclude: { person: ["Donald Trump", "Bevyl", 7] } }));
    expect(registry.exclude).toEqual({ person: ["Donald Trump", "Bevyl"] });
    const records = resolveRecords("person", [mention("donald  TRUMP"), mention("bevyl"), mention("Ana")], registry);
    expect(records.map((record) => record.id)).toEqual(["ana"]);
    expect(resolveRecords("company", [mention("Bevyl")], registry).map((record) => record.id)).toEqual(["bevyl"]);
  });

  it("merges only what the registry says, and shows the registry's first name", () => {
    const registry = parseRegistry(JSON.stringify({ entities: { person: { "alex-kim": ["Alex Kim", "Alex"] } } }));
    const [record] = resolveRecords("person", [mention("Alex"), mention("Alex Kim")], registry);
    expect(record.id).toBe("alex-kim");
    expect(displayName(record, registry.entities.person["alex-kim"])).toBe("Alex Kim");
  });

  it("flags records that share a first name both ways instead of merging them", () => {
    const records = resolveRecords("person", [mention("Alex"), mention("Alex Kim"), mention("Ana")], { entities: {} });
    const flags = possibleDuplicates(records);
    expect(flags.get("alex")).toEqual(["alex-kim"]);
    expect(flags.get("alex-kim")).toEqual(["alex"]);
    expect(flags.has("ana")).toBe(false);
  });

  it("shows a name written only in lowercase capitalized, and prefers a capitalized spelling", () => {
    const [lower] = resolveRecords("person", [mention("elon musk")], { entities: {} });
    expect(displayName(lower, undefined)).toBe("Elon Musk");
    const [mixed] = resolveRecords("person", [mention("lori"), mention("lori"), mention("Lori")], { entities: {} });
    expect(displayName(mixed, undefined)).toBe("Lori");
  });

  it("gives a slug-safe id to any name", () => {
    expect(recordId("José Núñez")).toBe("jose-nunez");
    expect(recordId("李雷")).toMatch(/^record-[a-z0-9]+$/);
  });
});

describe("reading an extraction answer", () => {
  const types = extractableTypes(personProfile());

  it("keeps named records with lines inside the file and nulls missing fields", () => {
    const answer = JSON.stringify({ person: [
      { name: " Ana ", relationship: "friend", lines: [{ start: 2, end: 3 }, { start: 9, end: 12 }] },
      { name: "", lines: [{ start: 1, end: 1 }] },
      { name: "Ghost", lines: [{ start: 0, end: 1 }] },
    ] });
    expect(parseRecords(answer, types, 10).person).toEqual([
      { name: "Ana", fields: { aliases: null, organization: null, relationship: "friend" }, lines: [{ start: 2, end: 3 }] },
    ]);
  });

  it("asks without the owner and with each field's guidance", () => {
    const { system } = extractionRequest(types, "chat.md", "1 | hi", ["Sam", "Sam R"]);
    expect(system).toContain("never list the owner");
    expect(system).toContain("Sam / Sam R");
    expect(system).toContain("  - relationship: How the owner knows them");
  });
});
