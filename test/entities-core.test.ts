/**
 * @file test/entities-core.test.ts
 * @description The pure parts of entity extraction: which types opt in, the
 * structural digest the cache keys on, the answer schema, identity (registry,
 * exact names, flagged-not-merged duplicates), and how a model answer is read.
 */

import { describe, expect, it } from "bun:test";
import { mention, personProfile } from "./entity-steps.js";
import { extractableTypes, extractionTool, structuralDigest } from "../src/entities/schema.js";
import { displayName, parseRegistry, possibleDuplicates, recordId, resolveRecords } from "../src/entities/identity.js";
import { extractionRequest, parseRecords } from "../src/entities/extract.js";

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
    expect(record.required).toEqual(["name", "writtenAs", "aliases", "organization", "relationship", "lines"]);
    expect(record.properties.relationship).toEqual({ type: ["string", "null"], enum: ["friend", "family", "unknown", null] });
  });
});

describe("identity", () => {
  it("groups by who a mention is, and keeps how the sources wrote it", () => {
    const records = resolveRecords("person", [
      { ...mention("Alex Kim"), writtenAs: ["Alexx"] },
      { ...mention("Alex Kim"), writtenAs: ["alex", "Alex Kim"] },
      { ...mention("Sam's mother"), writtenAs: ["mama"] },
      { ...mention("Sam's mother"), writtenAs: ["Mom"] },
    ], { entities: {} });
    expect(records.map((record) => [record.names, record.writtenAs])).toEqual([[["Alex Kim"], ["Alexx", "alex"]], [["Sam's mother"], ["mama", "Mom"]]]);
  });

  it("never merges or excludes by spelling: a registered or excluded spelling only flags a possible duplicate", () => {
    const registry = parseRegistry(JSON.stringify({ entities: { person: { "tom-baker": ["Tom Baker", "Tom"] } }, exclude: { person: ["Tom Hanks"] } }));
    const records = resolveRecords("person", [
      { ...mention("Tom Hanks"), writtenAs: ["Tom"] }, { ...mention("Alex Chen"), writtenAs: ["Tom"] }, mention("Tom Baker"),
    ], registry);
    expect(records.map((record) => [record.id, record.names])).toEqual([["alex-chen", ["Alex Chen"]], ["tom-baker", ["Tom Baker"]]]);
    expect(possibleDuplicates(records).get("alex-chen")).toEqual(["tom-baker"]);
  });

  it("leaves bare pronouns out of how the sources wrote someone", () => {
    const [record] = resolveRecords("person", [{ ...mention("Sam's mother"), writtenAs: ["mama", "they", "Their", "his", "the parents"] }], { entities: {} });
    expect(record.writtenAs).toEqual(["mama", "the parents"]);
  });

  it("does not flag spellings that start with a pronoun or family word, and keeps a possessive off a spelling", () => {
    const records = resolveRecords("person", [
      { ...mention("Sam's father"), writtenAs: ["my dad", "parents’"] }, { ...mention("Alex's father"), writtenAs: ["My dad"] }, { ...mention("Mo"), writtenAs: ["mom"] },
    ], { entities: {} });
    expect(possibleDuplicates(records).size).toBe(0);
    expect(records.find((record) => record.id === "sams-father")!.writtenAs).toEqual(["my dad", "parents"]);
  });

  it("flags names that start with an initial or a short given name, but not mum or an in-law", () => {
    const flagged = possibleDuplicates(resolveRecords("person", [mention("A.J. Smith"), mention("A.J."), mention("An Nguyen"), mention("An")], { entities: {} }));
    expect([flagged.get("aj-smith"), flagged.get("an-nguyen")]).toEqual([["aj"], ["an"]]);
    const relatives = resolveRecords("person", [
      { ...mention("Sam's mother-in-law"), writtenAs: ["mother-in-law"] }, { ...mention("Alex's mother-in-law"), writtenAs: ["Mother-in-law"] },
      { ...mention("Sam's mother"), writtenAs: ["mum"] }, { ...mention("Alex's mother"), writtenAs: ["Mum"] }, { ...mention("Alex's stepdad"), writtenAs: ["stepdad"] },
    ], { entities: {} });
    expect(possibleDuplicates(relatives).size).toBe(0);
  });

  it("never flags records the registry settled as different people", () => {
    const registry = parseRegistry(JSON.stringify({ distinct: { person: [["ben", "ben-eggers"]] } }));
    const records = resolveRecords("person", [mention("Ben"), mention("Ben Eggers"), mention("Ben Lee")], registry);
    const flags = possibleDuplicates(records, registry.distinct?.person);
    expect([flags.get("ben"), flags.get("ben-eggers"), flags.get("ben-lee")]).toEqual([["ben-lee"], ["ben-lee"], ["ben", "ben-eggers"]]);
    expect(() => parseRegistry(JSON.stringify({ distinct: { person: ["ben", "ben-eggers"] } }))).toThrow(/"distinct" must map/);
    expect(() => parseRegistry(JSON.stringify({ distinct: { person: [["ben"]] } }))).toThrow(/two or more record ids/);
    expect(() => parseRegistry(JSON.stringify({ distinct: { person: [["ben", "Ben Eggers"]] } }))).toThrow(/two or more record ids/);
  });

  it("does not flag relation names by their first word", () => {
    const records = resolveRecords("person", [mention("Sam's mother"), mention("Sam's brother"), mention("Sam Lee")], { entities: {} });
    expect(possibleDuplicates(records).size).toBe(0);
  });

  it("joins names that normalize the same, keeps other names apart, and drops the owner", () => {
    const registry = parseRegistry(JSON.stringify({ owner: { type: "person", names: ["Sam"] } }));
    const records = resolveRecords("person", [mention("Alex"), mention("alex "), mention("Alex Kim"), mention("SAM")], registry);
    expect(records.map((record) => [record.id, record.names])).toEqual([["alex", ["Alex", "alex"]], ["alex-kim", ["Alex Kim"]]]);
  });

  it("leaves out the names the registry excludes for a type, in any spelling, and only for that type", () => {
    const registry = parseRegistry(JSON.stringify({ exclude: { person: ["Donald Trump", "Acme Corp", 7] } }));
    expect(registry.exclude).toEqual({ person: ["Donald Trump", "Acme Corp"] });
    const records = resolveRecords("person", [mention("donald  TRUMP"), mention("acme corp"), mention("Ana")], registry);
    expect(records.map((record) => record.id)).toEqual(["ana"]);
    expect(resolveRecords("company", [mention("Acme Corp")], registry).map((record) => record.id)).toEqual(["acme-corp"]);
  });

  it("never renames another record when a name is excluded", () => {
    const names = [mention("Mary Jane"), mention("Mary-Jane")];
    const before = resolveRecords("person", names, { entities: {} });
    const after = resolveRecords("person", names, parseRegistry(JSON.stringify({ exclude: { person: ["Mary Jane"] } })));
    expect(before.map((record) => [record.id, record.names[0]])).toEqual([["mary-jane", "Mary Jane"], ["mary-jane-2", "Mary-Jane"]]);
    expect(after.map((record) => [record.id, record.names[0]])).toEqual([["mary-jane-2", "Mary-Jane"]]);
  });

  it("refuses an owner or a record of the wrong shape instead of ignoring it", () => {
    expect(() => parseRegistry(JSON.stringify({ owner: { type: "person", names: "Sam" } }))).toThrow(/"owner" must be/);
    expect(() => parseRegistry(JSON.stringify({ entities: { person: { "Alex Kim": ["Alex"] } } }))).toThrow('record id "Alex Kim" is not a slug');
    expect(() => parseRegistry(JSON.stringify({ entities: { person: { "alex-kim": "Alex" } } }))).toThrow(/must map each record id to a list/);
  });

  it("refuses an exclude that is not a map of lists, and a name both excluded and registered", () => {
    expect(() => parseRegistry(JSON.stringify({ exclude: ["Donald Trump"] }))).toThrow(/must map each entity type/);
    expect(() => parseRegistry(JSON.stringify({ exclude: { person: "Donald Trump" } }))).toThrow(/must map each entity type/);
    expect(() => parseRegistry(JSON.stringify({ exclude: { person: ["alex kim"] }, entities: { person: { "alex-kim": ["Alex Kim"] } } })))
      .toThrow('"Alex Kim" is both excluded and registered under person "alex-kim"');
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
      { name: " Ana ", writtenAs: ["ana", " ana", 3, "Ana’s", "ana@example.com"], relationship: "friend", lines: [{ start: 2, end: 3 }, { start: 9, end: 12 }] },
      { name: "", lines: [{ start: 1, end: 1 }] },
      { name: "Ghost", lines: [{ start: 0, end: 1 }] },
    ] });
    expect(parseRecords(answer, types, 10).person).toEqual([
      { name: "Ana", writtenAs: ["ana", "Ana"], fields: { aliases: null, organization: null, relationship: "friend" }, lines: [{ start: 2, end: 3 }] },
    ]);
  });

  it("asks without the owner, with each field's guidance, and names a relation from the owner", () => {
    const { system } = extractionRequest(types, "chat.md", "1 | hi", ["Sam", "Sam R"]);
    expect(system).toContain('"Sam\'s mother"');
    expect(system).toContain("never list the owner");
    expect(system).toContain("Sam / Sam R");
    expect(system).toContain("  - relationship: How the owner knows them");
  });
});
