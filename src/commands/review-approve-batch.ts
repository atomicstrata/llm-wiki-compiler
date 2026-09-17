/**
 * Batch review approval: one project lock, one journalled page batch, and one
 * shared finalization. Invalid candidates stay pending while valid candidates
 * proceed. Technical failures stop the operation and retain candidates until
 * finalization succeeds. Cleanup is not atomic: an interruption while deleting
 * candidates can leave a partially cleared queue, whose missing IDs are reported
 * on retry. There is no whole-operation transaction or durable approval receipt.
 */

import { readFile } from "fs/promises";
import { acquireLock, releaseLock } from "../utils/lock.js";
import { withQuiet } from "../utils/output.js";
import { deleteCandidate } from "../compiler/candidates.js";
import { applyApprovedMutationsLocked } from "../trust/executor.js";
import { recoverJournalBeforeCompile } from "../trust/journal-recovery.js";
import { finalizeReviewApprovals, timeReviewPhase } from "./review-finalize.js";
import { planReviewBatch, uniqueBatchItems, type PlannedReviewApproval } from "./review-batch-plan.js";
import {
  parseReviewBatchManifest,
  REVIEW_BATCH_SCHEMA_VERSION,
  type ReviewBatchManifest,
  type ReviewBatchResult,
} from "./review-batch-types.js";

/** CLI file and output options. */
interface ReviewApproveBatchOptions {
  input: string;
  json?: boolean;
}

/** Read a manifest and print one outcome; JSON mode suppresses all progress output. */
export default async function reviewApproveBatchCommand(options: ReviewApproveBatchOptions): Promise<void> {
  const run = async (): Promise<ReviewBatchResult> => {
    try {
      const manifest = parseReviewBatchManifest(JSON.parse(await readFile(options.input, "utf8")));
      return await approveReviewBatch(process.cwd(), manifest);
    } catch (error) {
      return { ...emptyResult(), status: "failed", error: errorMessage(error) };
    }
  };
  const result = await (options.json ? withQuiet(run) : run());
  if (result.status !== "completed") process.exitCode = 1;
  if (options.json) console.log(JSON.stringify(result));
  else printBatchResult(result);
}

/** Execute an approval manifest under one lock and return a complete structured result. */
export async function approveReviewBatch(root: string, manifest: ReviewBatchManifest): Promise<ReviewBatchResult> {
  const started = performance.now();
  const result = emptyResult();
  const unique = uniqueBatchItems(manifest.candidates);
  result.results = unique.results;
  let locked = false;
  try {
    await timeReviewPhase(result.timingsMs, "lockWait", async () => { locked = await acquireLock(root); });
    if (!locked) throw new Error("Could not acquire lock. Try again later.");
    await runBatchUnderLock(root, { ...manifest, candidates: unique.items }, result);
    result.status = result.results.every((item) => item.status === "approved") ? "completed" : "partial";
  } catch (error) {
    result.status = "failed";
    result.error = errorMessage(error);
    for (const item of result.results) if (item.status === "failed") item.error = result.error;
  } finally {
    if (locked) await releaseLock(root);
    result.timingsMs.total = performance.now() - started;
  }
  return result;
}

/** Recover before planning, then apply and finalize the entire valid subset once. */
async function runBatchUnderLock(
  root: string,
  manifest: ReviewBatchManifest,
  result: ReviewBatchResult,
): Promise<void> {
  await timeReviewPhase(result.timingsMs, "recovery", async () => {
    const recovered = await recoverJournalBeforeCompile(root);
    if (recovered.status === "unsafe") throw new Error("Journal recovery unsafe; no approvals attempted.");
  });
  let approvals: PlannedReviewApproval[] = [];
  await timeReviewPhase(result.timingsMs, "validation", async () => {
    approvals = await planReviewBatch(root, manifest.candidates, result.results);
  });
  if (approvals.length === 0) return;
  await timeReviewPhase(result.timingsMs, "promotion", () =>
    applyApprovedMutationsLocked(root, approvals.flatMap((approval) => approval.planned)));
  await finalizeReviewApprovals(root, approvals.map((approval) => approval.candidate), result.timingsMs);
  result.finalized = true;
  await timeReviewPhase(result.timingsMs, "cleanup", async () => {
    for (const approval of approvals) {
      await deleteCandidate(root, approval.result.id);
      approval.result.status = "approved";
    }
  });
}

/** Initialize the versioned envelope before reading files or acquiring locks. */
function emptyResult(): ReviewBatchResult {
  return {
    schemaVersion: REVIEW_BATCH_SCHEMA_VERSION,
    status: "completed",
    finalized: false,
    results: [],
    timingsMs: { total: 0 },
  };
}

/** Normalize thrown values for the output contract. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Print a compact human result with refusals and technical errors on stderr. */
function printBatchResult(result: ReviewBatchResult): void {
  for (const item of result.results) {
    const message = `${item.id}: ${item.status}${item.pagePath ? ` → ${item.pagePath}` : ""}`;
    if (item.status === "approved") console.log(message);
    else console.error(`${message}${item.error ? ` (${item.error})` : ""}`);
  }
  if (result.error) console.error(result.error);
}
