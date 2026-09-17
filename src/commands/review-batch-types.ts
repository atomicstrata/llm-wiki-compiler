/**
 * Versioned file and result contract for review approve-batch. A response has
 * one result per unique input ID in first-occurrence order. Validation refusals
 * can coexist with approvals; technical failures stop the shared operation.
 * Finalized describes the derived-artifact tail, not atomic cleanup or a Git
 * commit. No durable receipt is promised after candidates have been removed.
 */

import { isPlainObject } from "../utils/state.js";
import type { ReviewFinalizeTimings } from "./review-finalize.js";

/** Manifest/result schema understood by this command. */
export const REVIEW_BATCH_SCHEMA_VERSION = 1;

/** Bound validation and the mutation work admitted by one approval operation. */
export const REVIEW_BATCH_MAX_CANDIDATES = 100;

/** Cap manifest decoding independently of the number of candidate entries. */
export const REVIEW_BATCH_MAX_INPUT_BYTES = 1024 * 1024;

/** One approval intent; supplied hashes bind even non-connector candidate bodies. */
export interface ReviewBatchItem {
  id: string;
  draftContentHash?: string;
}

/** Input file schema for a batch approval. */
export interface ReviewBatchManifest {
  schemaVersion: typeof REVIEW_BATCH_SCHEMA_VERSION;
  candidates: ReviewBatchItem[];
}

/** Per-candidate outcome; failed means a shared technical phase did not complete. */
export interface ReviewBatchCandidateResult {
  id: string;
  status: "approved" | "invalid" | "conflict" | "failed";
  pagePath?: string;
  error?: string;
}

/** Measured phases; absent phases were not reached, and failed phases retain timing. */
export interface ReviewBatchTimings extends Partial<ReviewFinalizeTimings> {
  lockWait?: number;
  recovery?: number;
  validation?: number;
  promotion?: number;
  cleanup?: number;
  total: number;
}

/** Machine-readable envelope emitted once, including for technical failures. */
export interface ReviewBatchResult {
  schemaVersion: typeof REVIEW_BATCH_SCHEMA_VERSION;
  status: "completed" | "partial" | "failed";
  finalized: boolean;
  results: ReviewBatchCandidateResult[];
  timingsMs: ReviewBatchTimings;
  error?: string;
}

/** Parse the complete manifest before taking a lock or mutating the wiki. */
export function parseReviewBatchManifest(value: unknown): ReviewBatchManifest {
  if (!isPlainObject(value) || value.schemaVersion !== REVIEW_BATCH_SCHEMA_VERSION ||
      !Array.isArray(value.candidates)) {
    throw new Error("Expected {schemaVersion: 1, candidates: [{id, draftContentHash?}]}.");
  }
  if (value.candidates.length > REVIEW_BATCH_MAX_CANDIDATES) {
    throw new Error(`Batch manifest exceeds the limit of ${REVIEW_BATCH_MAX_CANDIDATES} candidate entries.`);
  }
  if (!value.candidates.every(isReviewBatchItem)) {
    throw new Error("Expected candidate entries shaped as {id, draftContentHash?}.");
  }
  return { schemaVersion: REVIEW_BATCH_SCHEMA_VERSION, candidates: value.candidates };
}

/** Validate field types without treating an unsafe ID as a whole-manifest failure. */
function isReviewBatchItem(value: unknown): value is ReviewBatchItem {
  return isPlainObject(value) && typeof value.id === "string" &&
    (value.draftContentHash === undefined || typeof value.draftContentHash === "string");
}
