/**
 * Source-state regressions for mixed-revision review batches. Candidates for
 * different slugs can outlive their source revision; approval must not publish
 * those together and mark the source current based on manifest order.
 */

import { expect, it, vi } from "vitest";
import { access } from "fs/promises";
import path from "path";
import { listCandidates } from "../src/compiler/candidates.js";
import * as finalizer from "../src/commands/review-finalize.js";
import { readState, writeState } from "../src/utils/state.js";
import { useTempRoot } from "./fixtures/temp-root.js";
import { approveBatch, stageBatchCandidate, useQuietBatchTests } from "./fixtures/review-batch.js";

const root = useTempRoot();
useQuietBatchTests();

it.each([false, true])("refuses all mixed source revisions independent of order (reverse=%s)", async (reverse) => {
  const initial = { hash: "current", concepts: ["existing"], compiledAt: "before" };
  await writeState(root.dir, { version: 1, indexHash: "", sources: { "source.md": initial } });
  const stale = await stageBatchCandidate(root.dir, "stale", { sourceStates: snapshot("old") });
  const current = await stageBatchCandidate(root.dir, "current", { sourceStates: snapshot("current") });
  const ids = reverse ? [current.id, stale.id] : [stale.id, current.id];
  const finalize = vi.spyOn(finalizer, "finalizeReviewApprovals");
  for (const attempt of [ids, ids]) {
    const result = await approveBatch(root.dir, ...attempt);
    expect(result.status).toBe("partial");
    expect(result.results.map((item) => item.status)).toEqual(["conflict", "conflict"]);
    expect(result.results.every((item) => item.error?.includes("source.md"))).toBe(true);
    expect(result.finalized).toBe(false);
  }
  expect(finalize).not.toHaveBeenCalled();
  expect((await readState(root.dir)).sources["source.md"]).toEqual(initial);
  expect(await listCandidates(root.dir)).toHaveLength(2);
  for (const slug of ["stale", "current"]) {
    await expect(access(path.join(root.dir, "wiki/concepts", `${slug}.md`))).rejects.toThrow();
  }
});

it("keeps every contender pending but finalizes independent sources", async () => {
  const a = await stageBatchCandidate(root.dir, "alpha", { sourceStates: snapshot("old") });
  const b = await stageBatchCandidate(root.dir, "beta", { sourceStates: snapshot("new") });
  const c = await stageBatchCandidate(root.dir, "gamma", { sourceStates: snapshot("new") });
  const independent = await stageBatchCandidate(root.dir, "other", { sourceStates: snapshot("other", "other.md") });
  const result = await approveBatch(root.dir, a.id, b.id, independent.id, c.id);
  expect(result.results.map((item) => item.status)).toEqual(["conflict", "conflict", "approved", "conflict"]);
  expect(result.finalized).toBe(true);
  expect(await listCandidates(root.dir)).toHaveLength(3);
  const state = await readState(root.dir);
  expect(state.sources["source.md"]).toBeUndefined();
  expect(state.sources["other.md"]).toMatchObject({ hash: "other", concepts: ["other"] });
});

it("does not allow an invalid candidate's old snapshot to block a valid revision", async () => {
  const stale = await stageBatchCandidate(root.dir, "stale", { body: "invalid", sourceStates: snapshot("old") });
  const current = await stageBatchCandidate(root.dir, "current", { sourceStates: snapshot("new") });
  const result = await approveBatch(root.dir, stale.id, current.id);
  expect(result.results.map((item) => item.status)).toEqual(["invalid", "approved"]);
  expect((await readState(root.dir)).sources["source.md"]).toMatchObject({ hash: "new", concepts: ["current"] });
});

it("permits a consistent snapshot shared by different slugs", async () => {
  const a = await stageBatchCandidate(root.dir, "alpha", { sourceStates: snapshot("same") });
  const b = await stageBatchCandidate(root.dir, "beta", { sourceStates: snapshot("same") });
  expect((await approveBatch(root.dir, a.id, b.id)).status).toBe("completed");
  expect((await readState(root.dir)).sources["source.md"]).toMatchObject({ hash: "same", concepts: ["alpha", "beta"] });
});

/** Build the recorded source revision without using wall-clock time as freshness evidence. */
function snapshot(hash: string, source = "source.md") {
  return { [source]: { hash, concepts: [], compiledAt: "recorded" } };
}
