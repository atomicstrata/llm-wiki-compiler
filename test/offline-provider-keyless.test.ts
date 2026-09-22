/**
 * @file The shipped keyless path, end to end and unmocked: under
 * `LLMWIKI_PROVIDER=offline` with every credential variable removed, two pages
 * applied OUT of band and enqueued in the pending-embeddings marker (exactly what
 * a bundle apply records) are indexed AND embedded by `compile`, and a query is
 * answered grounded on the
 * page whose words overlap the question — retrieved through the chunk path,
 * never the tool-calling fallback. No `vi.mock`, no spy, no network.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmod, mkdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createWiki } from "../src/index.js";
import { loadPendingEmbeddings, mergeFreshAttempts, writePendingEmbeddings } from "../src/utils/pending-embeddings.js";

const CREDENTIAL_VARS = /_API_KEY$|_AUTH_TOKEN$|^GITHUB_TOKEN$/;
const PAGE_IDS = ["concepts/sparse-attention", "concepts/sourdough-bread"] as const;
const saved = { ...process.env };
let root = "";

async function twoPageProject(): Promise<string> {
  const dir = path.join(os.tmpdir(), `llmwiki-offline-${process.pid}-${Date.now()}`);
  await mkdir(path.join(dir, "sources"), { recursive: true });
  await mkdir(path.join(dir, "wiki", "concepts"), { recursive: true });
  await mkdir(path.join(dir, ".llmwiki"), { recursive: true });
  await writeFile(path.join(dir, "wiki", "concepts", "sparse-attention.md"), "---\ntitle: Sparse attention\n---\n\nSparse attention keeps long contexts tractable by attending to a subset of tokens.\n");
  await writeFile(path.join(dir, "wiki", "concepts", "sourdough-bread.md"), "---\ntitle: Sourdough bread\n---\n\nSourdough bread needs a long, cool fermentation and a hot oven.\n");
  return dir;
}

beforeEach(async () => {
  for (const key of Object.keys(process.env)) if (CREDENTIAL_VARS.test(key)) delete process.env[key];
  process.env.LLMWIKI_PROVIDER = "offline";
  root = await twoPageProject();
});
afterEach(async () => {
  process.env = { ...saved };
  await rm(root, { recursive: true, force: true });
});

describe("offline provider — the shipped keyless path", () => {
  it("compile drains the pending marker, embeds the pages, and answers a query grounded on the lexically matching page, with no credential and no mock", async () => {
    expect(Object.keys(process.env).filter((k) => CREDENTIAL_VARS.test(k))).toEqual([]);
    await writePendingEmbeddings(root, mergeFreshAttempts(await loadPendingEmbeddings(root), [...PAGE_IDS]));
    const wiki = createWiki({ root });
    await wiki.compile(); // drains the marker under the offline provider
    expect(await loadPendingEmbeddings(root)).toEqual([]);
    const store = JSON.parse(await readFile(path.join(root, ".llmwiki", "embeddings.json"), "utf8")) as { model: string; dimensions: number; chunks: unknown[] };
    expect(store).toMatchObject({ model: "offline-bow-64", dimensions: 64 });
    expect(store.chunks).toHaveLength(2);
    const answer = await wiki.query("how does sparse attention handle long contexts");
    // The chunk path ranked the overlapping page FIRST; the fallback would have selected nothing.
    expect(answer.pageIds[0]).toBe("concepts/sparse-attention");
    expect(answer.reasoning).toMatch(/reranked chunks/);
    expect(answer.answer.trim().length).toBeGreaterThan(0);
  }, 120_000);

  it("STORE-PRUNES-ON-DRAIN: a delete tombstone makes the next compile drop the page's entries and chunks, and settles the marker", async () => {
    await writePendingEmbeddings(root, mergeFreshAttempts(await loadPendingEmbeddings(root), [...PAGE_IDS]));
    const wiki = createWiki({ root });
    await wiki.compile();
    const storePath = path.join(root, ".llmwiki", "embeddings.json");
    expect((JSON.parse(await readFile(storePath, "utf8")) as { chunks: unknown[] }).chunks).toHaveLength(2);
    // The page is deleted and its tombstone enqueued — exactly what a delete apply records.
    await unlink(path.join(root, "wiki", "concepts", "sourdough-bread.md"));
    await writePendingEmbeddings(root, mergeFreshAttempts(await loadPendingEmbeddings(root), ["concepts/sourdough-bread"]));
    await wiki.compile();
    const store = JSON.parse(await readFile(storePath, "utf8")) as { entries: { pageId: string }[]; chunks: { pageId: string }[] };
    expect(store.entries.map((e) => e.pageId)).toEqual(["concepts/sparse-attention"]);
    expect(store.chunks.map((c) => c.pageId)).toEqual(["concepts/sparse-attention"]);
    expect(await loadPendingEmbeddings(root)).toEqual([]);
  }, 120_000);

  it("NEVER-INDEXED-TOMBSTONE: a tombstone for a page the store never held settles on the first drain", async () => {
    await writePendingEmbeddings(root, mergeFreshAttempts(await loadPendingEmbeddings(root), ["concepts/never-indexed"]));
    await createWiki({ root }).compile();
    expect(await loadPendingEmbeddings(root)).toEqual([]);
  }, 120_000);

  it("INELIGIBLE-NOT-SETTLED: a live page that is ineligible today keeps its retry and is embedded once eligible", async () => {
    const page = path.join(root, "wiki", "concepts", "later.md");
    await writeFile(page, "---\ntitle: Later\norphaned: true\n---\n\nSparse attention, revisited later.\n");
    await writePendingEmbeddings(root, mergeFreshAttempts(await loadPendingEmbeddings(root), ["concepts/later"]));
    const wiki = createWiki({ root });
    await wiki.compile();
    // Still pending (a retry, attempts bumped) — NOT settled as if deleted.
    expect((await loadPendingEmbeddings(root)).map((e) => e.pageId)).toEqual(["concepts/later"]);
    await writeFile(page, "---\ntitle: Later\n---\n\nSparse attention, revisited later.\n");
    await wiki.compile();
    expect(await loadPendingEmbeddings(root)).toEqual([]);
    const store = JSON.parse(await readFile(path.join(root, ".llmwiki", "embeddings.json"), "utf8")) as { chunks: { pageId: string }[] };
    expect(store.chunks.some((c) => c.pageId === "concepts/later")).toBe(true);
  }, 120_000);

  it("UNAVAILABLE-EXISTENCE: a page whose existence cannot be read (EACCES on its parent) keeps its retry, never settled as deleted", async () => {
    const dir = path.join(root, "wiki", "concepts");
    await writeFile(path.join(dir, "later.md"), "---\ntitle: Later\norphaned: true\n---\n\nSparse attention, revisited later.\n");
    await writePendingEmbeddings(root, mergeFreshAttempts(await loadPendingEmbeddings(root), ["concepts/later"]));
    await chmod(dir, 0o000);
    try {
      await createWiki({ root }).compile().catch(() => undefined); // the drain may skip; it must not settle
    } finally {
      await chmod(dir, 0o755);
    }
    expect((await loadPendingEmbeddings(root)).map((e) => e.pageId)).toEqual(["concepts/later"]);
  }, 120_000);

  it("CROSS-PROVIDER-REBUILD: a store built by a wider model is rebuilt at the offline width, not refused", async () => {
    const storePath = path.join(root, ".llmwiki", "embeddings.json");
    const wide = { version: 3, model: "text-embedding-3-small", dimensions: 1536, entries: [], chunks: [] };
    await writeFile(storePath, JSON.stringify(wide));
    await writePendingEmbeddings(root, mergeFreshAttempts(await loadPendingEmbeddings(root), [...PAGE_IDS]));
    await createWiki({ root }).compile();
    const store = JSON.parse(await readFile(storePath, "utf8")) as { model: string; dimensions: number; chunks: unknown[] };
    expect(store).toMatchObject({ model: "offline-bow-64", dimensions: 64 });
    expect(store.chunks).toHaveLength(2);
    expect(await loadPendingEmbeddings(root)).toEqual([]);
  }, 120_000);
});
