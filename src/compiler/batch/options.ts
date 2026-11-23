/**
 * @file src/compiler/batch/options.ts
 * @description The options a batch compile does not implement, and the
 * checks that refuse them. They read no project file and write nothing, so a caller can
 * run it before a provider credential check and before any lock: the driver
 * runs it again under its own preflight, which stays authoritative.
 */

import { embeddingsDisabled } from "../../utils/embeddings-config.js";
import type { CompileOptions } from "../../utils/types.js";
import { BatchCompileError, DEFAULT_BATCH_SIZE, MAX_BATCH_SIZE, type BatchRunOptions } from "./contracts.js";

/** Incumbent options the batch route does not support, each with how a refusal names it. */
const UNSUPPORTED_OPTIONS: ReadonlyArray<readonly [(options: CompileOptions) => boolean, string]> = [
  [(o) => o.review === true, "--review"],
  [(o) => o.changeFilter !== undefined, "a change filter (refresh --stale)"],
  [(o) => o.skipSeedPages === true, "skipping seed pages"],
  [(o) => o.noPagesLimit === true, "--no-pages-limit (its concept withdrawal is not implemented for a batch run)"],
];

/** Refuse an incumbent option the batch route does not support. Pure: reads nothing and changes nothing. */
export function assertSupportedBatchOptions(options: CompileOptions & BatchRunOptions): void {
  const unsupported = UNSUPPORTED_OPTIONS.find(([present]) => present(options))?.[1] ?? null;
  if (unsupported !== null) throw new BatchCompileError("compile_batch_unsupported_option", `${unsupported} is not supported by a batch compile of a segmented project`);
  const size = options.batchSize ?? DEFAULT_BATCH_SIZE;
  if (!Number.isInteger(size) || size < 1 || size > MAX_BATCH_SIZE) throw new BatchCompileError("compile_batch_unsupported_option", `the batch size must be an integer from 1 to ${MAX_BATCH_SIZE}`);
}

/**
 * Refuse a batch compile that would refresh embeddings: the incumbent drain
 * holds the whole pending set and page set, so it is not bounded. A supported
 * option limit, actionable with `--no-embeddings` (`embeddings: false`).
 */
export function assertBatchEmbeddingsOff(options: CompileOptions): void {
  if (options.embeddings === false || embeddingsDisabled()) return;
  throw new BatchCompileError("compile_batch_unsupported_option", "a batch compile of a segmented project does not refresh embeddings (the refresh is not bounded); re-run with --no-embeddings (SDK: embeddings: false)");
}
