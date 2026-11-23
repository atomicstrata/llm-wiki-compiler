/**
 * @file src/compiler/batch/driver.ts
 * @description The BATCH COMPILE driver: the bounded-memory, resumable
 * compile of a `local-indexed` project whose segmented compile state is the
 * authority (`../../cstate/records.ts`).
 *
 * ORDER. Refuse what the batch route does not support BEFORE any effect:
 * review mode, a change filter, skipped seed pages, a review policy that is
 * not off, pending review candidates (their source snapshots would need the
 * whole queue), an unbounded seed configuration, and a custom profile without
 * the typed entity catalog, and `--no-pages-limit` (its explicit empty answer
 * withdraws a source's earlier concepts, which a batch run does not implement:
 * see `./extraction-outcome.ts`). Then, exactly as the incumbent: the ordinary
 * gated lock, compile's own strict journal recovery, and the run's system
 * policy for the whole run, so it reaches the extraction and page prompts,
 * the prompt-modifier digest and the run's identity. The run is selected (`./run-select.ts`: new,
 * resumed after revalidation, or restarted) and its phases run in order, each
 * resumable from its committed cursor, until it is `done`.
 *
 * RESULT (the BOUNDED result contract). `concepts` and `pages` are always
 * EMPTY (they would hold one entry per page); `compiled`, `skipped` and
 * `deleted` are the incumbent's counts; `errors` holds AT MOST ONE bounded
 * summary line (extraction failures and page errors, pointing at the report),
 * never the incumbent's per-source and per-page messages; `mode: "batch"`
 * and `batch` (run id, phase, every counter) are authoritative. Consumers
 * read failures from `batch.counts` (`failed`, `pageErrors`) and page the
 * typed facts with `compile --report <runId>` / `compileReport(runId)`.
 */

import { listConfinedDirBounded } from "../../utils/confined-dir.js";
import { catalogWalkTypes } from "../../catalog/sync.js";
import { acquireMutationLock } from "../../operation-bundles/lock-gate.js";
import { loadProjectConfigFrom } from "../../project/config.js";
import { reviewPolicyFromConfig } from "../../review/config.js";
import { isPolicyOff } from "../../review/policy.js";
import { loadSchemaFrom } from "../../schema/loader.js";
import { diskLocalReads } from "../../storage/disk-local-reads.js";
import { JournalUnsafeError, recoverJournalBeforeCompile } from "../../trust/journal-recovery.js";
import { CANDIDATES_DIR } from "../../utils/constants.js";
import { releaseLock } from "../../utils/lock.js";
import * as output from "../../utils/output.js";
import type { CompileOptions, CompileResult } from "../../utils/types.js";
import { reportSchemaStatus } from "../compile-report.js";
import { resolveCompileConcurrency } from "../concurrency.js";
import { withRunSystemPolicy } from "../prompt-modifiers.js";
import { BatchCompileError, DEFAULT_BATCH_SIZE, type BatchCompileSummaryV1, type BatchRunOptions } from "./contracts.js";
import { assertBatchEmbeddingsOff, assertSupportedBatchOptions } from "./options.js";
import { runPhases, type BatchContext } from "./phases.js";
import { policyDigest, selectRun } from "./run-select.js";
import { assertSeedsBounded } from "./seeds.js";

/** A batch compile's result: the incumbent shape with empty arrays, plus the run summary. */
interface BatchCompileResult extends CompileResult {
  readonly mode: "batch";
  readonly batch: BatchCompileSummaryV1;
}

/** Candidate files one pending-queue look reads at most (one is enough to refuse). */
const PENDING_LOOK_ENTRIES = 4_096;

/** Refuse while review candidates are pending (a bounded look at the queue directory). */
async function assertNoPendingCandidates(root: string): Promise<void> {
  const listing = await listConfinedDirBounded(root, CANDIDATES_DIR, PENDING_LOOK_ENTRIES);
  if (listing.kind === "absent") return;
  const pending = listing.kind !== "ok" || listing.entries.some((entry) => entry.kind === "file" && entry.name.endsWith(".json"));
  if (pending) throw new BatchCompileError("compile_batch_unsupported_option", "review candidates are pending (or the queue cannot be read in full); approve or reject them before a batch compile");
}

/** Every pre-effect check and the run's fixed inputs. */
async function prepare(root: string, options: CompileOptions & BatchRunOptions): Promise<Omit<BatchContext, "run">> {
  const reads = diskLocalReads(root);
  const schema = await loadSchemaFrom(reads);
  const reviewPolicy = reviewPolicyFromConfig(await loadProjectConfigFrom(reads));
  if (!isPolicyOff(reviewPolicy)) throw new BatchCompileError("compile_batch_unsupported_option", "a review policy is configured; a batch compile writes pages live only");
  assertSeedsBounded(schema);
  assertBatchEmbeddingsOff(options);
  await assertNoPendingCandidates(root);
  await catalogWalkTypes(root);
  reportSchemaStatus(schema);
  return { root, reads, schema, reviewPolicy, options, concurrency: resolveCompileConcurrency(options.concurrency) };
}

/**
 * Every pre-effect refusal of a batch compile, and the run's fixed inputs: the
 * unsupported options, then the policy, seed, embeddings, pending-queue and
 * catalog checks. Reads only.
 */
export async function preflightBatch(root: string, options: CompileOptions & BatchRunOptions): Promise<Omit<BatchContext, "run">> {
  assertSupportedBatchOptions(options);
  return prepare(root, options);
}

/** The bounded result of a finished run. */
function resultOf(context: BatchContext): BatchCompileResult {
  const { run } = context;
  const counts = { ...run.counters };
  const failures = counts.failed + counts.pageErrors;
  const errors = failures === 0 ? [] : [`${counts.failed} extraction failure(s) and ${counts.pageErrors} page error(s); page them with \`llmwiki compile --report ${run.runId}\``];
  output.header("Compilation complete");
  output.status("✓", output.success(`${counts.compiled} compiled, ${counts.unchanged} skipped, ${counts.deleted} deleted (batch run ${run.runId})`));
  return { compiled: counts.compiled, skipped: counts.unchanged, deleted: counts.deleted, concepts: [], pages: [], errors, mode: "batch", batch: { runId: run.runId, phase: run.meta.phase, counts } };
}

/** Run the batch compile of the project at `root` under the lock it already holds. */
async function compileLocked(root: string, options: CompileOptions & BatchRunOptions): Promise<BatchCompileResult> {
  const recovery = await recoverJournalBeforeCompile(root);
  if (recovery.status === "unsafe") throw new JournalUnsafeError("pre-compile journal recovery unsafe");
  return withRunSystemPolicy(options.systemPolicy, async () => {
    const fixed = await preflightBatch(root, options);
    const policy = await policyDigest(root, fixed.schema, fixed.reviewPolicy, options.systemPolicy);
    const run = await selectRun({ root, reads: fixed.reads, policy, batchSize: options.batchSize ?? DEFAULT_BATCH_SIZE, restart: options.restart === true });
    const context: BatchContext = { ...fixed, run };
    await runPhases(context);
    return resultOf(context);
  });
}

/** The batch compile of the project at `root` (see the file comment). */
export async function compileBatch(root: string, options: CompileOptions & BatchRunOptions = {}): Promise<CompileResult> {
  output.header("llmwiki compile");
  assertSupportedBatchOptions(options);
  if (!(await acquireMutationLock(root, "ordinary"))) {
    output.status("!", output.error("Could not acquire lock. Try again later."));
    return { compiled: 0, skipped: 0, deleted: 0, concepts: [], pages: [], errors: ["Could not acquire .llmwiki/lock — another compile is in progress."] };
  }
  try {
    return await compileLocked(root, options);
  } finally {
    await releaseLock(root);
  }
}
