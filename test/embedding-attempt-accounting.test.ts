/**
 * Real-core witnesses that retry budgets charge actual provider attempts, bound
 * to the content that was sent. Only the provider (and, for one witness, the
 * store write) is stubbed. With a batch size of one, every page is its own
 * provider request, so each case can tell sent, failed and unsent pages apart.
 *
 * The failing store write is injected at the PHYSICAL seam: the exported
 * `replaceLeafAtomicWithin`, which the store writer's disk binding calls
 * across modules. Only the project's own embedding store leaves (JSON or
 * binary, compared as native paths) are refused; every other replacement,
 * including the retry markers, goes to the real primitive. The writer reaches
 * the store through its bound body, not the root `writeEmbeddingStore`, so a
 * spy on that facade would no longer see the write.
 */
import path from "node:path";
import { beforeEach, expect, it, vi } from "bun:test";
import { stubEnv } from "./stubs.js";
import { OpenAIProvider } from "../src/providers/openai.js";
import * as guarded from "../src/storage/disk-guarded-leaves.js";
import {
  EMBEDDINGS_FILE, LLMWIKI_DIR, MAX_PENDING_EMBEDDING_ATTEMPTS as MAX, PENDING_EMBEDDINGS_FILE, QUARANTINED_EMBEDDINGS_FILE,
} from "../src/utils/constants.js";
import { loadPendingEmbeddings } from "../src/utils/pending-embeddings.js";
import { useCompileProject } from "./fixtures/compile-project.js";
import { expectChunksCurrent, liveContentHash } from "./fixtures/embedding-chunks.js";
import { useEmbeddingRefreshEnvironment, writeEmbeddingTestPage } from "./fixtures/embedding-refresh.js";
import { drainUnderLock, swallowMarkerWrites } from "./fixtures/embedding-retry-state.js";

const ctx = useCompileProject({ dirSuffix: "attempt-accounting" });
const PAGES = ["a-healthy", "b-poison", "c-later"];
useEmbeddingRefreshEnvironment();

beforeEach(async () => {
  stubEnv("LLMWIKI_EMBED_BATCH_SIZE", "1");
  for (const slug of PAGES) await writeEmbeddingTestPage(ctx.dir, slug);
});

/** Run the shared drain under the project lock its callers hold. */
function refresh(): Promise<void> {
  return drainUnderLock(ctx.dir);
}

/** Attempts recorded per page, keyed by slug (absent pages omitted). */
async function attempts(file?: typeof QUARANTINED_EMBEDDINGS_FILE): Promise<Record<string, number>> {
  const entries = await loadPendingEmbeddings(ctx.dir, file);
  return Object.fromEntries(entries.map(e => [e.pageId.replace("concepts/", ""), e.attempts]));
}

/** Fail every request whose texts mention `slug`, embedding everything else. */
function failRequestsFor(slug: string, error: Error = new Error("rejected input")) {
  return vi.spyOn(OpenAIProvider.prototype, "embedBatch").mockImplementation(async texts => {
    if (texts.some(text => text.includes(slug))) throw error;
    return texts.map(() => [0.5, 0.5]);
  });
}

it("charges only the page in the failing request; later pages were never sent", async () => {
  const provider = failRequestsFor("b-poison");
  await refresh();
  const sent = provider.mock.calls.flatMap(call => call[0]);
  expect(sent.some(text => text.includes("c-later"))).toBe(false);
  expect(await attempts()).toEqual({ "a-healthy": 0, "b-poison": 1, "c-later": 0 });
});

it("charges only the failing chunk request's page after the page pass succeeded", async () => {
  let calls = 0;
  vi.spyOn(OpenAIProvider.prototype, "embedBatch").mockImplementation(async texts => {
    calls += 1;
    if (calls > PAGES.length && texts.some(text => text.includes("c-later"))) throw new Error("rejected chunk");
    return texts.map(() => [0.5, 0.5]);
  });
  await refresh();
  expect(await attempts()).toEqual({ "a-healthy": 0, "b-poison": 0, "c-later": 1 });
});

it("charges only the terminally failing single request after a transient batch fallback", async () => {
  stubEnv("LLMWIKI_EMBED_BATCH_SIZE", "10");
  const transient = Object.assign(new Error("service unavailable"), { status: 503 });
  vi.spyOn(OpenAIProvider.prototype, "embedBatch").mockRejectedValue(transient);
  vi.spyOn(OpenAIProvider.prototype, "embed").mockImplementation(async text => {
    if (text.includes("b-poison")) throw Object.assign(new Error("bad input"), { status: 400 });
    return [0.5, 0.5];
  });
  await refresh();
  expect(await attempts()).toEqual({ "a-healthy": 0, "b-poison": 1, "c-later": 0 });
});

it("charges nobody when the run fails before any provider request, and still reports it", async () => {
  stubEnv("OPENAI_API_KEY", "");
  const provider = vi.spyOn(OpenAIProvider.prototype, "embedBatch");
  await refresh();
  expect(provider).not.toHaveBeenCalled();
  expect(Object.values(await attempts())).toEqual([0, 0, 0]);
  stubEnv("LLMWIKI_EMBED_STRICT", "on");
  await expect(refresh()).rejects.toThrow();
});

// The bounded-paid-work invariant: provider requests all succeed but the store
// write always fails. Sent pages must stay charged, so paid work stops.
it("stops paying for work that can never be persisted", async () => {
  const provider = vi.spyOn(OpenAIProvider.prototype, "embedBatch").mockImplementation(async texts => texts.map(() => [0.5, 0.5]));
  const refused = refuseStorePublication(new Error("disk full"));
  for (let round = 0; round < MAX; round++) await refresh();
  expect(refused.length).toBeGreaterThan(0);
  expect(Object.keys(await attempts(QUARANTINED_EMBEDDINGS_FILE)).sort()).toEqual(PAGES);
  const paid = provider.mock.calls.length;
  await refresh();
  await refresh();
  expect(provider).toHaveBeenCalledTimes(paid);
});

/** Refuse every atomic replacement of this project's embedding store leaves with `error`, delegating all others; returns the refused leaves. */
function refuseStorePublication(error: Error): string[] {
  const real = guarded.replaceLeafAtomicWithin;
  const storeLeaves = new Set([EMBEDDINGS_FILE, `${LLMWIKI_DIR}/embeddings.bin`].map(rel => path.join(ctx.dir, rel)));
  const refused: string[] = [];
  vi.spyOn(guarded, "replaceLeafAtomicWithin").mockImplementation(async (confineRoot, leaf, content) => {
    if (!storeLeaves.has(path.normalize(leaf))) return real(confineRoot, leaf, content);
    refused.push(leaf);
    throw error;
  });
  return refused;
}

it("refunds a healthy page aborted by another page's failure, then persists it once the poison is quarantined", async () => {
  failRequestsFor("b-poison");
  for (let round = 0; round < MAX; round++) {
    await refresh();
    expect((await attempts())["a-healthy"]).toBe(0);
  }
  expect(await attempts(QUARANTINED_EMBEDDINGS_FILE)).toEqual({ "b-poison": MAX });
  await refresh();
  expect(await attempts()).toEqual({});
  await expectChunksCurrent(ctx.dir, "concepts/a-healthy", true);
  await expectChunksCurrent(ctx.dir, "concepts/c-later", true);
});

it("charges the content that was sent, so an edit during the request starts a fresh budget", async () => {
  const sentHash = await liveContentHash(ctx.dir, "concepts/b-poison");
  let edited = false;
  vi.spyOn(OpenAIProvider.prototype, "embedBatch").mockImplementation(async texts => {
    if (!texts.some(text => text.includes("b-poison"))) return texts.map(() => [0.5, 0.5]);
    if (!edited) {
      edited = true;
      await writeEmbeddingTestPage(ctx.dir, "b-poison", 2);
    }
    throw new Error("rejected input");
  });
  await refresh();
  const charged = (await loadPendingEmbeddings(ctx.dir)).find(e => e.pageId === "concepts/b-poison");
  expect(charged).toEqual({ pageId: "concepts/b-poison", attempts: 1, contentHash: sentHash });
  await refresh();
  const next = (await loadPendingEmbeddings(ctx.dir)).find(e => e.pageId === "concepts/b-poison");
  expect(next).toEqual({ pageId: "concepts/b-poison", attempts: 1, contentHash: await liveContentHash(ctx.dir, "concepts/b-poison") });
});

it("settles once: a failed settlement write is reported, never followed by a second settlement", async () => {
  vi.spyOn(OpenAIProvider.prototype, "embedBatch").mockImplementation(async texts => texts.map(() => [0.5, 0.5]));
  // A successful run settles by clearing the pending file; refuse exactly that unlink. The pre-charges still persist.
  swallowMarkerWrites(PENDING_EMBEDDINGS_FILE, ["remove"]);
  stubEnv("LLMWIKI_EMBED_STRICT", "on");
  await expect(refresh()).rejects.toThrow(/could not be settled/);
  expect(Object.values(await attempts())).toEqual([1, 1, 1]);
});
