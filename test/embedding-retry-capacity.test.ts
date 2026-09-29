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
const HASH = "0123456789abcdef";

/** Live content hashes as the core would supply them; the value only has to be stable. */
function hashes(ids: string[]): Map<string, string> {
  return new Map(ids.map(id => [id, HASH]));
}

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
    const ids = [...full.map(e => e.pageId), FRESH];
    const allowed = await retry.prepare(ids, hashes(ids));
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
    const allowed = await retry.prepare([full[0].pageId, FRESH], hashes([full[0].pageId, FRESH]));
    // Charging in place binds the entry to its content. At the count cap that
    // needs no new slot; at the byte cap the hash itself would overflow, so the
    // page is deferred rather than evict a neighbour.
    const charged = { ...full[0], attempts: 2, contentHash: HASH };
    const expected = limit === "count" ? [charged, ...full.slice(1)] : full;
    expect(allowed).toEqual(limit === "count" ? [full[0].pageId] : []);
    expect(await loadPendingEmbeddings(ctx.dir)).toEqual(expected);
  });
});
