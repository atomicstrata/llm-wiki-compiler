/**
 * Rejecting a candidate retained by an interrupted batch must not strand the
 * embedding work its snapshot keys in the review intent. The work moves to the
 * normal retry queue before the candidate is archived; a queue that cannot
 * record it, or unreadable intent, refuses the rejection and keeps the candidate.
 */
import { beforeEach, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import reviewRejectCommand from "../src/commands/review-reject.js";
import * as rejection from "../src/compiler/candidate-rejection.js";
import { listCandidates } from "../src/compiler/candidates.js";
import * as indexgen from "../src/compiler/indexgen.js";
import { loadProfile } from "../src/profile/load.js";
import { OpenAIProvider } from "../src/providers/openai.js";
import { MAX_PENDING_EMBEDDING_ATTEMPTS, PENDING_EMBEDDINGS_FILE, QUARANTINED_EMBEDDINGS_FILE } from "../src/utils/constants.js";
import { collectEligibleLivePages } from "../src/utils/embeddings-collect.js";
import { refreshEmbeddingsDrainingPending } from "../src/utils/embeddings-refresh.js";
import { acquireLockBlocking, releaseLock } from "../src/utils/lock.js";
import * as markers from "../src/utils/pending-embeddings.js";
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

/** A refused rejection keeps the candidate pending and the intent byte-for-byte unchanged. */
async function expectRefusedAndRetained(id: string, intentBefore: string, reason: RegExp): Promise<void> {
  await expect(reject(id)).rejects.toThrow(reason);
  expect((await listCandidates(ctx.dir)).map(candidate => candidate.id)).toContain(id);
  expect(await readFile(path.join(ctx.dir, INTENT_FILE), "utf8")).toBe(intentBefore);
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
// skips excluded pages until an explicit change: quarantined ones, and exhausted
// pending entries kept when quarantine overflowed. The batch rewrote this page,
// so rejection must lift that exclusion (queueing it when embeddings are on) or
// its chunks stay stale for good. Unrelated exclusions must survive.
const EXCLUSIONS = ["quarantine", "exhausted"] as const;
const EXCLUDED_REWRITE = [{ pageId: "concepts/linked-novel", attempts: MAX_PENDING_EMBEDDING_ATTEMPTS }];
const UNRELATED_QUARANTINE = [{ pageId: "concepts/unrelated", attempts: MAX_PENDING_EMBEDDING_ATTEMPTS }];
it.each(EXCLUSIONS.flatMap(kind => (["on", "off"] as const).map(mode => [kind, mode] as const)))(
  "lifts the %s exclusion on a rewritten page (embeddings %s at rejection) so the next compile refreshes it",
  async (kind, embeddings) => {
    const marker = kind === "quarantine" ? QUARANTINED_EMBEDDINGS_FILE : PENDING_EMBEDDINGS_FILE;
    await writePendingEmbeddings(ctx.dir, [...EXCLUDED_REWRITE, ...(kind === "quarantine" ? UNRELATED_QUARANTINE : [])], marker);
    if (kind === "exhausted") await writePendingEmbeddings(ctx.dir, UNRELATED_QUARANTINE, QUARANTINED_EMBEDDINGS_FILE);
    const ids = await interruptBatch();
    vi.stubEnv("LLMWIKI_EMBEDDINGS", embeddings);
    for (const id of ids) await reject(id);
    vi.stubEnv("LLMWIKI_EMBEDDINGS", "on");
    expect(await intentEntries()).toEqual([]);
    expect(await loadPendingEmbeddings(ctx.dir, QUARANTINED_EMBEDDINGS_FILE)).toEqual(UNRELATED_QUARANTINE);
    await withLock(() => refreshEmbeddingsDrainingPending(ctx.dir, []));
    await expectChunksCurrent("concepts/linked-novel", true);
  },
);

// Marker writers swallow write and unlink failures. Simulate one that reports
// success without persisting: the rejection must refuse, not retire the intent.
it.each([
  ["off", "write", QUARANTINED_EMBEDDINGS_FILE],
  ["off", "clear", QUARANTINED_EMBEDDINGS_FILE],
  ["off", "clear", PENDING_EMBEDDINGS_FILE],
  ["on", "write", QUARANTINED_EMBEDDINGS_FILE],
] as const)("refuses with embeddings %s when a swallowed %s of %s leaves the exclusion", async (embeddings, path_, marker) => {
  const extra = path_ === "write" ? UNRELATED_QUARANTINE : [];
  await writePendingEmbeddings(ctx.dir, [...EXCLUDED_REWRITE, ...extra], marker);
  const [novel] = await interruptBatch();
  const intentBefore = await readFile(path.join(ctx.dir, INTENT_FILE), "utf8");
  const write = markers.writePendingEmbeddings;
  vi.spyOn(markers, "writePendingEmbeddings").mockImplementation(async (root, entries, file = PENDING_EMBEDDINGS_FILE) =>
    file === marker ? undefined : write(root, entries, file));
  vi.stubEnv("LLMWIKI_EMBEDDINGS", embeddings);
  await expectRefusedAndRetained(novel, intentBefore, /still excluded/);
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
  await expectRefusedAndRetained(novel, intentBefore, kind === "queue" ? /retry queue is full/ : /intent/);
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

it("releases the work of a record that lost an unrelated field and no longer passes admission", async () => {
  const [novel] = await interruptBatch();
  const file = path.join(ctx.dir, `.llmwiki/candidates/${novel}.json`);
  const { title: _title, ...rest } = JSON.parse(await readFile(file, "utf8"));
  await writeFile(file, JSON.stringify(rest));
  await reject(novel);
  expect((await listCandidates(ctx.dir)).map(candidate => candidate.id)).not.toContain(novel);
  expect((await intentEntries())[0].candidates).toHaveLength(1);
  expect((await loadPendingEmbeddings(ctx.dir)).map(entry => entry.pageId)).toEqual(expect.arrayContaining(NOVEL_WORK));
});

it("refuses without hanging when the record becomes a FIFO between the pre-lock check and the lock", async () => {
  const [novel] = await interruptBatch();
  const file = path.join(ctx.dir, `.llmwiki/candidates/${novel}.json`);
  const intentBefore = await readFile(path.join(ctx.dir, INTENT_FILE), "utf8");
  vi.spyOn(rejection, "loadRejectableCandidateOrFail").mockImplementation(async () => {
    await rm(file);
    execFileSync("mkfifo", [file]);
    return true;
  });
  try {
    await expect(reject(novel)).rejects.toThrow();
    expect(await readFile(path.join(ctx.dir, INTENT_FILE), "utf8")).toBe(intentBefore);
  } finally {
    await rm(file, { force: true });
    process.exitCode = undefined;
  }
}, 10_000);
