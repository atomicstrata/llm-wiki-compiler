/**
 * @file test/search-index-fallback-namespace.test.ts
 * @description Task F3/PR4F — the embeddings-unavailable fallback selector
 * resolves each pick to its REAL namespace (queries/typed pages must NOT be
 * mis-keyed as concepts/<slug>) by keying candidates on qualified pageId.
 *
 * Strategy: make embeddings unavailable by writing no embeddings.json, then stub
 * `callClaude` to return a fixed pageId selection. Assert that `pickSearchRefs`
 * resolves each pick to the correct qualified pageId, and that hydration follows
 * the namespace (a queries pick loads wiki/queries, not wiki/concepts).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import path from "path";
import { mkdir, writeFile } from "fs/promises";
import { makeTempRoot } from "./fixtures/temp-root.js";
import { writePage } from "./fixtures/write-page.js";
import { stubSelectPages, seedFallbackProject } from "./fixtures/fallback-stub.js";

// Stub out the LLM so callClaude returns deterministic pageId selections.
vi.mock("../src/utils/llm.js", () => ({
  callClaude: vi.fn(),
}));

/** Seed a project: wiki dirs, pages, profile (NO embeddings.json, index.md present but unused). */
function seedProject(conceptSlug: string, querySlug: string, typedSlug: string): Promise<string> {
  return seedFallbackProject("f3-fallback", { concept: conceptSlug, query: querySlug, typed: typedSlug });
}

describe("pickSearchRefs — fallback namespace resolution (F3)", () => {
  let pickSearchRefs: typeof import("../src/search/retrieval.js").pickSearchRefs;

  beforeEach(async () => {
    vi.resetModules();
    ({ pickSearchRefs } = await import("../src/search/retrieval.js"));
  });
  afterEach(() => vi.restoreAllMocks());

  it("a fallback selection of a SAVED QUERY pageId resolves to queries/<slug>, not concepts/<slug>", async () => {
    const root = await seedProject("concept-a", "query-b", "paper-c");
    await stubSelectPages(["queries/query-b"]);
    const { refs } = await pickSearchRefs(root, "test question");

    expect(refs).toHaveLength(1);
    expect(refs[0].pageId).toBe("queries/query-b");
    expect(refs[0].kind).toBe("index");
  });

  it("a fallback selection of a TYPED entity pageId resolves to <entityType>/<slug>", async () => {
    const root = await seedProject("concept-a", "query-b", "paper-c");
    await stubSelectPages(["papers/paper-c"]);
    const { refs } = await pickSearchRefs(root, "test question");

    expect(refs).toHaveLength(1);
    expect(refs[0].pageId).toBe("papers/paper-c");
  });

  it("a fallback selection of a CONCEPT pageId resolves to concepts/<slug> (regression)", async () => {
    const root = await seedProject("concept-a", "query-b", "paper-c");
    await stubSelectPages(["concepts/concept-a"]);
    const { refs } = await pickSearchRefs(root, "test question");

    expect(refs).toHaveLength(1);
    expect(refs[0].pageId).toBe("concepts/concept-a");
  });

  it("same slug under concepts AND queries enumerates distinctly and each pageId selects independently", async () => {
    const root = await makeTempRoot("f3-collision");
    await mkdir(path.join(root, "wiki/papers"), { recursive: true });
    const slug = "foo";
    await writePage(path.join(root, "wiki/concepts"), slug, { title: "Foo Concept", summary: "s" }, "Concept foo.");
    await writePage(path.join(root, "wiki/queries"), slug, { title: "Foo Query", summary: "s" }, "Query foo.");
    await writeFile(path.join(root, "wiki", "index.md"), "# Knowledge Wiki\n");

    await stubSelectPages(["queries/foo"]);
    const { refs } = await pickSearchRefs(root, "test");

    expect(refs).toHaveLength(1);
    expect(refs[0].pageId).toBe("queries/foo");
  });
});

describe("loadSelectedRefs — fallback refs hydrate the correct page (F3)", () => {
  let pickSearchRefs: typeof import("../src/search/retrieval.js").pickSearchRefs;
  let loadSelectedRefs: typeof import("../src/search/retrieval.js").loadSelectedRefs;

  beforeEach(async () => {
    vi.resetModules();
    ({ pickSearchRefs, loadSelectedRefs } = await import("../src/search/retrieval.js"));
  });
  afterEach(() => vi.restoreAllMocks());

  /** Select one pageId, pick refs, hydrate pages, return the first page's body. */
  async function hydrateFirstBody(root: string, pageId: string): Promise<string> {
    await stubSelectPages([pageId]);
    const { refs } = await pickSearchRefs(root, "test");
    const pages = await loadSelectedRefs(root, refs);
    expect(pages).toHaveLength(1);
    return pages[0].body;
  }

  it("a queries/<slug> fallback ref hydrates from wiki/queries/<slug>.md (NOT concepts)", async () => {
    const root = await seedProject("concept-a", "query-b", "paper-c");
    const body = await hydrateFirstBody(root, "queries/query-b");
    expect(body).toContain("Query body.");
  });

  it("a papers/<slug> fallback ref hydrates from wiki/papers/<slug>.md", async () => {
    const root = await seedProject("concept-a", "query-b", "paper-c");
    const body = await hydrateFirstBody(root, "papers/paper-c");
    expect(body).toContain("Typed body.");
  });
});
