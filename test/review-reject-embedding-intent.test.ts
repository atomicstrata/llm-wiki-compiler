/**
 * Rejecting a candidate retained by an interrupted batch must not strand the
 * embedding work its snapshot keys in the review intent. The work moves to the
 * normal retry queue before the candidate is archived; a queue that cannot
 * record it, or unreadable intent, refuses the rejection and keeps the candidate.
 */
import { beforeEach, expect, it, vi } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import reviewRejectCommand from "../src/commands/review-reject.js";
import { listCandidates } from "../src/compiler/candidates.js";
import * as indexgen from "../src/compiler/indexgen.js";
import { loadProfile } from "../src/profile/load.js";
import { OpenAIProvider } from "../src/providers/openai.js";
import { MAX_PENDING_EMBEDDING_ATTEMPTS, PENDING_EMBEDDINGS_FILE, QUARANTINED_EMBEDDINGS_FILE } from "../src/utils/constants.js";
import { collectEligibleLivePages } from "../src/utils/embeddings-collect.js";
import { refreshEmbeddingsDrainingPending } from "../src/utils/embeddings-refresh.js";
import { acquireLockBlocking, releaseLock } from "../src/utils/lock.js";
import { loadPendingEmbeddings, writePendingEmbeddings } from "../src/utils/pending-embeddings.js";
import { useCompileProject } from "./fixtures/compile-project.js";
import { fullEmbeddingMarker } from "./fixtures/embedding-marker-capacity.js";
import { useEmbeddingRefreshEnvironment } from "./fixtures/embedding-refresh.js";
import { stageBatchCandidate, approveBatch } from "./fixtures/review-batch.js";
import { expectCLIExit, runCLI } from "./fixtures/run-cli.js";
import { readV3Store } from "./fixtures/v3-store.js";

const ctx = useCompileProject({ dirSuffix: "reject-embedding-intent" });
const INTENT_FILE = ".llmwiki/review-embedding-intent.json";
const NOVEL_WORK = ["concepts/novel", "concepts/linked-novel"];
useEmbeddingRefreshEnvironment();

beforeEach(async () => {
  vi.spyOn(OpenAIProvider.prototype, "embedBatch").mockImplementation(async texts => texts.map(() => [0.5, 0.5]));
  for (const slug of ["novel", "other"]) {
    await writeFile(path.join(ctx.dir, `wiki/concepts/linked-${slug}.md`),
      `---\ntitle: Reference ${slug}\nsummary: Topic reference\n---\n${slug === "novel" ? "Novel" : "Other"} Topic.\n`);
  }
  await withLock(() => refreshEmbeddingsDrainingPending(ctx.dir, []));
});

/** Run a direct core call under the project lock the CLI would hold. */
async function withLock(run: () => Promise<void>): Promise<void> {
  await acquireLockBlocking(ctx.dir);
  try { await run(); } finally { await releaseLock(ctx.dir); }
}

/** Leave both candidates retained with intent after the batch tail fails at index generation. */
async function interruptBatch(): Promise<string[]> {
  const ids: string[] = [];
  for (const [slug, title] of [["novel", "Novel Topic"], ["other", "Other Topic"]]) {
    const staged = await stageBatchCandidate(ctx.dir, slug, { body: `---\ntitle: ${title}\n---\nNew text for ${slug}.\n` });
    ids.push(staged.id);
  }
  vi.spyOn(indexgen, "generateIndex").mockRejectedValueOnce(new Error("injected index failure"));
  expect((await approveBatch(ctx.dir, ...ids)).status).toBe("failed");
  expect(await readFile(path.join(ctx.dir, "wiki/concepts/linked-novel.md"), "utf8")).toContain("[[novel|Novel Topic]]");
  return ids;
}

/** Reject through the command entry point, which reads the project root from cwd. */
async function reject(id: string): Promise<void> {
  const previous = process.cwd();
  process.chdir(ctx.dir);
  try { await reviewRejectCommand(id); } finally { process.chdir(previous); }
}

/** Persisted chunk hashes match live content only once the queued work was embedded. */
async function expectChunksCurrent(pageId: string, current: boolean): Promise<void> {
  const live = (await collectEligibleLivePages(ctx.dir, await loadProfile(ctx.dir))).find(page => page.pageId === pageId)!;
  const stored = (await readV3Store(ctx.dir))!.chunks!.filter(chunk => chunk.pageId === pageId).map(chunk => chunk.contentHash);
  if (current) expect(stored).toEqual(live.chunkContentHashes);
  else expect(stored).not.toEqual(live.chunkContentHashes);
}

/** Candidate keys and page IDs currently recorded in the intent file. */
async function intentEntries(): Promise<{ candidates: string[]; pageIds: string[] }[]> {
  return JSON.parse(await readFile(path.join(ctx.dir, INTENT_FILE), "utf8")).entries;
}

it("hands the rejected batch's embedding work to the retry queue and retires its intent", async () => {
  const [novel, other] = await interruptBatch();
  await reject(novel);
  await reject(other);
  expect(await listCandidates(ctx.dir)).toEqual([]);
  expect(await intentEntries()).toEqual([]);
  expect((await loadPendingEmbeddings(ctx.dir)).map(entry => entry.pageId)).toEqual(expect.arrayContaining(NOVEL_WORK));
  await expectChunksCurrent("concepts/linked-novel", false);
  await withLock(() => refreshEmbeddingsDrainingPending(ctx.dir, []));
  await expectChunksCurrent("concepts/linked-novel", true);
  expect(await loadPendingEmbeddings(ctx.dir)).toEqual([]);
});

// Content-hash discovery would re-find ordinary stale chunks on its own, but it
// skips quarantined pages until an explicit change. The batch rewrote this page,
// so the handoff must count as that change or its chunks stay stale for good.
it("releases a quarantined page the batch rewrote so the next compile refreshes it", async () => {
  await writePendingEmbeddings(ctx.dir, [{ pageId: "concepts/linked-novel", attempts: MAX_PENDING_EMBEDDING_ATTEMPTS }], QUARANTINED_EMBEDDINGS_FILE);
  for (const id of await interruptBatch()) await reject(id);
  expect(await loadPendingEmbeddings(ctx.dir, QUARANTINED_EMBEDDINGS_FILE)).toEqual([]);
  await withLock(() => refreshEmbeddingsDrainingPending(ctx.dir, []));
  await expectChunksCurrent("concepts/linked-novel", true);
});

it("keeps the entry for a batch-mate still pending, which later completes", async () => {
  const [novel, other] = await interruptBatch();
  const [entry] = await intentEntries();
  await reject(novel);
  expect(await intentEntries()).toEqual([{ candidates: entry.candidates.slice(1), pageIds: entry.pageIds }]);
  expect((await approveBatch(ctx.dir, other)).status).toBe("completed");
  expect(await intentEntries()).toEqual([]);
  await expectChunksCurrent("concepts/linked-novel", true);
});

it.each(["queue", "intent"] as const)("refuses and keeps the candidate while the %s cannot take the work", async kind => {
  const [novel] = await interruptBatch();
  if (kind === "queue") await writePendingEmbeddings(ctx.dir, fullEmbeddingMarker("count", 1));
  else await writeFile(path.join(ctx.dir, INTENT_FILE), "{");
  const intentBefore = await readFile(path.join(ctx.dir, INTENT_FILE), "utf8");
  await expect(reject(novel)).rejects.toThrow(kind === "queue" ? /retry queue is full/ : /intent/);
  expect((await listCandidates(ctx.dir)).map(candidate => candidate.id)).toContain(novel);
  expect(await readFile(path.join(ctx.dir, INTENT_FILE), "utf8")).toBe(intentBefore);
});

it("rejects through the CLI after the queue is repaired, and refuses while it is full", async () => {
  const [novel] = await interruptBatch();
  await writePendingEmbeddings(ctx.dir, fullEmbeddingMarker("count", 1));
  const env = { OPENAI_API_KEY: "", ANTHROPIC_API_KEY: "" };
  const refused = await runCLI(["review", "reject", novel], ctx.dir, env);
  expectCLIExit(refused, 1);
  expect(`${refused.stdout}${refused.stderr}`).toMatch(/retry queue is full/);
  expect((await listCandidates(ctx.dir)).map(candidate => candidate.id)).toContain(novel);
  await writeFile(path.join(ctx.dir, PENDING_EMBEDDINGS_FILE), "[]");
  expectCLIExit(await runCLI(["review", "reject", novel], ctx.dir, env), 0);
  expect((await loadPendingEmbeddings(ctx.dir)).map(entry => entry.pageId)).toEqual(expect.arrayContaining(NOVEL_WORK));
});

it("rejects with a full queue when embeddings are off, since there is nothing to queue", async () => {
  const [novel] = await interruptBatch();
  await writePendingEmbeddings(ctx.dir, fullEmbeddingMarker("count", 1));
  const run = await runCLI(["review", "reject", novel], ctx.dir, { LLMWIKI_EMBEDDINGS: "off", OPENAI_API_KEY: "", ANTHROPIC_API_KEY: "" });
  expectCLIExit(run, 0);
  expect((await listCandidates(ctx.dir)).map(candidate => candidate.id)).not.toContain(novel);
  expect((await intentEntries())[0].candidates).toHaveLength(1);
});
