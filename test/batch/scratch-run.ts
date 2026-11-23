/**
 * @file test/batch/scratch-run.ts
 * @description A SCRATCH batch run: a new, active run store of a test project
 * with a placeholder identity, for tests that drive one batch phase or step
 * directly (the index step, the bounded reads) instead of a whole compile.
 * Vitest-free, so a plain child fixture may import it too.
 */

import { BatchRun } from "../../src/compiler/batch/run-store.js";

/** The placeholder identity a scratch run records (it drives a step directly, so no real inputs bind it). */
const SCRATCH_IDENTITY = { policy: "p", sources: null, cstate: "c" };

/** A new (active) scratch batch run of the project at `project`. */
export function newScratchBatchRun(project: string): Promise<BatchRun> {
  return BatchRun.create(project, { batchSize: 10, embeddings: false, identity: SCRATCH_IDENTITY });
}
