/**
 * @file D-GROUNDING-SCOPE: `query`'s `pageScope` bounds what the model is SHOWN. The store
 * is narrowed BEFORE ranking (an out-of-scope page that would rank first cannot crowd an
 * in-scope page out of the top-k), the LLM/index fallback offers only in-scope candidates,
 * an empty scope grounds on nothing, and no scope leaves today's behaviour untouched.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeTempRoot } from "./fixtures/temp-root.js";
import { writePage } from "./fixtures/write-page.js";
import { chunkOf, mockQueryVector, offeringCallClaudeModule, tempRootRegistry, writeChunkStore } from "./fixtures/typed-grounding.js";
import { generateAnswer } from "../src/commands/query.js";

const state = vi.hoisted(() => ({ offered: [] as string[] }));
vi.mock("../src/utils/llm.js", () => offeringCallClaudeModule(state));

const tempRoots = tempRootRegistry();
afterEach(async () => {
  vi.restoreAllMocks();
  state.offered = [];
  await tempRoots.cleanup();
});

/** Two pages; `concepts/idea` is the near-exact match, `concepts/paper` the weaker one. */
async function seedRoot(): Promise<string> {
  const root = await makeTempRoot("page-scope");
  tempRoots.track(root);
  await writeFile(path.join(root, "wiki", "index.md"), "# Index\n");
  await mkdir(path.join(root, ".llmwiki"), { recursive: true });
  await writePage(path.join(root, "wiki/concepts"), "idea", { title: "Idea", summary: "i" }, "IDEA_BODY fact.");
  await writePage(path.join(root, "wiki/concepts"), "paper", { title: "Paper", summary: "p" }, "PAPER_BODY fact.");
  return root;
}

/** A chunk store where the idea page ranks FIRST for the query vector. */
async function seedRankedStore(root: string): Promise<void> {
  await writeChunkStore(root, [chunkOf("concepts/idea", "IDEA_BODY fact.", [1, 0]), chunkOf("concepts/paper", "PAPER_BODY fact.", [0.6, 0.8])]);
  mockQueryVector([1, 0]);
}

describe("query pageScope (D-GROUNDING-SCOPE)", () => {
  it("no scope: the top-ranked out-of-scope page grounds the answer (today's behaviour)", async () => {
    const root = await seedRoot();
    await seedRankedStore(root);
    const result = await generateAnswer(root, "what is the idea?");
    expect(result.pageIds[0]).toBe("concepts/idea");
  });

  it("scoped: only the in-scope page is retrieved and shown, though it ranks second", async () => {
    const root = await seedRoot();
    await seedRankedStore(root);
    const result = await generateAnswer(root, "what is the idea?", { pageScope: ["concepts/paper"] });
    expect(result.pageIds).toEqual(["concepts/paper"]);
    expect(result.answer).toContain("PAPER_BODY");
    expect(result.answer).not.toContain("IDEA_BODY");
  });

  it("empty scope: nothing may ground", async () => {
    const root = await seedRoot();
    await seedRankedStore(root);
    const result = await generateAnswer(root, "what is the idea?", { pageScope: [] });
    expect(result.pageIds).toEqual([]);
  });

  it("fallback path (no store): the model is OFFERED only in-scope candidates", async () => {
    const root = await seedRoot();
    const result = await generateAnswer(root, "what is the idea?", { pageScope: ["concepts/paper"] });
    expect(state.offered).toEqual(["concepts/paper"]);
    expect(result.pageIds).toEqual(["concepts/paper"]);
  });
});
