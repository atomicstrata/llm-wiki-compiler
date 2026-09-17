/**
 * Real-core affected-only refresh tests: only provider calls are stubbed. Global
 * migration must not discover or prune unrelated vectors, and pending/quarantine
 * records outside the explicit scope keep their budgets on every outcome.
 */
import { readFile, unlink, writeFile } from "fs/promises";
import path from "path";
import { beforeEach, expect, it, vi } from "vitest";
import { OpenAIProvider } from "../src/providers/openai.js";
import { refreshAffectedEmbeddings, refreshEmbeddingsDrainingPending } from "../src/utils/embeddings-refresh.js";
import { acquireLockBlocking, releaseLock } from "../src/utils/lock.js";
import { loadPendingEmbeddings, writePendingEmbeddings } from "../src/utils/pending-embeddings.js";
import { MAX_PENDING_EMBEDDING_ATTEMPTS, PENDING_EMBEDDINGS_FILE, QUARANTINED_EMBEDDINGS_FILE } from "../src/utils/constants.js";
import { useCompileProject } from "./fixtures/compile-project.js";
import { readV3Store } from "./fixtures/v3-store.js";
import { fullEmbeddingMarker } from "./fixtures/embedding-marker-capacity.js";
import { approveBatch, stageBatchCandidate } from "./fixtures/review-batch.js";
import { useEmbeddingRefreshEnvironment, writeEmbeddingTestPage } from "./fixtures/embedding-refresh.js";

const ctx = useCompileProject({ dirSuffix: "scoped-embeddings" });
const ALPHA = "concepts/alpha";
const BACKLOG = "concepts/backlog";
const LAST_ATTEMPT = MAX_PENDING_EMBEDDING_ATTEMPTS - 1;
const UNRELATED_QUARANTINE = [{ pageId: "concepts/quarantined", attempts: MAX_PENDING_EMBEDDING_ATTEMPTS }];
useEmbeddingRefreshEnvironment();

beforeEach(async () => {
  await writePage("alpha");
  await writePage("backlog");
});

/** Seed or change a live page independently of its embedding cache. */
async function writePage(slug: string, revision = 1): Promise<void> {
  await writeEmbeddingTestPage(ctx.dir, slug, revision);
}

/** Respect the production lock precondition around the complete refresh lifecycle. */
async function refresh(ids: string[] = [ALPHA], full = false): Promise<void> {
  await acquireLockBlocking(ctx.dir);
  try {
    await (full ? refreshEmbeddingsDrainingPending : refreshAffectedEmbeddings)(ctx.dir, ids);
  } finally {
    await releaseLock(ctx.dir);
  }
}

/** Use deterministic vectors while recording every provider input. */
function successfulProvider() {
  return vi.spyOn(OpenAIProvider.prototype, "embedBatch").mockImplementation(async texts => texts.map(() => [0.5, 0.5]));
}

/** Seed unrelated active/exhausted retry records and durable exclusions. */
async function seedRetryState(selectedAttempts = 0): Promise<void> {
  await writePendingEmbeddings(ctx.dir, [
    { pageId: BACKLOG, attempts: LAST_ATTEMPT },
    { pageId: "concepts/exhausted", attempts: MAX_PENDING_EMBEDDING_ATTEMPTS },
    { pageId: ALPHA, attempts: selectedAttempts },
  ]);
  await writePendingEmbeddings(ctx.dir, UNRELATED_QUARANTINE, QUARANTINED_EMBEDDINGS_FILE);
}

/** Assert unrelated active and exhausted records kept their exact retry counts. */
async function expectUnrelatedBudgets(): Promise<void> {
  expect((await loadPendingEmbeddings(ctx.dir)).filter(entry => entry.pageId !== ALPHA)).toEqual([
    { pageId: BACKLOG, attempts: LAST_ATTEMPT },
    { pageId: "concepts/exhausted", attempts: MAX_PENDING_EMBEDDING_ATTEMPTS },
  ]);
}

it("embeds only affected pages and leaves unrelated budgets and quarantines unchanged on success", async () => {
  const provider = successfulProvider();
  await seedRetryState();
  await refresh();
  expect(provider.mock.calls.flatMap(([texts]) => texts).every(text => text.includes("alpha"))).toBe(true);
  expect((await readV3Store(ctx.dir))!.entries.map(entry => entry.pageId)).toEqual([ALPHA]);
  await expectUnrelatedBudgets();
  expect(await loadPendingEmbeddings(ctx.dir, QUARANTINED_EMBEDDINGS_FILE)).toEqual(UNRELATED_QUARANTINE);
});

it("charges only affected pending IDs when the provider fails", async () => {
  vi.spyOn(OpenAIProvider.prototype, "embedBatch").mockRejectedValue(new Error("backend failure"));
  await seedRetryState();
  await refresh();
  await expectUnrelatedBudgets();
  expect(await loadPendingEmbeddings(ctx.dir)).toContainEqual({ pageId: ALPHA, attempts: 1 });
  expect(await loadPendingEmbeddings(ctx.dir, QUARANTINED_EMBEDDINGS_FILE)).toEqual(UNRELATED_QUARANTINE);
});

it("quarantines only an affected exhausted ID and preserves unrelated exhausted pending records", async () => {
  vi.spyOn(OpenAIProvider.prototype, "embedBatch").mockRejectedValue(new Error("backend failure"));
  await seedRetryState(LAST_ATTEMPT);
  await refresh();
  await expectUnrelatedBudgets();
  expect(await loadPendingEmbeddings(ctx.dir, QUARANTINED_EMBEDDINGS_FILE)).toEqual([
    ...UNRELATED_QUARANTINE, { pageId: ALPHA, attempts: MAX_PENDING_EMBEDDING_ATTEMPTS },
  ]);
});

it("preserves stale and deleted unrelated page/chunk vectors without global migration", async () => {
  const provider = successfulProvider();
  await writePage("deleted");
  await refresh([], true);
  const before = (await readV3Store(ctx.dir))!;
  await writePage("backlog", 2);
  await unlink(path.join(ctx.dir, "wiki/concepts/deleted.md"));
  provider.mockClear();
  await refresh();
  const after = (await readV3Store(ctx.dir))!;
  expect(after.entries.filter(entry => entry.pageId !== ALPHA)).toEqual(before.entries.filter(entry => entry.pageId !== ALPHA));
  expect(after.chunks?.filter(entry => entry.pageId !== ALPHA)).toEqual(before.chunks?.filter(entry => entry.pageId !== ALPHA));
  expect(provider.mock.calls.flatMap(([texts]) => texts).every(text => text.includes("alpha"))).toBe(true);
});

it.each(["count", "bytes"] as const)("defers new work without evicting unrelated retry records at %s capacity", async limit => {
  const provider = successfulProvider();
  const pending = fullEmbeddingMarker(limit, 1);
  await writePendingEmbeddings(ctx.dir, pending);
  await refresh();
  expect(provider).not.toHaveBeenCalled();
  expect(await loadPendingEmbeddings(ctx.dir)).toEqual(pending);
  expect(await readV3Store(ctx.dir)).toBeNull();
  expect(console.log).toHaveBeenCalledWith(expect.stringContaining("1 page(s) deferred"));
});

it.each(["legacy", "backend", "corrupt"])("defers a %s store without changing its bytes or embedding unrelated pages", async kind => {
  const provider = successfulProvider();
  await refresh([], true);
  const file = path.join(ctx.dir, ".llmwiki/embeddings.json");
  const store = JSON.parse(await readFile(file, "utf8"));
  if (kind === "legacy") store.version = 2;
  if (kind === "backend") store.fingerprint = "different-backend";
  const before = kind === "corrupt" ? "invalid-json" : JSON.stringify(store);
  await writeFile(file, before);
  provider.mockClear();
  await refresh();
  expect(provider).not.toHaveBeenCalled();
  expect(await readFile(file, "utf8")).toBe(before);
  expect(await loadPendingEmbeddings(ctx.dir)).toEqual([{ pageId: ALPHA, attempts: 1 }]);
});

it("leaves unreadable retry state untouched instead of replacing unrelated recovery data", async () => {
  const provider = successfulProvider();
  const file = path.join(ctx.dir, PENDING_EMBEDDINGS_FILE);
  await writeFile(file, "{malformed");
  await refresh();
  expect(provider).not.toHaveBeenCalled();
  expect(await readFile(file, "utf8")).toBe("{malformed");
});

it("includes pages actually rewritten by the batch linker but excludes unrelated retries", async () => {
  const provider = successfulProvider();
  await writePendingEmbeddings(ctx.dir, [{ pageId: BACKLOG, attempts: LAST_ATTEMPT }]);
  await writeFile(path.join(ctx.dir, "wiki/concepts/linked.md"), "---\ntitle: Linked Page\n---\nNovel Topic.\n");
  const candidate = await stageBatchCandidate(ctx.dir, "novel", { body: "---\ntitle: Novel Topic\n---\nNew text.\n" });
  const result = await approveBatch(ctx.dir, candidate.id);
  expect(result.status).toBe("completed");
  expect((await readV3Store(ctx.dir))!.entries.map(entry => entry.pageId).sort()).toEqual(["concepts/linked", "concepts/novel"]);
  expect(provider.mock.calls.flatMap(([texts]) => texts).some(text => text.includes("backlog"))).toBe(false);
  expect(await loadPendingEmbeddings(ctx.dir)).toEqual([{ pageId: BACKLOG, attempts: LAST_ATTEMPT }]);
});
