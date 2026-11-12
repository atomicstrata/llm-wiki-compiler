/**
 * @file test/storage/review-reject-binding.test.ts
 * @description The `review reject` policy as ONE body over its three project
 * steps, `rejectCandidateWith`, with no project directory. This file uses it,
 * which exists only after rejection was given steps of its own, so it has NO
 * before-edit run.
 *
 * HOW IT IS BUILT. Memory steps log every call and answer each case: the
 * archive (which hands its captured bytes to the release before moving), the
 * intent release (which hands released pages on), and the retry queue. The
 * cases pin the order, the cases that must not touch the queue, the refusal
 * when the queue cannot record the pages, and the report of a real archive
 * only. The bound composition is shown calling each lower one body over its own
 * seam with exact arguments.
 *
 * NOT SHOWN HERE: the lock, custody re-capture, the intent's own storage and the
 * marker store; the review-reject, embedding-intent and candidate-rejection
 * suites show those on disk.
 */

import { afterEach, describe, expect, it, vi } from "bun:test";
import { restoreEnv, stubEnv } from "../stubs.js";
import * as candidateRejection from "../../src/compiler/candidate-rejection.js";
import { rejectCandidateWith, reviewRejectStepsOver, type ReviewRejectSteps } from "../../src/commands/review-reject.js";
import * as embeddingIntent from "../../src/commands/review-embedding-intent.js";
import * as embeddingsRetry from "../../src/utils/embeddings-retry.js";
import * as output from "../../src/utils/output.js";

afterEach(() => { vi.restoreAllMocks(); restoreEnv(); });

const BYTES = Buffer.from("{\"id\":\"cand-1\"}");

/** Memory steps: whether the archive goes through, the pages the release hands on, and the ids the queue cannot record. */
function stepsOf(log: string[], answers: { archived?: boolean; released?: string[]; unrecorded?: string[] }): ReviewRejectSteps {
  return {
    archive: async (id, beforeArchive) => {
      log.push(`archive ${id}`);
      await beforeArchive(BYTES);
      log.push("moved");
      return answers.archived ?? true;
    },
    releaseIntent: async (bytes, handOff) => { log.push(`release ${bytes.toString()}`); await handOff(answers.released ?? []); },
    queueRetry: async (pageIds) => { log.push(`queue ${pageIds.join(",")}`); return answers.unrecorded ?? []; },
  };
}

/** Run one rejection over memory steps; the outcome is "rejected", the refusal message, or "kept". */
async function reject(answers: Parameters<typeof stepsOf>[1]) {
  const log: string[] = [], said: string[] = [];
  vi.spyOn(output, "status").mockImplementation((_icon, message) => { said.push(String(message)); });
  const outcome = await rejectCandidateWith(stepsOf(log, answers), "cand-1").then(() => (said.length ? "rejected" : "kept"), (error: Error) => error.message);
  return { outcome, log, said };
}

describe("the review-reject policy as one body", () => {
  it("R1 releases the intent from the captured bytes and queues its pages BEFORE the move, then reports the archive", async () => {
    stubEnv("LLMWIKI_EMBEDDINGS", "true");
    const run = await reject({ released: ["concepts/a", "concepts/b"] });
    expect([run.outcome, run.log]).toEqual(["rejected", ["archive cand-1", `release ${BYTES.toString()}`, "queue concepts/a,concepts/b", "moved"]]);
    expect(run.said.join(" ")).toContain("Rejected candidate cand-1");
  });

  it("R2 queues nothing when no pages are released or refreshes are disabled", async () => {
    stubEnv("LLMWIKI_EMBEDDINGS", "true");
    const none = await reject({ released: [] });
    expect([none.outcome, none.log.some((call) => call.startsWith("queue"))]).toEqual(["rejected", false]);
    stubEnv("LLMWIKI_EMBEDDINGS", "false");
    const disabled = await reject({ released: ["concepts/a"] });
    expect([disabled.outcome, disabled.log.some((call) => call.startsWith("queue"))]).toEqual(["rejected", false]);
  });

  it("R3 refuses, before the move, when the queue cannot record every released page", async () => {
    stubEnv("LLMWIKI_EMBEDDINGS", "true");
    const run = await reject({ released: ["concepts/a", "concepts/b"], unrecorded: ["concepts/b"] });
    expect(run.outcome).toBe("Embedding retry queue is full: 1 page(s) from an interrupted batch could not be queued. "
      + "Run `llmwiki compile` to work through queued embeddings, then retry; the candidate was not rejected.");
    expect(run.log).not.toContain("moved");
  });

  it("R4 reports nothing when the archive does not happen", async () => {
    expect((await reject({ archived: false })).outcome).toBe("kept");
  });
});

describe("the bound composition", () => {
  it("B1 calls each lower one body over its own seam with exact arguments", async () => {
    const seams = { custody: {} as never, moveRoot: "/memory/project", intent: {} as never, markers: {} as never };
    const archive = vi.spyOn(candidateRejection, "archiveRejectedCandidateFrom").mockResolvedValue(true);
    const release = vi.spyOn(embeddingIntent, "releaseRejectedIntentFrom").mockResolvedValue(undefined);
    const queue = vi.spyOn(embeddingsRetry, "queueScopedEmbeddingRetryFrom").mockResolvedValue([]);
    const steps = reviewRejectStepsOver(seams);
    const before = async () => {};
    const handOff = async () => {};
    await steps.archive("cand-1", before);
    await steps.releaseIntent(BYTES, handOff);
    await steps.queueRetry(["concepts/a"]);
    expect([archive.mock.calls, release.mock.calls, queue.mock.calls]).toEqual([
      [[seams.custody, "/memory/project", "cand-1", before]], [[seams.intent, BYTES, handOff]], [[seams.markers, ["concepts/a"]]],
    ]);
  });
});
