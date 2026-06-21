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
import { atomicWrite, slugify, buildFrontmatter } from "../utils/markdown.js";
import { generateIndex } from "../compiler/indexgen.js";
import { updateEmbeddings } from "../utils/embeddings.js";
import { handleSafeEmbeddingFailure } from "../utils/embeddings-batch.js";
import { loadNonDefaultProfile } from "../profile/block.js";
import { QUERIES_DIR } from "../utils/constants.js";
import * as output from "../utils/output.js";

/**
 * Generate a one-line summary from the answer for use in the wiki index.
 * Takes the first sentence (up to 120 chars) so the page-selection LLM
 * has retrieval signal beyond just the title.
 * @param answer - The full answer text.
 * @returns A short summary string.
 */
export function summarizeAnswer(answer: string): string {
  const firstLine = answer.trim().split(/\n/)[0] ?? "";
  const firstSentence = firstLine.split(/(?<=[.!?])\s/)[0] ?? firstLine;
  return firstSentence.slice(0, 120);
}

/**
 * Save a query answer as a wiki page in the queries/ directory,
 * then regenerate the wiki index so the answer is immediately retrievable.
 *
 * NOTE: This path writes directly to wiki/queries/ with NO trust-routed planner
 * evaluation. It is gated by {@link maybeSaveQueryPage}, which DISABLES the save
 * in profile-enabled (non-default-profile) projects; for the default profile it
 * is the deliberate user-initiated write it has always been. Do not call this
 * directly from a profile-enabled context — route through {@link maybeSaveQueryPage}.
 *
 * @param root - Absolute path to the project root directory.
 * @param question - The original question used as the page title.
 * @param answer - The generated answer body.
 */
async function saveQueryPage(root: string, question: string, answer: string): Promise<string> {
  const slug = slugify(question);
  const filePath = path.join(root, QUERIES_DIR, `${slug}.md`);

  const frontmatter = buildFrontmatter({
    title: question,
    summary: summarizeAnswer(answer),
    type: "query",
    createdAt: new Date().toISOString(),
  });

  const document = `${frontmatter}\n\n${answer}\n`;
  await atomicWrite(filePath, document);

  output.status("+", output.success(`Saved query → ${output.source(filePath)}`));

  // Regenerate the index so the saved query is immediately discoverable
  // by the next query's page-selection step.
  await generateIndex(root);

  // Index the new query so semantic search retrieves it on the next question.
  // Non-critical: embedding failures (e.g. missing VOYAGE_API_KEY) don't block save.
  try {
    await updateEmbeddings(root, [slug]);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    handleSafeEmbeddingFailure(err, `Skipped embeddings update: ${message}`);
  }

  return slug;
}

/**
 * Persist the answer as a query page when `--save` is set, EXCEPT in
 * profile-enabled (non-default-profile) projects where the saved-query write
 * path is not yet Trust-Guard-routed.
 *
 * Per CLP plan D7 / spec-07 the save is the spec-permitted DISABLED option in
 * those projects: the answer is still returned to the caller; only the wiki
 * write is refused, with an actionable message. Default-profile projects are
 * unaffected and save exactly as before.
 *
 * @param root - Absolute project root directory.
 * @param question - The original question (page title).
 * @param answer - The generated answer body.
 * @param save - Whether `--save` was requested.
 * @returns The saved slug, or `undefined` when not saved (not requested or disabled).
 */
export async function maybeSaveQueryPage(
  root: string,
  question: string,
  answer: string,
  save: boolean,
): Promise<string | undefined> {
  if (!save) return undefined;
  if (await loadNonDefaultProfile(root)) {
    output.status(
      "!",
      output.warn(
        "query --save is disabled in profile-enabled projects (the saved-query " +
          "write path is not yet trust-routed). Run without --save, or use the " +
          "default profile.",
      ),
    );
    return undefined;
  }
  return saveQueryPage(root, question, answer);
}
