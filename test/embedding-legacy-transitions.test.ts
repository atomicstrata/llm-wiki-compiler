/**
 * Legacy exclusions (written before content hashing) get one bounded grant, and
 * interrupted marker transitions never double a grant, lose an exclusion, or
 * make retries unbounded. Real core and marker I/O; only the provider and, where
 * a case needs it, one marker write are stubbed.
 */
import { beforeEach, expect, it, vi } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { OpenAIProvider } from "../src/providers/openai.js";
import { MAX_PENDING_EMBEDDING_ATTEMPTS as MAX, MAX_PENDING_EMBEDDINGS_BYTES, PENDING_EMBEDDINGS_FILE, QUARANTINED_EMBEDDINGS_FILE } from "../src/utils/constants.js";
import * as markers from "../src/utils/pending-embeddings.js";
import { loadPendingEmbeddings, normalizeMarker, writePendingEmbeddings } from "../src/utils/pending-embeddings.js";
import { useCompileProject } from "./fixtures/compile-project.js";
import { liveContentHash } from "./fixtures/embedding-chunks.js";
import { fullEmbeddingMarker } from "./fixtures/embedding-marker-capacity.js";
import { useEmbeddingRefreshEnvironment, writeEmbeddingTestPage } from "./fixtures/embedding-refresh.js";
import { drainUnderLock, swallowMarkerWrites } from "./fixtures/embedding-retry-state.js";

const ctx = useCompileProject({ dirSuffix: "legacy-transitions" });
const PAGE = "concepts/alpha";
useEmbeddingRefreshEnvironment();

let provider: ReturnType<typeof vi.spyOn>;
beforeEach(async () => {
  await writeEmbeddingTestPage(ctx.dir, "alpha");
  provider = vi.spyOn(OpenAIProvider.prototype, "embedBatch").mockRejectedValue(new Error("rejected input"));
});

/** Run the shared drain under the project lock its callers hold. */
function refresh(): Promise<void> {
  return drainUnderLock(ctx.dir);
}

/** Alpha's entry bound to its live content. */
async function bound(attempts: number) {
  return { pageId: PAGE, attempts, contentHash: await liveContentHash(ctx.dir, PAGE) };
}

const LEGACY = [{ pageId: PAGE, attempts: MAX }];

/** Quarantine alpha as written before content hashing, then swallow writes to one retry file for one refresh. */
async function refreshLegacyWithSwallowedWrites(file: string): Promise<void> {
  await writePendingEmbeddings(ctx.dir, LEGACY, QUARANTINED_EMBEDDINGS_FILE);
  swallowMarkerWrites(file);
  await refresh();
}

it("grants a legacy exclusion once, binding it before any request, and announces it", async () => {
  await writePendingEmbeddings(ctx.dir, LEGACY, QUARANTINED_EMBEDDINGS_FILE);
  const atRequest: unknown[] = [];
  provider.mockImplementation(async () => {
    atRequest.push(await loadPendingEmbeddings(ctx.dir));
    throw new Error("rejected input");
  });
  await refresh();
  expect(atRequest[0]).toEqual([await bound(1)]);
  expect(console.log).toHaveBeenCalledWith(expect.stringContaining("1 previously quarantined page(s) re-queued after upgrade"));
  for (let round = 1; round < MAX; round++) await refresh();
  expect(await loadPendingEmbeddings(ctx.dir, QUARANTINED_EMBEDDINGS_FILE)).toEqual([await bound(MAX)]);
  const calls = provider.mock.calls.length;
  await refresh();
  expect(provider).toHaveBeenCalledTimes(calls);
});

it("spends no grant and sends nothing when the binding write is swallowed", async () => {
  await refreshLegacyWithSwallowedWrites(PENDING_EMBEDDINGS_FILE);
  expect(provider).not.toHaveBeenCalled();
  expect(await loadPendingEmbeddings(ctx.dir, QUARANTINED_EMBEDDINGS_FILE)).toEqual(LEGACY);
  vi.mocked(markers.writePendingEmbeddings).mockRestore();
  await refresh();
  expect(provider).toHaveBeenCalled();
});

it("completes an interrupted release without a second grant", async () => {
  await refreshLegacyWithSwallowedWrites(QUARANTINED_EMBEDDINGS_FILE);
  // The charge is durable, so the attempt was allowed; the quarantine removal was lost.
  expect(await loadPendingEmbeddings(ctx.dir)).toEqual([await bound(1)]);
  expect(await loadPendingEmbeddings(ctx.dir, QUARANTINED_EMBEDDINGS_FILE)).toEqual(LEGACY);
  vi.mocked(markers.writePendingEmbeddings).mockRestore();
  await refresh();
  expect(await loadPendingEmbeddings(ctx.dir)).toEqual([await bound(2)]);
  expect(await loadPendingEmbeddings(ctx.dir, QUARANTINED_EMBEDDINGS_FILE)).toEqual([]);
});

it("keeps the exclusion when a quarantine append was not followed by the pending removal", async () => {
  const exhausted = await bound(MAX);
  await writePendingEmbeddings(ctx.dir, [exhausted], QUARANTINED_EMBEDDINGS_FILE);
  await writePendingEmbeddings(ctx.dir, [exhausted]);
  await refresh();
  expect(provider).not.toHaveBeenCalled();
  expect(await loadPendingEmbeddings(ctx.dir, QUARANTINED_EMBEDDINGS_FILE)).toEqual([exhausted]);
  expect(await loadPendingEmbeddings(ctx.dir)).toEqual([]);
});

// A crash after the pre-charge but before settlement: restore the files as they
// stood during the request. Every such round still spends one attempt.
it("stays bounded when every run crashes between pre-charge and settlement", async () => {
  const files = [PENDING_EMBEDDINGS_FILE, QUARANTINED_EMBEDDINGS_FILE].map(file => path.join(ctx.dir, file));
  let snapshot: (string | null)[] = [];
  provider.mockImplementation(async () => {
    snapshot = await Promise.all(files.map(file => readFile(file, "utf8").catch(() => null)));
    throw new Error("process killed");
  });
  for (let round = 0; round < MAX + 2; round++) {
    await refresh();
    await Promise.all(files.map((file, i) => snapshot[i] === null ? undefined : writeFile(file, snapshot[i]!)));
  }
  expect(provider).toHaveBeenCalledTimes(MAX);
});

it("defers binding that would push an unrelated entry past the byte cap", async () => {
  const full = [{ pageId: PAGE, attempts: 1 }, ...fullEmbeddingMarker("bytes", 1).slice(1)];
  // Re-pad the last id so the marker, with alpha's short id, sits exactly at the cap.
  const slack = MAX_PENDING_EMBEDDINGS_BYTES - Buffer.byteLength(JSON.stringify(full));
  full[full.length - 1].pageId += "q".repeat(slack);
  await writePendingEmbeddings(ctx.dir, full);
  expect(await loadPendingEmbeddings(ctx.dir)).toHaveLength(full.length);
  await refresh();
  // Binding alpha's hash would push another entry out, so it is deferred unsent and
  // unbound. (The synthetic backlog has no files, so settlement prunes it as usual;
  // eviction-free fitting itself is pinned by the fitAdmissions unit tests.)
  expect(provider).not.toHaveBeenCalled();
  expect(await loadPendingEmbeddings(ctx.dir)).toContainEqual({ pageId: PAGE, attempts: 1 });
  expect(console.log).toHaveBeenCalledWith(expect.stringContaining("page(s) deferred"));
});

it("fits 5,000 typical hash-bound entries under the byte cap", () => {
  const entries = Array.from({ length: 5000 }, (_, i) => ({ pageId: `concepts/typical-page-title-${i}`, attempts: 4, contentHash: "0123456789abcdef" }));
  expect(normalizeMarker(entries)).toHaveLength(5000);
});
