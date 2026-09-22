/**
 * @file Unit witnesses for the OFFLINE provider: the echo completion contract,
 * the schema-empty tool call, and the deterministic hashed bag-of-words
 * embedding — each pinned so a mutant that drifts from the contract goes red.
 */

import { describe, expect, it } from "vitest";
import { CONCEPT_EXTRACTION_TOOL } from "../../src/compiler/prompts.js";
import {
  OFFLINE_EMBEDDING_DIMENSIONS, OfflineProvider, OfflineProviderError, bagOfWordsVector, schemaEmptyValue,
} from "../../src/providers/offline.js";

const provider = new OfflineProvider();
const norm = (v: number[]): number => Math.sqrt(v.reduce((s, x) => s + x * x, 0));

describe("offline provider — completion", () => {
  it("complete echoes the FIRST message's content verbatim", async () => {
    const out = await provider.complete("sys", [{ role: "user", content: "alpha beta" }, { role: "assistant", content: "x" }], 10);
    expect(out).toBe("alpha beta");
  });

  it("stream emits the echo exactly once through onToken and returns it", async () => {
    const tokens: string[] = [];
    const out = await provider.stream("sys", [{ role: "user", content: "gamma" }], 10, (t) => tokens.push(t));
    expect(out).toBe("gamma");
    expect(tokens).toEqual(["gamma"]);
  });

  it("complete refuses an empty message list with a typed error", async () => {
    await expect(provider.complete("sys", [], 10)).rejects.toBeInstanceOf(OfflineProviderError);
  });
});

describe("offline provider — schema-empty tool calls", () => {
  it("returns parseable JSON carrying every REQUIRED property of the first tool, each empty for its type", async () => {
    const raw = await provider.toolCall("sys", [{ role: "user", content: "extract" }], [CONCEPT_EXTRACTION_TOOL], 10);
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const required = (CONCEPT_EXTRACTION_TOOL.input_schema.required as string[] | undefined) ?? [];
    for (const key of required) expect(parsed).toHaveProperty(key);
    for (const value of Object.values(parsed)) expect([[], "", 0, false, null]).toContainEqual(value);
  });

  it("a page-selection-shaped tool yields no pages and an empty reasoning string", async () => {
    const selection = { name: "select_pages", description: "pick", input_schema: { type: "object", required: ["pages", "reasoning"], properties: { pages: { type: "array" }, reasoning: { type: "string" } } } };
    const raw = await provider.toolCall("sys", [{ role: "user", content: "q" }], [selection], 10);
    expect(JSON.parse(raw)).toEqual({ pages: [], reasoning: "" });
  });

  it("schemaEmptyValue recurses into required object properties and omits optional ones", () => {
    const schema = { type: "object", required: ["a", "n"], properties: { a: { type: "object", required: ["s"], properties: { s: { type: "string" } } }, n: { type: "integer" }, opt: { type: "string" } } };
    expect(schemaEmptyValue(schema)).toEqual({ a: { s: "" }, n: 0 });
  });

  it("toolCall refuses when no tool is given", async () => {
    await expect(provider.toolCall("sys", [{ role: "user", content: "q" }], [], 10)).rejects.toBeInstanceOf(OfflineProviderError);
  });
});

describe("offline provider — hashed bag-of-words embedding", () => {
  it("is deterministic, fixed-width, and unit-norm", async () => {
    const a = await provider.embed("Sparse attention over long contexts");
    const b = await provider.embed("Sparse attention over long contexts");
    expect(a).toEqual(b);
    expect(a).toHaveLength(OFFLINE_EMBEDDING_DIMENSIONS);
    expect(norm(a)).toBeCloseTo(1, 9);
  });

  it("ranks lexical overlap above unrelated text (cosine)", () => {
    const query = bagOfWordsVector("sparse attention");
    const near = bagOfWordsVector("Sparse Attention for long documents");
    const far = bagOfWordsVector("bread recipes and oven temperatures");
    const dot = (x: number[], y: number[]): number => x.reduce((s, v, i) => s + v * y[i]!, 0);
    expect(dot(query, near)).toBeGreaterThan(dot(query, far));
  });

  it("empty text yields a unit vector, never a zero vector", () => {
    expect(norm(bagOfWordsVector(""))).toBeCloseTo(1, 9);
  });

  it("embedBatch maps embed over every text in order", async () => {
    const batch = await provider.embedBatch(["one", "two"]);
    expect(batch).toEqual([await provider.embed("one"), await provider.embed("two")]);
  });
});
