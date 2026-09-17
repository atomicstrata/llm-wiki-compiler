/**
 * Bounded manifest input for batch approval. A user-selected manifest may live
 * outside the project, so its parent is the read root. The shared confined
 * reader binds the regular file's identity, refuses symlink leaves and FIFOs,
 * and reads at most one byte beyond the cap even if the file grows mid-read.
 * Validation finishes before any project lock or journal recovery is attempted.
 */

import path from "node:path";
import { readConfinedLeaf } from "../utils/confined-read.js";
import {
  parseReviewBatchManifest,
  REVIEW_BATCH_MAX_INPUT_BYTES,
  type ReviewBatchManifest,
} from "./review-batch-types.js";

/** Read one regular, bounded UTF-8 manifest and validate its version and entries. */
export async function readReviewBatchManifest(input: string): Promise<ReviewBatchManifest> {
  const file = path.resolve(input);
  const directory = path.dirname(file);
  const result = await readConfinedLeaf(directory, file, directory, REVIEW_BATCH_MAX_INPUT_BYTES);
  if (result.kind === "absent") throw new Error("Batch manifest does not exist.");
  if (result.kind !== "ok") {
    throw new Error(`Batch manifest must be a readable regular UTF-8 file no larger than ${REVIEW_BATCH_MAX_INPUT_BYTES} bytes.`);
  }
  return parseReviewBatchManifest(JSON.parse(result.body));
}
