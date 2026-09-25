/**
 * Real embedding-core recovery regressions for collateral link rewrites. A tail
 * failure leaves already-rewritten pages on disk, so the next linker pass cannot
 * rediscover their stale chunks. Durable intent must survive reordered/subset
 * retries without spending unrelated pending or quarantined retry budgets.
 */
import { beforeEach, expect, it, vi } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import * as indexgen from "../src/compiler/indexgen.js";
import * as obsidian from "../src/compiler/obsidian.js";
import { listCandidates } from "../src/compiler/candidates.js";
import { OpenAIProvider } from "../src/providers/openai.js";
import { refreshEmbeddingsDrainingPending } from "../src/utils/embeddings-refresh.js";
import { acquireLockBlocking, releaseLock } from "../src/utils/lock.js";
import { collectEligibleLivePages } from "../src/utils/embeddings-collect.js";
import { loadProfile } from "../src/profile/load.js";
import { loadPendingEmbeddings, writePendingEmbeddings } from "../src/utils/pending-embeddings.js";
import { MAX_PENDING_EMBEDDING_ATTEMPTS, PENDING_EMBEDDINGS_FILE, QUARANTINED_EMBEDDINGS_FILE } from "../src/utils/constants.js";
import { useCompileProject } from "./fixtures/compile-project.js";
import { useEmbeddingRefreshEnvironment } from "./fixtures/embedding-refresh.js";
import { stageBatchCandidate, approveBatch } from "./fixtures/review-batch.js";
import { readV3Store } from "./fixtures/v3-store.js";
import { fullEmbeddingMarker } from "./fixtures/embedding-marker-capacity.js";

const ctx = useCompileProject({ dirSuffix: "batch-embedding-recovery" });
const COLLATERAL_IDS = ["concepts/linked-novel", "concepts/linked-other"];
const UNRELATED_PENDING = [{ pageId: "concepts/backlog", attempts: MAX_PENDING_EMBEDDING_ATTEMPTS - 1 }];
const UNRELATED_QUARANTINE = [{ pageId: "concepts/quarantined", attempts: MAX_PENDING_EMBEDDING_ATTEMPTS }];
const RETRY_CASES = ["same", "subset", "reordered"] as const;
type RetryKind = typeof RETRY_CASES[number];
useEmbeddingRefreshEnvironment();

beforeEach(async () => {
  vi.spyOn(OpenAIProvider.prototype, "embedBatch").mockImplementation(async texts => texts.map(() => [0.5, 0.5]));
  await writeCollateralPage("novel", "Novel Topic");
  await writeCollateralPage("other", "Other Topic");
  await acquireLockBlocking(ctx.dir);
  try {
    await refreshEmbeddingsDrainingPending(ctx.dir, []);
  } finally {
    await releaseLock(ctx.dir);
  }
  await writePendingEmbeddings(ctx.dir, UNRELATED_PENDING);
  await writePendingEmbeddings(ctx.dir, UNRELATED_QUARANTINE, QUARANTINED_EMBEDDINGS_FILE);
});

/** Seed prose that the real resolver will rewrite when its target is approved. */
async function writeCollateralPage(slug: string, title: string): Promise<void> {
  await writeFile(path.join(ctx.dir, `wiki/concepts/linked-${slug}.md`),
    `---\ntitle: Reference ${slug}\nsummary: Topic reference\n---\n${title}.\n`);
}

/** Stage two distinct targets whose linked collateral pages were already embedded. */
async function stageLinkedTargets(): Promise<string[]> {
  const targets = [["novel", "Novel Topic"], ["other", "Other Topic"]];
  const candidates = await Promise.all(targets.map(([slug, title]) => stageBatchCandidate(ctx.dir, slug, {
    body: `---\ntitle: ${title}\n---\nNew text for ${slug}.\n`,
  })));
  return candidates.map(candidate => candidate.id);
}

/** Compare persisted chunk hashes to live content, not unchanged title/summary vectors. */
async function expectCollateralChunksCurrent(current: boolean, pageIds = COLLATERAL_IDS): Promise<void> {
  const livePages = await collectEligibleLivePages(ctx.dir, await loadProfile(ctx.dir));
  const store = await readV3Store(ctx.dir);
  for (const pageId of pageIds) {
    const live = livePages.find(page => page.pageId === pageId)!;
    const stored = store!.chunks!.filter(chunk => chunk.pageId === pageId);
    expect(stored.length).toBeGreaterThan(0);
    if (current) expect(stored.map(chunk => chunk.contentHash)).toEqual(live.chunkContentHashes);
    else expect(stored.map(chunk => chunk.contentHash)).not.toEqual(live.chunkContentHashes);
  }
}

/** Verify batch recovery did not retry, increment, quarantine, or release unrelated IDs. */
async function expectUnrelatedRetryState(): Promise<void> {
  expect(await loadPendingEmbeddings(ctx.dir)).toEqual(UNRELATED_PENDING);
  expect(await loadPendingEmbeddings(ctx.dir, QUARANTINED_EMBEDDINGS_FILE)).toEqual(UNRELATED_QUARANTINE);
}

/** Select a retry manifest without changing the original candidate snapshots. */
function retryIds(ids: string[], kind: RetryKind): string[] {
  if (kind === "subset") return ids.slice(0, 1);
  return kind === "reordered" ? [...ids].reverse() : ids;
}

/** A failed tail must leave every submitted candidate available for another attempt. */
async function expectFailedApprovalRetained(ids: string[]): Promise<void> {
  const failed = await approveBatch(ctx.dir, ...ids);
  expect(failed.status).toBe("failed");
  expect(failed.finalized).toBe(false);
  expect((await listCandidates(ctx.dir)).map(candidate => candidate.id).sort()).toEqual([...ids].sort());
}

/** Completion reconciles owned chunks and removes only the submitted candidates. */
async function expectCompletedApproval(ids: string[], remaining: string[] = []): Promise<void> {
  const result = await approveBatch(ctx.dir, ...ids);
  expect(result.status).toBe("completed");
  expect(result.finalized).toBe(true);
  await expectCollateralChunksCurrent(true);
  await expectUnrelatedRetryState();
  expect((await listCandidates(ctx.dir)).map(candidate => candidate.id)).toEqual(remaining);
}

for (const phase of ["index", "moc"] as const) {
  it.each(RETRY_CASES)(`recovers collateral chunks after ${phase} failure with a %s retry`, async kind => {
    const ids = await stageLinkedTargets();
    const failure = new Error(`injected ${phase} failure`);
    if (phase === "index") vi.spyOn(indexgen, "generateIndex").mockRejectedValueOnce(failure);
    else vi.spyOn(obsidian, "generateMOC").mockRejectedValueOnce(failure);
    await expectFailedApprovalRetained(ids);
    expect(await readFile(path.join(ctx.dir, "wiki/concepts/linked-novel.md"), "utf8")).toContain("[[novel|Novel Topic]]");
    await expectCollateralChunksCurrent(false);
    await expectUnrelatedRetryState();
    await expectCompletedApproval(retryIds(ids, kind), kind === "subset" ? ids.slice(1) : []);
  });
}

it("keeps the no-failure path consistent with the same real embedding core", async () => {
  const ids = await stageLinkedTargets();
  await expectCompletedApproval(ids);
});

it("does not consume embedding recovery owned by a different interrupted batch", async () => {
  const [novel, other] = await stageLinkedTargets();
  vi.spyOn(indexgen, "generateIndex").mockRejectedValueOnce(new Error("injected index failure"));
  expect((await approveBatch(ctx.dir, novel)).status).toBe("failed");
  await expectCollateralChunksCurrent(false, [COLLATERAL_IDS[0]]);
  expect((await approveBatch(ctx.dir, other)).status).toBe("completed");
  await expectCollateralChunksCurrent(false, [COLLATERAL_IDS[0]]);
  await expectCollateralChunksCurrent(true, [COLLATERAL_IDS[1]]);
  expect((await listCandidates(ctx.dir)).map(candidate => candidate.id)).toEqual([novel]);
  await expectCompletedApproval([novel]);
});

it.each(["capacity", "corrupt"] as const)("retains candidates and intent until %s retry storage is repaired", async kind => {
  const ids = await stageLinkedTargets();
  const marker = path.join(ctx.dir, PENDING_EMBEDDINGS_FILE);
  if (kind === "capacity") await writePendingEmbeddings(ctx.dir, fullEmbeddingMarker("count", 1));
  else await writeFile(marker, "{malformed");
  const previousMarker = await readFile(marker, "utf8");
  await expectFailedApprovalRetained(ids);
  expect(await readFile(marker, "utf8")).toBe(previousMarker);
  const intent = await readFile(path.join(ctx.dir, ".llmwiki/review-embedding-intent.json"), "utf8");
  for (const pageId of COLLATERAL_IDS) expect(intent).toContain(pageId);
  await expectCollateralChunksCurrent(false);
  await writePendingEmbeddings(ctx.dir, UNRELATED_PENDING);
  await expectCompletedApproval(ids);
});
