/**
 * Exercise automatic reconciliation against the real embedding core and durable
 * retry files. Only the provider is stubbed, so migration cannot hide a retry
 * regression by pretending that quarantined pages already have vectors.
 */

import { readFile, stat, unlink, writeFile } from "fs/promises";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OpenAIProvider } from "../src/providers/openai.js";
import { refreshEmbeddingsDrainingPending } from "../src/utils/embeddings-refresh.js";
import { acquireLockBlocking, releaseLock } from "../src/utils/lock.js";
import { loadPendingEmbeddings, writePendingEmbeddings } from "../src/utils/pending-embeddings.js";
import { MAX_PENDING_EMBEDDING_ATTEMPTS, QUARANTINED_EMBEDDINGS_FILE } from "../src/utils/constants.js";
import { useCompileProject } from "./fixtures/compile-project.js";
import { readV3Store } from "./fixtures/v3-store.js";
import { fullEmbeddingMarker } from "./fixtures/embedding-marker-capacity.js";

const ctx = useCompileProject({ dirSuffix: "reconciliation-retry" });
const PAGE_ID = "concepts/alpha";

beforeEach(async () => {
  vi.stubEnv("LLMWIKI_EMBEDDINGS", "on");
  vi.stubEnv("LLMWIKI_EMBED_STRICT", "off");
  vi.stubEnv("LLMWIKI_EMBEDDING_PROVIDER", "openai");
  vi.stubEnv("LLMWIKI_EMBEDDING_MODEL", "test-embed");
  vi.stubEnv("OPENAI_API_KEY", "test-key");
  await writePage("alpha");
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => vi.unstubAllEnvs());

/** Seed a live eligible page without invoking page generation. */
async function writePage(slug: string, revision = 1): Promise<void> {
  await writeFile(path.join(ctx.dir, `wiki/concepts/${slug}.md`),
    `---\ntitle: ${slug}\nsummary: ${slug} summary ${revision}\n---\n\n${slug} body ${revision}.\n`);
}

/** Observe the shared drain's project-lock precondition in every refresh. */
async function refresh(ids: string[] = []): Promise<void> {
  await acquireLockBlocking(ctx.dir);
  try {
    await refreshEmbeddingsDrainingPending(ctx.dir, ids);
  } finally {
    await releaseLock(ctx.dir);
  }
}

/** Fail at the provider boundary, after the real core has discovered work. */
function failProvider() {
  return vi.spyOn(OpenAIProvider.prototype, "embedBatch")
    .mockRejectedValue(new Error("embedding backend unavailable"));
}

/** Reach quarantine from the last permitted pending attempt. */
async function quarantinePage(): Promise<void> {
  await writePendingEmbeddings(ctx.dir, [{ pageId: PAGE_ID, attempts: MAX_PENDING_EMBEDDING_ATTEMPTS - 1 }]);
  await refresh();
  expect(await loadPendingEmbeddings(ctx.dir)).toEqual([]);
}

describe("automatic reconciliation retry budget", () => {
  it.each(["count", "bytes"] as const)("keeps exhausted overflow blocked at quarantine %s capacity", async (limit) => {
    const full = fullEmbeddingMarker(limit, MAX_PENDING_EMBEDDING_ATTEMPTS);
    await writePendingEmbeddings(ctx.dir, full, QUARANTINED_EMBEDDINGS_FILE);
    await writePendingEmbeddings(ctx.dir, [{ pageId: PAGE_ID, attempts: MAX_PENDING_EMBEDDING_ATTEMPTS - 1 }]);
    const provider = failProvider();
    await refresh();
    expect(provider).toHaveBeenCalledTimes(1);
    expect(await loadPendingEmbeddings(ctx.dir)).toEqual([{ pageId: PAGE_ID, attempts: MAX_PENDING_EMBEDDING_ATTEMPTS }]);
    await refresh();
    await refresh(["concepts/new-page"]);
    expect(provider).toHaveBeenCalledTimes(1);
    expect(await loadPendingEmbeddings(ctx.dir, QUARANTINED_EMBEDDINGS_FILE)).toEqual(full);
    await refresh([PAGE_ID]);
    expect(provider).toHaveBeenCalledTimes(2);
    expect(await loadPendingEmbeddings(ctx.dir)).toContainEqual({ pageId: PAGE_ID, attempts: 1 });
  });

  it("does not retry a quarantined eligible page on subsequent unchanged refreshes", async () => {
    const provider = failProvider();
    await quarantinePage();
    const attempted = provider.mock.calls.length;
    expect(attempted).toBeGreaterThan(0);

    await refresh();
    await refresh();

    expect(provider).toHaveBeenCalledTimes(attempted);
    expect(await loadPendingEmbeddings(ctx.dir, QUARANTINED_EMBEDDINGS_FILE)).toEqual([
      { pageId: PAGE_ID, attempts: MAX_PENDING_EMBEDDING_ATTEMPTS },
    ]);
  });

  it("records automatically discovered work before calling the provider", async () => {
    const recorded: Awaited<ReturnType<typeof loadPendingEmbeddings>>[] = [];
    const provider = failProvider().mockImplementation(async () => {
      recorded.push(await loadPendingEmbeddings(ctx.dir));
      throw new Error("embedding backend unavailable");
    });
    await refresh();
    expect(provider).toHaveBeenCalled();
    expect(recorded.every((entries) => entries.length === 1 && entries[0].pageId === PAGE_ID && entries[0].attempts === 0)).toBe(true);
    expect(await loadPendingEmbeddings(ctx.dir)).toEqual([{ pageId: PAGE_ID, attempts: 1 }]);
  });

  it("bounds failures of backfill discovered with no initial pending entry", async () => {
    const provider = failProvider();
    for (let attempt = 0; attempt < MAX_PENDING_EMBEDDING_ATTEMPTS; attempt++) await refresh();
    const attempted = provider.mock.calls.length;
    await refresh();
    await refresh();
    expect(provider).toHaveBeenCalledTimes(attempted);
    expect(await loadPendingEmbeddings(ctx.dir)).toEqual([]);
    expect(await loadPendingEmbeddings(ctx.dir, QUARANTINED_EMBEDDINGS_FILE)).toHaveLength(1);
  });

  it("embeds a healthy page while leaving an unrelated quarantine excluded", async () => {
    const provider = failProvider();
    await quarantinePage();
    provider.mockClear().mockImplementation(async (texts) => {
      expect(texts.every((text) => !text.includes("alpha"))).toBe(true);
      return texts.map(() => [0.5, 0.5]);
    });
    await writePage("healthy");
    await refresh(["concepts/healthy"]);
    expect(provider).toHaveBeenCalled();
    expect((await readV3Store(ctx.dir))?.entries.map((entry) => entry.pageId)).toEqual(["concepts/healthy"]);
    expect(await loadPendingEmbeddings(ctx.dir)).toEqual([]);
  });

  it("releases quarantine for an explicit page change with a fresh attempt budget", async () => {
    const provider = failProvider();
    await quarantinePage();
    provider.mockClear();
    await refresh([PAGE_ID]);
    expect(provider).toHaveBeenCalled();
    expect(await loadPendingEmbeddings(ctx.dir)).toEqual([{ pageId: PAGE_ID, attempts: 1 }]);
    expect(await loadPendingEmbeddings(ctx.dir, QUARANTINED_EMBEDDINGS_FILE)).toEqual([]);
  });

  it("settles newly discovered failures before rethrowing in strict mode", async () => {
    failProvider();
    vi.stubEnv("LLMWIKI_EMBED_STRICT", "on");
    await expect(refresh()).rejects.toThrow("embedding backend unavailable");
    expect(await loadPendingEmbeddings(ctx.dir)).toEqual([{ pageId: PAGE_ID, attempts: 1 }]);
  });

  it("honors quarantine left alongside a pending entry by an interrupted settlement", async () => {
    const provider = failProvider();
    await quarantinePage();
    await writePendingEmbeddings(ctx.dir, [{ pageId: PAGE_ID, attempts: MAX_PENDING_EMBEDDING_ATTEMPTS - 1 }]);
    provider.mockClear();
    await refresh();
    expect(provider).not.toHaveBeenCalled();
    expect(await loadPendingEmbeddings(ctx.dir)).toEqual([]);
    await refresh([PAGE_ID]);
    expect(await loadPendingEmbeddings(ctx.dir)).toEqual([{ pageId: PAGE_ID, attempts: 1 }]);
  });

  it("does not release or rewrite quarantine while refreshes are disabled", async () => {
    const provider = failProvider();
    await quarantinePage();
    const quarantined = await loadPendingEmbeddings(ctx.dir, QUARANTINED_EMBEDDINGS_FILE);
    provider.mockClear();
    vi.stubEnv("LLMWIKI_EMBEDDINGS", "off");
    await refresh([PAGE_ID]);
    expect(provider).not.toHaveBeenCalled();
    expect(await loadPendingEmbeddings(ctx.dir, QUARANTINED_EMBEDDINGS_FILE)).toEqual(quarantined);
  });
});

/** Store a real page and chunk vector, then make both stale without regenerating them. */
async function staleCache() {
  const provider = vi.spyOn(OpenAIProvider.prototype, "embedBatch")
    .mockImplementation(async texts => texts.map(() => [0.5, 0.5]));
  await refresh();
  const old = (await readV3Store(ctx.dir))!;
  expect(old.entries).toHaveLength(1);
  expect(old.chunks?.length).toBeGreaterThan(0);
  await writePage("alpha", 2);
  provider.mockClear();
  return { provider, old };
}

/** Fill the retry budget, optionally letting a real healthy page own the first slot. */
async function fillBudget(healthy = false, limit: "count" | "bytes" = "count") {
  const full = fullEmbeddingMarker(limit, 1);
  if (healthy) {
    await writePage("healthy");
    full[0] = { pageId: "concepts/healthy", attempts: 1 };
  }
  await writePendingEmbeddings(ctx.dir, full);
  return full;
}

/** Compare cached records, including original hashes and timestamps, rather than just vectors. */
async function expectAlphaCache(old: NonNullable<Awaited<ReturnType<typeof readV3Store>>>) {
  const store = (await readV3Store(ctx.dir))!;
  expect(store.entries.filter(e => e.pageId === PAGE_ID)).toEqual(old.entries);
  expect(store.chunks?.filter(e => e.pageId === PAGE_ID)).toEqual(old.chunks);
}

describe("deferred reconciliation", () => {
  it.each(["count", "bytes"] as const)("retains stale cache without a store write at %s capacity, then recovers", async limit => {
    const { provider, old } = await staleCache();
    await fillBudget(false, limit);
    const file = path.join(ctx.dir, ".llmwiki/embeddings.json");
    const before = { bytes: await readFile(file), mtime: (await stat(file)).mtimeMs };
    await refresh([PAGE_ID]);
    expect(provider).not.toHaveBeenCalled();
    await expectAlphaCache(old);
    expect(await readFile(file)).toEqual(before.bytes);
    expect((await stat(file)).mtimeMs).toBe(before.mtime);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("1 page(s) deferred"));
    await writePendingEmbeddings(ctx.dir, []);
    await refresh();
    expect(provider).toHaveBeenCalled();
    expect((await readV3Store(ctx.dir))!.entries[0].embeddingTextHash).not.toBe(old.entries[0].embeddingTextHash);
  });

  it("persists admitted work and preserves deferred cache before strict mode throws", async () => {
    const { provider, old } = await staleCache();
    const full = await fillBudget(true);
    vi.stubEnv("LLMWIKI_EMBED_STRICT", "on");
    await expect(refresh()).rejects.toThrow("1 page(s) deferred");
    expect(provider).toHaveBeenCalled();
    expect(provider.mock.calls.flatMap(call => call[0]).every(text => text.includes("healthy"))).toBe(true);
    await expectAlphaCache(old);
    expect((await readV3Store(ctx.dir))!.entries.map(e => e.pageId)).toContain("concepts/healthy");
    expect(await loadPendingEmbeddings(ctx.dir)).toEqual(full.slice(1).map(e => ({ ...e, attempts: 2 })));
  });

  it("also retains cached vectors for quarantined pages without a capacity warning", async () => {
    const { provider, old } = await staleCache();
    await writePendingEmbeddings(ctx.dir, [{ pageId: PAGE_ID, attempts: 5 }], QUARANTINED_EMBEDDINGS_FILE);
    await refresh();
    expect(provider).not.toHaveBeenCalled();
    await expectAlphaCache(old);
    expect(console.log).not.toHaveBeenCalledWith(expect.stringContaining("page(s) deferred"));
  });

  it.each(["backend", "deleted", "orphaned", "invalid-vector"])("does not retain %s cache when deferred", async reason => {
    const { provider, old } = await staleCache();
    await fillBudget();
    if (reason === "backend") vi.stubEnv("LLMWIKI_EMBEDDING_MODEL", "different-model");
    if (reason === "deleted") await unlink(path.join(ctx.dir, "wiki/concepts/alpha.md"));
    if (reason === "orphaned") await writeFile(path.join(ctx.dir, "wiki/concepts/alpha.md"),
      "---\ntitle: alpha\nsummary: alpha\norphaned: true\n---\nalpha body\n");
    if (reason === "invalid-vector") {
      old.entries[0].vector = [1];
      await writeFile(path.join(ctx.dir, ".llmwiki/embeddings.json"), JSON.stringify(old));
    }
    await refresh();
    expect(provider).not.toHaveBeenCalled();
    const store = (await readV3Store(ctx.dir))!;
    expect(store.entries).toEqual([]);
    expect(store.chunks).toEqual([]);
  });
});
