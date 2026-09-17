/**
 * Failure and retry coverage for batch review's deliberately bounded transaction:
 * page writes use the existing intent journal; derived artifacts are retried;
 * cleanup happens last and can be partial. Faults never masquerade as validation.
 */
import { expect, it, vi } from "vitest";
import { readFile, writeFile } from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import * as candidates from "../src/compiler/candidates.js";
import * as executor from "../src/trust/executor.js";
import * as state from "../src/utils/state.js";
import * as resolver from "../src/compiler/resolver.js";
import * as repair from "../src/compiler/link-repair.js";
import * as indexgen from "../src/compiler/indexgen.js";
import * as obsidian from "../src/compiler/obsidian.js";
import * as embeddingRefresh from "../src/utils/embeddings-refresh.js";
import { atomicWrite } from "../src/utils/markdown.js";
import { openBatch, journalPath, recordPreState } from "../src/trust/journal.js";
import { useTempRoot } from "./fixtures/temp-root.js";
import { approveBatch, stageBatchCandidate, useQuietBatchTests } from "./fixtures/review-batch.js";

const root = useTempRoot();
useQuietBatchTests();

/** Inject a failure into one of the independently retryable tail phases. */
function failTailPhase(phase: string): void {
  const failure = new Error(`${phase} fault`);
  switch (phase) {
    case "sourceState": vi.spyOn(state, "writeState").mockRejectedValueOnce(failure); break;
    case "resolveLinks": vi.spyOn(resolver, "resolveAndApplyLinks").mockRejectedValueOnce(failure); break;
    case "repairLinks": vi.spyOn(repair, "repairAndApplyLinks").mockRejectedValueOnce(failure); break;
    case "index": vi.spyOn(indexgen, "generateIndex").mockRejectedValueOnce(failure); break;
    case "moc": vi.spyOn(obsidian, "generateMOC").mockRejectedValueOnce(failure); break;
    case "embeddings": vi.spyOn(embeddingRefresh, "refreshEmbeddingsDrainingPending").mockRejectedValueOnce(failure); break;
    default: throw new Error(`Unknown test phase ${phase}`);
  }
}

it.each(["sourceState", "resolveLinks", "repairLinks", "index", "moc", "embeddings"])(
  "retains all candidates after a %s fault and completes on retry", async (phase) => {
    const sourceStates = { "source.md": { hash: "hash", concepts: [], compiledAt: "before" } };
    const a = await stageBatchCandidate(root.dir, "alpha", { sourceStates });
    const b = await stageBatchCandidate(root.dir, "beta", { sourceStates });
    failTailPhase(phase);
    const failed = await approveBatch(root.dir, a.id, b.id);
    expect(failed.status).toBe("failed");
    expect(failed.finalized).toBe(false);
    expect(failed.results.map((item) => item.status)).toEqual(["failed", "failed"]);
    expect(await candidates.listCandidates(root.dir)).toHaveLength(2);
    expect(existsSync(path.join(root.dir, ".llmwiki/lock"))).toBe(false);
    expect((await approveBatch(root.dir, a.id, b.id)).status).toBe("completed");
  },
);

it("replays a failed combined page write before retrying the whole valid subset", async () => {
  const a = await stageBatchCandidate(root.dir, "alpha");
  const b = await stageBatchCandidate(root.dir, "beta");
  const apply = executor.applyApprovedMutationsLocked;
  let writes = 0;
  const injected = vi.spyOn(executor, "applyApprovedMutationsLocked").mockImplementationOnce((dir, plan) =>
    apply(dir, plan, { writeOne: async (file, body) => {
      if (++writes === 2) throw new Error("page write fault");
      await atomicWrite(file, body);
    } }));
  const failed = await approveBatch(root.dir, a.id, b.id);
  expect(failed.status).toBe("failed");
  expect(injected.mock.calls[0][1]).toHaveLength(2);
  expect(await candidates.listCandidates(root.dir)).toHaveLength(2);
  const retried = await approveBatch(root.dir, a.id, b.id);
  expect(retried.status).toBe("completed");
  expect(await candidates.listCandidates(root.dir)).toEqual([]);
});

it("recovers pending pages before preflight chooses create versus update", async () => {
  const candidate = await stageBatchCandidate(root.dir, "alpha");
  const page = path.join(root.dir, "wiki/concepts/alpha.md");
  const journal = await openBatch(root.dir);
  await recordPreState(journal, page);
  await writeFile(page, "torn crash bytes");
  expect((await approveBatch(root.dir, candidate.id)).status).toBe("completed");
  expect(await readFile(page, "utf8")).toBe(candidate.body);
});

it("fails closed on an unsafe journal without touching candidate pages", async () => {
  const candidate = await stageBatchCandidate(root.dir, "alpha");
  const journal = await openBatch(root.dir);
  await writeFile(journalPath(root.dir, journal.batchId), "malformed journal");
  const result = await approveBatch(root.dir, candidate.id);
  expect(result.status).toBe("failed");
  expect(result.error).toContain("Journal recovery unsafe");
  expect(existsSync(path.join(root.dir, "wiki/concepts/alpha.md"))).toBe(false);
  expect(await candidates.readCandidate(root.dir, candidate.id)).not.toBeNull();
});

it("reports partial cleanup honestly and retries the remaining queue", async () => {
  const a = await stageBatchCandidate(root.dir, "alpha");
  const b = await stageBatchCandidate(root.dir, "beta");
  const remove = candidates.deleteCandidate;
  vi.spyOn(candidates, "deleteCandidate").mockImplementationOnce(remove)
    .mockRejectedValueOnce(new Error("cleanup fault"));
  const failed = await approveBatch(root.dir, a.id, b.id);
  expect(failed.status).toBe("failed");
  expect(failed.finalized).toBe(true);
  expect(failed.results.map((item) => item.status)).toEqual(["approved", "failed"]);
  const retry = await approveBatch(root.dir, a.id, b.id);
  expect(retry.status).toBe("partial");
  expect(retry.results.map((item) => item.status)).toEqual(["invalid", "approved"]);
});

it("aborts before writes when validation encounters an unexpected read failure", async () => {
  const a = await stageBatchCandidate(root.dir, "alpha");
  const b = await stageBatchCandidate(root.dir, "beta");
  const read = candidates.readCandidate;
  vi.spyOn(candidates, "readCandidate").mockImplementationOnce(read)
    .mockRejectedValueOnce(new Error("unexpected I/O failure"));
  const result = await approveBatch(root.dir, a.id, b.id);
  expect(result.status).toBe("failed");
  expect(result.results.map((item) => item.status)).toEqual(["failed", "failed"]);
  expect(existsSync(path.join(root.dir, "wiki/concepts/alpha.md"))).toBe(false);
});
