/** Real marker I/O witnesses: no work may spend or forget a budget outside durable capacity. */
import { describe, expect, it } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadEmbeddingRetry } from "../src/utils/embeddings-retry.js";
import { loadPendingEmbeddings, writePendingEmbeddings } from "../src/utils/pending-embeddings.js";
import { useCompileProject } from "./fixtures/compile-project.js";
import { fullEmbeddingMarker } from "./fixtures/embedding-marker-capacity.js";

const ctx = useCompileProject({ dirSuffix: "retry-capacity" });
const FRESH = "concepts/fresh";

it("does not clear an unreadable marker when there is no computed pending work", async () => {
  const file = path.join(ctx.dir, ".llmwiki/pending-embeddings.json");
  await writeFile(file, "{broken");
  const retry = await loadEmbeddingRetry(ctx.dir, []);
  await retry.recordPending();
  expect(await readFile(file, "utf8")).toBe("{broken");
});

describe.each(["count", "bytes"] as const)("pending %s capacity", (limit) => {
  it("returns only discovered ids with persisted budgets", async () => {
    const full = fullEmbeddingMarker(limit, 0);
    const retry = await loadEmbeddingRetry(ctx.dir, []);
    const allowed = await retry.prepare([...full.map(e => e.pageId), FRESH]);
    const persisted = await loadPendingEmbeddings(ctx.dir);
    expect(allowed).toEqual(persisted.map(e => e.pageId));
    expect(allowed).not.toContain(FRESH);
    expect(allowed.length).toBeGreaterThan(0);
  });

  it("does not evict charged budgets to admit newly changed pages", async () => {
    const full = fullEmbeddingMarker(limit, 1);
    await writePendingEmbeddings(ctx.dir, full);
    const retry = await loadEmbeddingRetry(ctx.dir, [FRESH]);
    await retry.recordPending();
    const allowed = await retry.prepare([full[0].pageId, FRESH]);
    expect(allowed).toEqual([full[0].pageId]);
    expect(await loadPendingEmbeddings(ctx.dir)).toEqual(full);
  });
});
