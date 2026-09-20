/**
 * @file src/commands/query-save.ts
 * @description The `query --save` write path — persists a generated answer as a
 * `wiki/queries/<slug>.md` page and refreshes the index/embeddings so the answer
 * is immediately retrievable.
 *
 * Split out of `query.ts` to keep that command file within the project size
 * budget; the answer-generation pipeline stays in `query.ts` and calls
 * {@link maybeSaveQueryPage} once the answer is produced.
 */

import path from "path";
import { atomicWrite, slugify } from "../utils/markdown.js";
export { summarizeAnswer } from "./query-document.js";
import { generateIndex } from "../compiler/indexgen.js";
import { updateEmbeddingsLockedCore } from "../utils/embeddings.js";
import { qualifiedPageId } from "../utils/page-id.js";
import { handleSafeEmbeddingFailure } from "../utils/embeddings-batch.js";
import { QUERIES_DIR } from "../utils/constants.js";
import * as output from "../utils/output.js";

/**
 * Save a query answer as a wiki page in the queries/ directory,
 * then regenerate the wiki index so the answer is immediately retrievable.
 *
 * NOTE: This path writes directly to wiki/queries/ with NO trust-routed planner
 * evaluation. It is gated by {@link maybeSaveQueryPage}, which DISABLES the save
 * in profile-enabled (non-default-profile) projects and holds the project lock
 * around the default-profile decision and write. Do not call this directly from
 * an unlocked or profile-enabled context — route through {@link maybeSaveQueryPage}.
 *
 * @param root - Absolute path to the project root directory.
 * @param question - The original question used as the page title.
 * @param document - The canonical serialized query document.
 */
export async function saveQueryPageLocked(root: string, question: string, document: string): Promise<string> {
  const slug = slugify(question);
  const filePath = path.join(root, QUERIES_DIR, `${slug}.md`);

  await atomicWrite(filePath, document);

  output.status("+", output.success(`Saved query → ${output.source(filePath)}`));

  // Regenerate the index so the saved query is immediately discoverable
  // by the next query's page-selection step.
  await generateIndex(root);

  // Index the new query so semantic search retrieves it on the next question.
  // maybeSaveQueryPage already holds the project lock, so call the lock-free
  // core. The saved page lives under wiki/queries/, so qualify it under `queries/`.
  // Non-critical: embedding failures (e.g. missing VOYAGE_API_KEY) don't block save.
  try {
    await updateEmbeddingsLockedCore(root, [qualifiedPageId(path.basename(QUERIES_DIR), slug)]);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    handleSafeEmbeddingFailure(err, `Skipped embeddings update: ${message}`);
  }

  return slug;
}
