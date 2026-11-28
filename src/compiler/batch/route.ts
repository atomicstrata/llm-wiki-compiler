/**
 * @file src/compiler/batch/route.ts
 * @description Which compile body a project's compile takes: the BATCH
 * compile (`./driver.ts`) exactly when its segmented compile state is the
 * authority (`compileStateSegmented`: an active `local-indexed` project whose
 * scale record carries a ready `segmented-compile-state-1` capability), the
 * incumbent body otherwise. The batch-only options refuse, before any effect,
 * on a project the incumbent body compiles, so an ordinary project's compile
 * is unchanged.
 */

import { compileStateSegmented } from "../../cstate/records.js";
import type { CompileOptions } from "../../utils/types.js";
import { BatchCompileError, type BatchRunOptions } from "./contracts.js";
import { assertBatchEmbeddingsOff, assertSupportedBatchOptions } from "./options.js";

/** Whether the compile of `root` takes the batch body; batch-only options on an incumbent project refuse. */
export async function routesToBatch(root: string, options: BatchRunOptions): Promise<boolean> {
  if (await compileStateSegmented(root)) return true;
  if (options.batchSize !== undefined || options.restart === true) {
    throw new BatchCompileError("compile_batch_unsupported_option", "--batch-size and --restart apply only to a project whose segmented compile state is ready (llmwiki scale prepare --capability segmented-compile-state-1)");
  }
  return false;
}

/**
 * The EARLY, read-only refusal of a compile's options: batch-only options on a
 * project the incumbent body compiles, and on a batch project the options a
 * batch run does not implement (an embeddings refresh among them). A caller
 * runs it before its provider credential check, so an unsupported option
 * answers with its own actionable refusal and needs no credentials. It takes
 * no lock and changes nothing; the compile repeats every check under its lock.
 */
export async function assertCompileOptionsRoutable(root: string, options: CompileOptions & BatchRunOptions): Promise<void> {
  if (!(await routesToBatch(root, options))) return;
  assertSupportedBatchOptions(options);
  assertBatchEmbeddingsOff(options);
}
