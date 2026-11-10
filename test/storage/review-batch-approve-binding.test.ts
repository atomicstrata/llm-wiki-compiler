/**
 * @file test/storage/review-batch-approve-binding.test.ts
 * @description Batch review approval as ONE body over `ReviewBatchSteps`
 * (`approveReviewBatchWith`), none of which takes a project root, against the
 * root form `approveReviewBatch`.
 *
 * HOW IT IS BUILT. Memory steps that log every call answer the lock, the plan,
 * the candidate-access check, the embedding intent and retry capacity, the
 * promotion, the finalization and the cleanup. They pin the batch order, which
 * refusal stops it where, that nothing is promoted before the retry-capacity
 * check, that a failure leaves every candidate pending, and that the lock is
 * released on every exit it was taken. The root form is then run on a real
 * staged batch (the existing review-batch fixtures) and shown reaching every
 * incumbent with the root and its old arguments.
 *
 * NOT SHOWN HERE: planning, promotion, finalization and cleanup themselves; the
 * review-batch suites show those.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { restoreEnv, stubEnv } from "../stubs.js";
import * as custody from "../../src/compiler/candidate-custody.js";
import * as candidates from "../../src/compiler/candidates.js";
import { approveReviewBatchWith, type ReviewBatchSteps } from "../../src/commands/review-approve-batch.js";
import * as batchPlan from "../../src/commands/review-batch-plan.js";
import type { ReviewBatchCandidateResult, ReviewBatchItem } from "../../src/commands/review-batch-types.js";
import * as finalize from "../../src/commands/review-finalize.js";
import * as lockGate from "../../src/operation-bundles/lock-gate.js";
import * as executor from "../../src/trust/executor.js";
import * as lock from "../../src/utils/lock.js";
import { approveBatch, stageBatchCandidate, useQuietBatchTests } from "../fixtures/review-batch.js";
import { tempRootTracker } from "../temp-roots.js";

const tracker = tempRootTracker();
afterEach(async () => { vi.restoreAllMocks(); restoreEnv(); await tracker.cleanup(); });

/** What the memory steps answer, where a case says so. */
interface BatchWorld { locked?: boolean; valid?: string[]; unrecordable?: string[]; finalizeFault?: Error }

/** Memory batch steps: the plan approves `valid` (default: every item); each call logged. */
function stepsOf(log: string[], world: BatchWorld = {}): ReviewBatchSteps {
  return {
    acquireLock: async () => { log.push("lock"); return world.locked ?? true; },
    releaseLock: async () => { log.push("release"); },
    plan: async (items: ReviewBatchItem[], results: ReviewBatchCandidateResult[]) => {
      log.push("plan");
      return items.flatMap((item, index) => {
        if (world.valid !== undefined && !world.valid.includes(item.id)) { results[index]!.status = "invalid"; return []; }
        return [{ candidate: { id: item.id } as never, planned: [{ kind: "page", slug: item.id }] as never, result: results[index]! }];
      });
    },
    assertCandidateAccess: async () => { log.push("access"); },
    prepareIntent: async (approved) => { log.push(`intent ${approved.length}`); return { pageIds: new Set(approved.map(({ id }) => `concepts/${id}`)) } as never; },
    unrecordable: async (pageIds) => { log.push(`capacity ${pageIds.length}`); return world.unrecordable ?? []; },
    promote: async (planned) => { log.push(`promote ${planned.length}`); },
    finalize: async (approved) => { log.push(`finalize ${approved.length}`); if (world.finalizeFault) throw world.finalizeFault; },
    deleteCandidate: async (id) => { log.push(`delete ${id}`); },
  };
}

/** Approve `ids` over memory steps: the result envelope and the log. */
async function approve(ids: string[], world: BatchWorld = {}) {
  const log: string[] = [];
  const result = await approveReviewBatchWith(stepsOf(log, world), { schemaVersion: 1, candidates: ids.map((id) => ({ id })) });
  return { result, log, statuses: result.results.map(({ status }) => status) };
}

describe("the batch approval sequence as a root-free body", () => {
  // Embeddings ON unless a case turns them off, whatever the ambient environment.
  beforeEach(() => { stubEnv("LLMWIKI_EMBEDDINGS", "on"); });

  it("B1 locks, plans, checks access, opens the intent, checks retry capacity, promotes, finalizes, then deletes, and releases", async () => {
    const { result, log, statuses } = await approve(["a", "b"]);
    expect([result.status, result.finalized, statuses]).toEqual(["completed", true, ["approved", "approved"]]);
    expect(log).toEqual(["lock", "plan", "access", "intent 2", "capacity 2", "promote 2", "finalize 2", "delete a", "delete b", "release"]);
  });

  it("B2 a busy lock fails the batch with nothing planned and no release; an all-invalid plan stops there, partial", async () => {
    const busy = await approve(["a"], { locked: false });
    expect([busy.result.status, busy.result.error, busy.log]).toEqual(["failed", "Could not acquire lock. Try again later.", ["lock"]]);
    const invalid = await approve(["a", "b"], { valid: [] });
    expect([invalid.result.status, invalid.statuses, invalid.log]).toEqual(["partial", ["invalid", "invalid"], ["lock", "plan", "release"]]);
  });

  it("B3 a full retry marker refuses BEFORE promotion and leaves every candidate pending; embeddings off skips the check", async () => {
    const full = await approve(["a"], { unrecordable: ["concepts/a"] });
    expect([full.result.status, full.result.error, full.statuses]).toEqual(["failed", expect.stringContaining("no candidate was approved"), ["failed"]]);
    expect(full.log).toEqual(["lock", "plan", "access", "intent 1", "capacity 1", "release"]);
    stubEnv("LLMWIKI_EMBEDDINGS", "off");
    const off = await approve(["a"], { unrecordable: ["concepts/a"] });
    expect([off.result.status, off.log.includes("capacity 1")]).toEqual(["completed", false]);
  });

  it("B4 a finalization fault fails the batch unfinalized, deletes nothing, and still releases", async () => {
    const { result, log, statuses } = await approve(["a", "b"], { valid: ["b"], finalizeFault: new Error("index write failed") });
    expect([result.status, result.finalized, result.error, statuses]).toEqual(["failed", false, "index write failed", ["invalid", "failed"]]);
    expect(log).toEqual(["lock", "plan", "access", "intent 1", "capacity 1", "promote 1", "finalize 1", "release"]);
  });
});

describe("the root form", () => {
  useQuietBatchTests();

  it("Z1 reaches every incumbent with the root and its old arguments, while the body over memory reaches none", async () => {
    const root = await tracker.create("review-batch-approve-", { real: true });
    const [a, b] = [await stageBatchCandidate(root, "alpha"), await stageBatchCandidate(root, "beta")];
    const spies = {
      lock: vi.spyOn(lockGate, "acquireMutationLock"), release: vi.spyOn(lock, "releaseLock"), plan: vi.spyOn(batchPlan, "planReviewBatch"),
      access: vi.spyOn(custody, "assertCandidateMutationAccess"), intent: vi.spyOn(finalize, "prepareReviewEmbeddingIntent"),
      promote: vi.spyOn(executor, "applyApprovedMutationsLocked"), finalize: vi.spyOn(finalize, "finalizeReviewApprovals"), remove: vi.spyOn(candidates, "deleteCandidate"),
    };
    await approve(["x"]);
    expect(Object.values(spies).map((spy) => spy.mock.calls.length)).toEqual(Array(8).fill(0));
    expect((await approveBatch(root, a.id, b.id)).status).toBe("completed");
    expect([spies.lock.mock.calls[0], spies.release.mock.calls[0], spies.access.mock.calls[0]]).toEqual([[root, "review"], [root], [root, false]]);
    expect([spies.plan.mock.calls[0]?.[0], spies.intent.mock.calls[0]?.[0], spies.promote.mock.calls[0]?.[0], spies.finalize.mock.calls[0]?.[0]]).toEqual([root, root, root, root]);
    expect(spies.finalize.mock.calls[0]?.[3]).toEqual({ embeddingScope: "affected-only", intent: expect.anything() });
    expect(spies.remove.mock.calls.map((call: readonly unknown[]) => call.slice(0, 2))).toEqual([[root, a.id], [root, b.id]]);
  });
});
