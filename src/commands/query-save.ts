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
import { readFile } from "fs/promises";
import { atomicWrite, slugify, buildFrontmatter } from "../utils/markdown.js";
import { sha256Text } from "../connectors/hash.js";
import { writeCandidate } from "../compiler/candidates.js";
import { generateIndex } from "../compiler/indexgen.js";
import { updateEmbeddingsLockedCore } from "../utils/embeddings.js";
import { qualifiedPageId } from "../utils/page-id.js";
import { handleSafeEmbeddingFailure } from "../utils/embeddings-batch.js";
import { loadNonDefaultProfile } from "../profile/block.js";
import { acquireMutationLockBlocking } from "../operation-bundles/lock-gate.js";
import { QUERIES_DIR } from "../utils/constants.js";
import { releaseLock } from "../utils/lock.js";
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
 * Build the full query-page document — `type: query` frontmatter plus the
 * answer body — shared by the direct-write and the `--review` proposal paths so
 * an approved candidate lands byte-identically to what a direct save would write.
 * @param question - The original question (page title).
 * @param answer - The generated answer body.
 * @returns The complete markdown document (frontmatter + answer).
 */
function buildQueryDocument(question: string, answer: string): string {
  const frontmatter = buildFrontmatter({
    title: question,
    summary: summarizeAnswer(answer),
    type: "query",
    createdAt: new Date().toISOString(),
  });
  return `${frontmatter}\n\n${answer}\n`;
}

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
 * @param answer - The generated answer body.
 */
async function saveQueryPageLocked(root: string, question: string, answer: string): Promise<string> {
  const slug = slugify(question);
  const filePath = path.join(root, QUERIES_DIR, `${slug}.md`);

  await atomicWrite(filePath, buildQueryDocument(question, answer));

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

let afterDefaultProfileCheckForTest: (() => Promise<void>) | undefined;

/** Test-only seam used to prove the save gate holds the project lock. */
export function setQuerySaveTestHookForTest(hook: (() => Promise<void>) | undefined): void {
  afterDefaultProfileCheckForTest = hook;
}

/**
 * Propose the answer as a review candidate under `.llmwiki/candidates/` instead
 * of writing `wiki/queries/` directly — the crystallizing `--review` path. The
 * candidate's body is the same document a direct save would write, so approving
 * it with `llmwiki review approve <id>` lands `wiki/queries/<slug>.md`
 * byte-for-byte. Nothing is live until approval, so the index and embeddings are
 * NOT refreshed here, and unlike the direct write this path is allowed in
 * profile-enabled projects — a review candidate IS the trust-routed destination.
 * @param root - Absolute project root directory.
 * @param question - The original question (page title).
 * @param answer - The generated answer body.
 * @returns The proposed candidate's id (the handle `review approve` takes).
 */
/** A CLOSED precondition on the query page: its digest, or an explicit expect-absent. */
type QueryTargetPrecondition = { expectedTargetHash: string } | { expectTargetAbsent: true };

/**
 * Capture a CLOSED precondition on the target query page: its content digest
 * when it exists, or an explicit expect-absent when it does not (ENOENT ONLY).
 * Any OTHER read error (a permission or I/O failure) is a refusal to propose —
 * a precondition we cannot capture must never silently fail open, which would
 * let approval blind-overwrite a page that appeared after the proposal.
 */
async function captureQueryPrecondition(root: string, slug: string): Promise<QueryTargetPrecondition> {
  try {
    return { expectedTargetHash: sha256Text(await readFile(path.join(root, QUERIES_DIR, `${slug}.md`), "utf8")) };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { expectTargetAbsent: true };
    throw err;
  }
}

async function proposeQueryPageLocked(root: string, question: string, answer: string): Promise<string> {
  const slug = slugify(question);
  // Capture the target page's state as a CLOSED precondition so approval REFUSES
  // if the page was edited OR created between this proposal and approval, rather
  // than blind-overwriting whatever bytes are live at approval time.
  const precondition = await captureQueryPrecondition(root, slug);
  const candidate = await writeCandidate(root, {
    title: question,
    slug,
    summary: summarizeAnswer(answer),
    sources: [],
    body: buildQueryDocument(question, answer),
    targetDirectory: "queries",
    reviewMode: "forced",
    heldReasons: [{ code: "manual-review-requested" }],
    ...precondition,
  });
  output.status(
    "→",
    output.info(`Proposed query as review candidate ${output.source(candidate.id)}. ` +
      `Apply with: llmwiki review approve ${candidate.id}`),
  );
  return candidate.id;
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
  review = false,
): Promise<string | undefined> {
  if (!save) return undefined;
  await acquireMutationLockBlocking(root, "ordinary");
  try {
    // The `--review` path proposes a candidate rather than writing wiki/, so it
    // is NOT subject to the direct-write profile gate — the candidate IS the
    // trust-routed destination — and it returns the candidate id, not a slug.
    // `return await` so a rejection settles INSIDE the try — the finally then
    // releases the lock in order, with no unhandled-rejection window.
    if (review) return await proposeQueryPageLocked(root, question, answer);
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
    await afterDefaultProfileCheckForTest?.();
    return await saveQueryPageLocked(root, question, answer);
  } finally {
    await releaseLock(root);
  }
}
