/**
 * @file test/query-hydrated-grounding.test.ts
 * @description D29 fix (i): a `QueryResult`'s identity fields (`pageIds`/`refs`/
 * `selectedPages`) are the HYDRATED grounding — the pages actually rendered
 * into the answer prompt — not the selected refs. A page that is selected but
 * cannot be hydrated (deleted between selection and hydration — the drop
 * `loadSelectedRefRecords` performs silently) must vanish from the returned
 * grounding and surface as a `page-hydration-dropped` warning instead.
 */

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAlphaPageFixture } from "./fixtures/alpha-page.js";
import { makeTempRoot } from "./fixtures/temp-root.js";
import { writePage } from "./fixtures/write-page.js";
import { chunkOf, mockQueryVector, writeChunkStore } from "./fixtures/typed-grounding.js";
import { generateAnswer } from "../src/commands/query.js";

// The page-selection call (tools present) answers with the configured picks
// AFTER running the configured side effect — which deletes a page, seeding the
// exact selected-but-unreadable state the fix must surface. The answer call
// (no tools) echoes its grounding prompt back so assertions see what the
// model was shown.
const state = vi.hoisted(() => ({
  selection: [] as string[],
  onSelect: undefined as (() => Promise<void>) | undefined,
}));
vi.mock("../src/utils/llm.js", () => ({
  callClaude: vi.fn(async (opts: { tools?: unknown[]; messages: Array<{ content: string }> }) => {
    if (opts.tools) {
      await state.onSelect?.();
      return JSON.stringify({ pages: state.selection, reasoning: "r" });
    }
    return opts.messages[0].content;
  }),
}));

const alphaRoot = useAlphaPageFixture("hydrated-grounding");
const roots: string[] = [];
afterEach(async () => {
  state.onSelect = undefined;
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

/** Seed a bare project (no embedding store → LLM fallback selection) with two live concepts. */
async function seedRoot(): Promise<string> {
  const root = await alphaRoot();
  await writePage(path.join(root, "wiki/concepts"), "ghost", { title: "Ghost", summary: "g" }, "GHOST_BODY fact.");
  return root;
}

describe("query grounding identity is the HYDRATED set", () => {
  it.each([
    { grounding: "hydrated" as const },
    { pageScope: ["concepts/alpha", "concepts/ghost"] },
    { review: true },
  ])("drops an unreadable page with opted-in hydrated grounding: %j", async (options) => {
    const root = await seedRoot();
    state.selection = ["concepts/alpha", "concepts/ghost"];
    state.onSelect = () => rm(path.join(root, "wiki/concepts", "ghost.md"));
    const selected: string[] = [];
    const result = await generateAnswer(root, "what is alpha?", {
      save: !("review" in options),
      ...options,
      onPageSelection: (pages) => void selected.push(...pages),
    });
    // PRECONDITION pinned: ghost WAS selected — the drop happens at hydration.
    expect(selected, "fixture no longer selects the ghost page").toContain("concepts/ghost");
    expect(result.pageIds, "a page the model never saw is reported as grounding").toEqual(["concepts/alpha"]);
    expect(result.refs.map((ref) => ref.pageId)).toEqual(["concepts/alpha"]);
    expect(result.selectedPages).toEqual(["alpha"]);
    expect(result.answer).toContain("ALPHA_BODY");
    expect(result.answer).not.toContain("GHOST_BODY");
    const warning = (result.warnings ?? []).find((w) => w.code === "page-hydration-dropped");
    expect(warning, "hydration drop did not surface as a warning").toBeDefined();
    expect(warning?.message).toContain("concepts/ghost");
    // The durable save journal records the SAME hydrated identity the result
    // returns — the dropped page is never permanently logged as grounding.
    if (!("review" in options)) {
      const log = await readFile(path.join(root, "log.md"), "utf8");
      expect(log).toContain("concepts/alpha");
      expect(log, "the journal recorded a page that never hydrated").not.toContain("concepts/ghost");
    }
  });

  it("preserves selected refs and activity-log identities by default after a hydration drop", async () => {
    const root = await seedRoot();
    state.selection = ["concepts/alpha", "concepts/ghost"];
    state.onSelect = () => rm(path.join(root, "wiki/concepts", "ghost.md"));
    const result = await generateAnswer(root, "what is alpha?");
    expect(result.pageIds).toEqual(state.selection);
    expect(result.selectedPages).toEqual(["alpha", "ghost"]);
    expect(result.answer).not.toContain("GHOST_BODY");
    expect(result.warnings?.some((warning) => warning.code === "page-hydration-dropped")).not.toBe(true);
    expect(await readFile(path.join(root, "log.md"), "utf8")).toContain("concepts/ghost");
  });

  it("reports all pages and NO drop warning when every selected page hydrates", async () => {
    const root = await seedRoot();
    state.selection = ["concepts/alpha", "concepts/ghost"];
    const result = await generateAnswer(root, "what is alpha?");
    expect(result.pageIds).toEqual(["concepts/alpha", "concepts/ghost"]);
    expect(result.answer).toContain("GHOST_BODY");
    expect((result.warnings ?? []).map((w) => w.code)).not.toContain("page-hydration-dropped");
  });

  it.each([undefined, "hydrated"] as const)("preserves the %s chunk grounding policy", async (grounding) => {
    // Chunk retrieval keeps up to CHUNK_RERANK_KEEP excerpts but collapses
    // parents to QUERY_PAGE_LIMIT refs — seed MORE chunk parents than the ref
    // cap so an excerpt whose parent is outside the grounding would reach the
    // prompt if it were not filtered.
    const root = await makeTempRoot("chunk-grounding");
    roots.push(root);
    await writeFile(path.join(root, "wiki", "index.md"), "# Index\n");
    await mkdir(path.join(root, ".llmwiki"), { recursive: true });
    const parents = Array.from({ length: 7 }, (_, i) => `concepts/chunky-${i}`);
    const bodyOf = (pageId: string): string => `CHUNK_BODY_${pageId.slice("concepts/".length)} fact.`;
    for (const pageId of parents) {
      const slug = pageId.slice("concepts/".length);
      await writePage(path.join(root, "wiki/concepts"), slug, { title: slug, summary: "s" }, bodyOf(pageId));
    }
    await writeChunkStore(root, parents.map((pageId) => chunkOf(pageId, bodyOf(pageId), [1, 0])));
    mockQueryVector([1, 0]);

    const result = await generateAnswer(root, "what are the chunky facts?", { debug: true, grounding });
    // PRECONDITION pinned: retrieval genuinely kept MORE excerpt parents than
    // the collapsed ref cap — otherwise this case witnesses nothing.
    const retrievedParents = new Set((result.debug?.chunks ?? []).map((chunk) => chunk.pageId));
    expect(retrievedParents.size, "fixture no longer overflows the ref cap").toBeGreaterThan(result.pageIds.length);
    // Every excerpt actually rendered into the prompt (echoed back by the
    // answer mock) names a parent the result reports as grounding.
    const rendered = [...result.answer.matchAll(/^--- (\S+) \(chunk /gm)].map((match) => match[1]!);
    expect(rendered.length, "no excerpt reached the prompt").toBeGreaterThan(0);
    if (grounding === "hydrated") expect(rendered.every((parent) => result.pageIds.includes(parent))).toBe(true);
    else expect(new Set(rendered)).toEqual(retrievedParents);
  });
});
