/**
 * Versioned answer-body diagnostics and internal resolution snapshot contracts.
 * Identities reuse the viewer's existing PageId; a report describes link targets,
 * not factual support or permission to publish a generated answer.
 */
import type { PageId } from "../viewer/types.js";

/** Retained default page metadata in production collector order. */
export interface RetainedCitationTarget {
  id: PageId;
  pageDirectory: "concepts" | "queries";
  slug: string;
  aliases?: readonly string[];
}

/** Exact normalized eventual target of an admitted default/query proposal. */
export interface PendingCitationTarget { target: string; candidateId: string }

/** Fresh resolution data; collecting it never acquires a mutation lock. */
export interface AnswerCitationIndex {
  retained: readonly RetainedCitationTarget[];
  pending: readonly PendingCitationTarget[];
}

/** One unique normalized target recognized in the answer body. */
export type AnswerCitation =
  | { target: string; status: "resolved"; pageId: PageId }
  | { target: string; status: "pending"; candidateIds: string[] }
  | { target: string; status: "broken" };

/** Diagnostics in first-occurrence order; an empty list is not verified support. */
export interface AnswerCitationReport { version: 1; citations: AnswerCitation[] }
