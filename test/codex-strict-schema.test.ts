/**
 * @file test/codex-strict-schema.test.ts
 * @description Codex structured output rejects any schema that is not strict
 * (#266): every object, at every depth, must set `additionalProperties: false`
 * and list all its properties in `required`. The executable fake does not
 * enforce that, so these tests check the outgoing schema itself, through the
 * real provider, for the production tool schemas. They also check that an
 * optional property keeps its meaning: answered `null` under the strict schema,
 * it is dropped before validation against the original schema.
 */

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import Ajv from "ajv";
import { afterEach, describe, expect, it } from "vitest";
import { PAGE_SELECTION_TOOL } from "../src/commands/page-selection.js";
import { CONCEPT_EXTRACTION_TOOL } from "../src/compiler/prompts.js";
import { RULE_EXTRACTION_TOOL } from "../src/compiler/rule-prompts.js";
import { JUDGE_TOOL } from "../src/eval/citation-support.js";
import { CodexAgentProvider } from "../src/providers/codex-agent.js";
import { dropNullOptionals, toStrictSchema } from "../src/providers/codex-strict-schema.js";
import type { LLMTool } from "../src/utils/provider.js";
import { installFakeCodex, type FakeCodex } from "./fixtures/fake-codex.js";

type Schema = Record<string, unknown>;
const originalPath = process.env.PATH;
const fakes: FakeCodex[] = [];
afterEach(async () => {
  process.env.PATH = originalPath;
  for (const fake of fakes.splice(0)) await fake.cleanup();
});

/**
 * Every tool schema llmwiki declares, by the module that declares it. The
 * guard below derives the declaring modules from the source, so a new tool
 * cannot skip these checks.
 */
const PRODUCTION_TOOLS: Record<string, Schema> = {
  "src/commands/page-selection.ts": PAGE_SELECTION_TOOL.input_schema,
  "src/compiler/prompts.ts": CONCEPT_EXTRACTION_TOOL.input_schema,
  "src/compiler/rule-prompts.ts": RULE_EXTRACTION_TOOL.input_schema,
  "src/eval/citation-support.ts": JUDGE_TOOL.input_schema,
};

/** Source modules that declare a tool schema literal (`input_schema: {`). */
async function modulesDeclaringToolSchemas(): Promise<string[]> {
  const files = (await readdir("src", { recursive: true })).filter(name => name.endsWith(".ts"));
  const declaring: string[] = [];
  for (const file of files) {
    if (/input_schema:\s*\{/.test(await readFile(path.join("src", file), "utf8"))) declaring.push(`src/${file}`);
  }
  return declaring.sort();
}

/** A schema exercising nesting, arrays of objects, enums, unions and optional properties. */
const MIXED: Schema = {
  type: "object",
  properties: {
    id: { type: "string" },
    level: { type: "string", enum: ["low", "high"] },
    items: { type: "array", items: { type: "object", properties: { name: { type: "string" }, note: { type: "string" } }, required: ["name"] } },
    either: { anyOf: [{ type: "object", properties: { a: { type: "number" } } }, { type: "string" }] },
  },
  required: ["id"],
};

/** Every place in `schema` that Codex's strict structured output would reject. */
function strictViolations(schema: unknown, at = "$"): string[] {
  if (typeof schema !== "object" || schema === null) return [];
  const node = schema as Schema;
  return [...ownViolations(node, at), ...childSchemas(node, at).flatMap(([child, where]) => strictViolations(child, where))];
}

/** An object node's own violations: open to extra properties, or a property not required. */
function ownViolations(node: Schema, at: string): string[] {
  if (!node.properties || typeof node.properties !== "object") return [];
  const required = Array.isArray(node.required) ? node.required : [];
  const open = node.additionalProperties === false ? [] : [`${at}: additionalProperties is not false`];
  return [...open, ...Object.keys(node.properties).filter(name => !required.includes(name)).map(name => `${at}.${name}: not required`)];
}

/** The nested schemas of a node (properties, array items, union branches) with their paths. */
function childSchemas(node: Schema, at: string): Array<[unknown, string]> {
  const properties = node.properties && typeof node.properties === "object" ? Object.entries(node.properties) : [];
  return [
    ...properties.map(([name, child]): [unknown, string] => [child, `${at}.${name}`]),
    ...(node.items ? [[node.items, `${at}[]`] as [unknown, string]] : []),
    ...(Array.isArray(node.anyOf) ? node.anyOf.map((branch, i): [unknown, string] => [branch, `${at}|${i}`]) : []),
  ];
}

/** Install the fake as the only `codex` on PATH. */
async function useFake(options: Parameters<typeof installFakeCodex>[0]): Promise<FakeCodex> {
  const fake = await installFakeCodex(options);
  fakes.push(fake);
  process.env.PATH = `${fake.binDir}${path.delimiter}${originalPath ?? ""}`;
  return fake;
}

describe("strict schemas for Codex structured output", () => {
  it("covers every tool schema declared in src", async () => {
    expect(await modulesDeclaringToolSchemas()).toEqual(Object.keys(PRODUCTION_TOOLS).sort());
  });

  it.each([...Object.entries(PRODUCTION_TOOLS), ["a mixed schema", MIXED] as const])(
    "closes every object and requires every property: %s", (_label, schema) => {
    // PRECONDITION pinned: the original really is non-strict, so the checker can see a violation.
    expect(strictViolations(schema), "fixture is already strict").not.toEqual([]);
    expect(strictViolations(toStrictSchema(schema as Schema))).toEqual([]);
    // The strict copy must still accept a reply that is valid for the original.
    expect(() => new Ajv().compile(toStrictSchema(schema as Schema))).not.toThrow();
  });

  it("leaves the original schema untouched", () => {
    const before = JSON.stringify(CONCEPT_EXTRACTION_TOOL.input_schema);
    toStrictSchema(CONCEPT_EXTRACTION_TOOL.input_schema);
    expect(JSON.stringify(CONCEPT_EXTRACTION_TOOL.input_schema)).toBe(before);
  });

  it("keeps an optional property optional: a null answer is dropped, then the original schema decides", () => {
    const strict = toStrictSchema(MIXED);
    const reply = { id: "x", level: null, items: [{ name: "n", note: null }], either: null };
    expect(new Ajv().validate(strict, reply), "strict schema must accept nulls for optionals").toBe(true);
    const restored = dropNullOptionals(reply, MIXED);
    expect(restored).toEqual({ id: "x", items: [{ name: "n" }] });
    expect(new Ajv().validate(MIXED, restored)).toBe(true);
    expect(new Ajv().validate(MIXED, dropNullOptionals({ id: null }, MIXED)), "a required null must still fail").toBe(false);
  });
});

describe("the Codex provider sends the strict schema", () => {
  it("sends a strict extraction schema and returns the reply without the nulls it introduced", async () => {
    const reply = {
      concepts: [{
        concept: "Lantern", summary: "A team", is_new: true,
        tags: null, confidence: null, provenance_state: null, contradicted_by: [{ slug: "other", reason: null }],
      }],
    };
    const fake = await useFake({ toolOutput: reply });
    const provider = new CodexAgentProvider(undefined, { timeoutMs: 5_000 });
    const result = await provider.toolCall("system", [{ role: "user", content: "x" }], [CONCEPT_EXTRACTION_TOOL as LLMTool], 99);
    const [call] = await fake.calls();
    expect(strictViolations(call.schema)).toEqual([]);
    expect(JSON.parse(result)).toEqual({
      concepts: [{ concept: "Lantern", summary: "A team", is_new: true, contradicted_by: [{ slug: "other" }] }],
    });
  });
});
