/**
 * Query publication owns the existing mutation lock and the direct-save profile
 * gate. Only a fresh strict citation check can authorize writing or staging the
 * canonical document. Reviewed staging is allowed in profile-enabled projects
 * because a review candidate is the trust-routed destination: approval routes
 * through the planner. Refusals are answer-preserving results; actual
 * persistence failures propagate.
 */
import { CitationPublicationError, validateCitationPublication, type CitationPublicationMode } from "../citations/answer-publication.js";
import type { AnswerCitationReport } from "../citations/answer-types.js";
import { loadNonDefaultProfile } from "../profile/block.js";
import { acquireMutationLockBlocking } from "../operation-bundles/lock-gate.js";
import { releaseLock } from "../utils/lock.js";
import type { QueryResult } from "../utils/types.js";
import * as output from "../utils/output.js";
import { buildQueryDocument } from "./query-document.js";
import { slugify } from "../utils/markdown.js";
import { saveQueryPageLocked } from "./query-save.js";
import { stageQueryProposal } from "./query-proposal.js";

interface QueryPublicationOptions {
  root: string;
  question: string;
  answer: string;
  save: boolean;
  review?: boolean;
  document?: string;
}

type PublicationResult = Pick<QueryResult, "saved" | "candidateId" | "publicationRefusal">;
type PublicationRefusal = NonNullable<QueryResult["publicationRefusal"]>;
let afterDefaultProfileCheckForTest: (() => Promise<void>) | undefined;

/** Reject an invalid reviewed-save request before provider or filesystem work. */
export function assertQuerySaveOptions(options: { save?: boolean; review?: boolean }): void {
  if (options.review && !options.save) throw new Error("Query review requires save.");
}

/** Test-only seam after the under-lock profile decision, before fresh resolution. */
export function setQuerySaveTestHookForTest(hook: (() => Promise<void>) | undefined): void {
  afterDefaultProfileCheckForTest = hook;
}

/** Refuse profile-disabled direct writes with the existing actionable warning. */
function profileRefusal(): PublicationResult {
  const message = "query --save is disabled in profile-enabled projects (the saved-query "
    + "write path is not yet trust-routed). Run without --save, or use the default profile.";
  output.status("!", output.warn(message));
  return { publicationRefusal: { code: "profile-disabled", targets: [], message } };
}

/** Recover only validation failure; page/index/embedding/log writes are outside. */
async function checkCitations(root: string, document: string, mode: CitationPublicationMode, targetSlug: string): Promise<
  { report: AnswerCitationReport } | { publicationRefusal: PublicationRefusal }
> {
  try {
    return { report: await validateCitationPublication(root, document, mode, targetSlug) };
  } catch (error) {
    if (error instanceof CitationPublicationError) {
      return { publicationRefusal: { code: error.code, targets: error.targets, message: error.message } };
    }
    const detail = error instanceof Error ? error.message : String(error);
    return { publicationRefusal: { code: "unavailable", targets: [], message: `Answer publication refused: citation validation unavailable (${detail})` } };
  }
}

/** Publish or stage on request only after the gates and fresh citations pass under one lock. */
export async function maybeSaveQueryPage(options: QueryPublicationOptions): Promise<PublicationResult> {
  const { root, question, answer, save, review } = options;
  if (!save) return {};
  await acquireMutationLockBlocking(root, "ordinary");
  try {
    // Only the direct write is gated by the profile: a reviewed proposal is the
    // trust-routed destination and its approval goes through the planner.
    if (!review && await loadNonDefaultProfile(root)) return profileRefusal();
    await afterDefaultProfileCheckForTest?.();
    const document = options.document ?? buildQueryDocument(question, answer, new Date().toISOString()).document;
    const validation = await checkCitations(root, document, review ? "proposal" : "direct", slugify(question));
    if ("publicationRefusal" in validation) return validation;
    if (review) return { candidateId: await stageQueryProposal({ root, question, document, report: validation.report }) };
    return { saved: await saveQueryPageLocked(root, question, document) };
  } finally {
    await releaseLock(root);
  }
}
