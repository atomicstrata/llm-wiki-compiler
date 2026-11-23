/**
 * @file src/compiler/batch/phases.ts
 * @description The PHASE DISPATCH of a batch compile: each phase of
 * `BATCH_PHASES` runs its module from the run's committed cursor and advances
 * the run, until it is `done`. Every phase before the state commit reads ONE
 * snapshot of the compile state (the state the run started from, which a
 * resumed run has just revalidated), FULLY VERIFIED with bounded memory
 * before this attempt's first effect, so a corrupt owner, order or frozen
 * index refuses rather than being processed. A resumed attempt re-walks and
 * re-hashes its sources against its complete listing before its first phase
 * after the listing. When the listing finishes, its source-set digest joins
 * the run's identity.
 */

import type { ReviewPolicy } from "../../review/policy.js";
import type { SchemaConfig } from "../../schema/index.js";
import type { LegacyLocalReads } from "../../storage/legacy-local-reads.js";
import type { CompileOptions } from "../../utils/types.js";
import { batchAccess, type RelatedPageV1 } from "./access.js";
import { runClosure } from "./closure.js";
import { CompileStateError } from "../../cstate/contracts.js";
import { verifyCompileState } from "../../cstate/verify.js";
import { BATCH_PHASES, type BatchPhase } from "./contracts.js";
import { runDeletionOrphans } from "./deletions.js";
import { assertListingCurrent, runDetection, runListing, sourceSetDigest } from "./detect.js";
import { runExtraction } from "./extract.js";
import { runFreeze } from "./freeze.js";
import { runGeneration } from "./generate.js";
import { runGenerationPlan } from "./generation-plan.js";
import { runRepair } from "./repair.js";
import { runResidual } from "./residual.js";
import { runResolve } from "./resolve.js";
import type { BatchRun } from "./run-store.js";
import { runSeeds } from "./seeds.js";
import { runStateFinalize } from "./state-finalize.js";
import { runOrphanFrozen, runStatePlan } from "./state-plan.js";
import { StateSnapshot } from "./state-reads.js";

/** Everything the phases of one run work with. */
export interface BatchContext {
  readonly root: string;
  readonly reads: LegacyLocalReads;
  readonly schema: SchemaConfig;
  readonly reviewPolicy: ReviewPolicy;
  readonly options: CompileOptions;
  readonly concurrency: number;
  readonly run: BatchRun;
}

/** One phase's body. */
type PhaseBody = (context: BatchContext, state: StateSnapshot) => Promise<void>;

/** The related-page snapshot the plan recorded (at most the incumbent's few pages). */
async function relatedPages(run: BatchRun): Promise<RelatedPageV1[]> {
  const related: RelatedPageV1[] = [];
  for await (const row of run.scan("rp:")) related.push(row.v as RelatedPageV1);
  return related;
}

/** Record the finished listing's source-set digest in the identity (once, also after a crash right after the listing). */
async function recordSourceDigest(run: BatchRun): Promise<void> {
  if (run.meta.phase === "listing" || run.meta.identity.sources !== null) return;
  await run.checkpoint({ identity: { ...run.meta.identity, sources: await sourceSetDigest(run) } });
}

/** Whether unchanged sources may reuse their committed extraction (the incumbent `reusableSourceFiles` gate, review mode excluded). */
const reuseAllowed = (run: BatchRun, state: StateSnapshot): boolean => state.meta.frozen === 0 && run.counters.deleted === 0;

/** Every phase's body. */
const BODIES: Readonly<Record<Exclude<BatchPhase, "done" | "superseded">, PhaseBody>> = {
  listing: ({ run, root, reads }) => runListing(run, root, reads),
  detect: ({ run, reads }, state) => runDetection(run, state, reads),
  closure: ({ run }, state) => runClosure(run, state),
  "orphan-deleted": ({ run }, state) => runDeletionOrphans(run, state),
  extract: ({ run, concurrency }, state) => runExtraction({ run, state, access: batchAccess(run), concurrency, reuseAllowed: reuseAllowed(run, state) }),
  freeze: ({ run }, state) => runFreeze(run, state),
  "plan-generation": ({ run, reads }) => runGenerationPlan(run, reads),
  generate: async ({ run, schema, reviewPolicy, options, concurrency }) => runGeneration({ run, access: batchAccess(run, await relatedPages(run)), schema, policy: reviewPolicy, options, concurrency }),
  "plan-state": ({ run }, state) => runStatePlan(run, state),
  "orphan-frozen": ({ run }, state) => runOrphanFrozen(run, state),
  seeds: ({ run, schema }) => runSeeds(run, schema),
  resolve: ({ run }) => runResolve(run),
  repair: ({ run }) => runRepair(run),
  "finalize-state": ({ run }, state) => runStateFinalize(run, state),
  residual: ({ run }) => runResidual(run),
};

/** Whether a run in `phase` still reads the compile state it started from (up to and including its state commit). */
const readsState = (phase: BatchPhase): boolean => BATCH_PHASES.indexOf(phase as (typeof BATCH_PHASES)[number]) <= BATCH_PHASES.indexOf("finalize-state");

/** The compile state the phases read, fully verified (bounded memory) before any effect of this attempt. */
async function verifiedState(context: BatchContext): Promise<StateSnapshot> {
  if (readsState(context.run.meta.phase)) {
    const verification = await verifyCompileState(context.root);
    if (!verification.ok) throw new CompileStateError("compile_state_unavailable", `the segmented compile state failed verification (${verification.problems.slice(0, 3).join("; ")}); nothing was written; inspect it with llmwiki catalog verify`);
  }
  return StateSnapshot.open(context.root);
}

/** Before a resumed attempt's first phase after the listing: its complete listing must still be the sources. */
async function checkListingOnce(context: BatchContext, checked: { done: boolean }): Promise<void> {
  if (checked.done || context.run.meta.phase === "listing" || context.run.meta.attempts.length < 2) return;
  await assertListingCurrent(context.run, context.reads);
  checked.done = true;
}

/** Run the run's phases from its committed phase until it is done. */
export async function runPhases(context: BatchContext): Promise<void> {
  const state = await verifiedState(context);
  const checked = { done: false };
  for (let phase = context.run.meta.phase; phase !== "done" && phase !== "superseded"; phase = context.run.meta.phase) {
    await checkListingOnce(context, checked);
    await recordSourceDigest(context.run);
    await BODIES[phase](context, state);
  }
}
