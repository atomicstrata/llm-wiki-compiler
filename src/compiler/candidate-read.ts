/**
 * Review candidate READ, list, and sanitize/validate path.
 *
 * This is the load half of the candidate store (the write/dedup/identity half
 * lives in {@link file://./candidates.ts}). It parses one candidate JSON file at
 * a time, defends every consumed field at the IO boundary so a hand-edited or
 * legacy file can never crash downstream consumers (`review list`, `review
 * show`, `listCandidates`), and exposes the load helpers the review subcommands
 * share (`loadCandidateOrFail`, `loadCandidateUnderLockOrFail`).
 *
 * It imports only the shared path resolvers ({@link file://./candidate-paths.ts})
 * and never imports the write module, so `candidates.ts` can re-export these
 * symbols without forming an import cycle.
 */

import {
  listCandidateFileIds,
} from "../utils/candidate-store.js";
import {
  resolveConfinedCandidatesDir,
} from "./candidate-store-paths.js";
import { candidatePath } from "./candidate-paths.js";
import { safeReadFile } from "../utils/markdown.js";
import * as output from "../utils/output.js";
import { CANDIDATES_DIR } from "../utils/constants.js";
import type { ReviewCandidate, SourceState } from "../utils/types.js";
import type { HeldReason, PolicyHeldReasonCode, ReviewMode } from "../review/policy.js";
import type { TrustDecision } from "../trust/decision.js";

/** Default metadata for legacy `compile --review` callers. */
export const DEFAULT_HELD_REASONS: HeldReason[] = [{ code: "manual-review-requested" }];

/** All valid ReviewMode values. */
const VALID_REVIEW_MODES: ReviewMode[] = ["policy", "forced", "imported", "connector"];

/** All valid PolicyHeldReasonCode values — mirrors the closed union in policy.ts. */
const VALID_HELD_REASON_CODES: PolicyHeldReasonCode[] = [
  "low-confidence",
  "contradicted",
  "schema-violating",
  "provenance-violating",
  "all",
  "manual-review-requested",
  "imported-okf",
  "connector-fetched",
];

/** All valid TrustDecision values — mirrors the closed union in trust/decision.ts. */
const VALID_TRUST_DECISIONS: TrustDecision[] = [
  "allow",
  "allow-with-warning",
  "stage-for-review",
  "quarantine",
  "deny",
];

/** Strict lowercase sha256 hex string. */
const SHA256_HEX = /^[0-9a-f]{64}$/;

/** Find the pending candidate for a slug, if one exists. */
export async function readCandidateBySlug(
  root: string,
  slug: string,
): Promise<ReviewCandidate | null> {
  const candidates = await listCandidates(root);
  return candidates.find((candidate) => candidate.slug === slug) ?? null;
}

/**
 * Collect the slugs of pending candidates whose approval lands in a
 * link-resolvable directory (default concepts/queries). Typed candidates
 * (those carrying `targetEntityType`) are EXCLUDED: typed pages are not part
 * of the concepts/queries wikilink interlinking system (see
 * {@link file://./../sdk/types.ts}), so approving one would NOT make a
 * `[[link]]` resolve. Including their slugs here would wrongly demote a real
 * broken wikilink to an info-level "awaiting review" — hiding a link that
 * stays broken after approval.
 */
export async function listLinkResolvablePendingSlugs(root: string): Promise<Set<string>> {
  const candidates = await listCandidates(root);
  return new Set(
    candidates.filter((candidate) => !candidate.targetEntityType).map((candidate) => candidate.slug),
  );
}

/**
 * Emit a CLI error, set exit code 1, and return null. Used by candidate load
 * helpers to avoid duplicating the error-path boilerplate.
 * @param message - Error message to display.
 */
function failWithError(message: string): null {
  output.status("!", output.error(message));
  process.exitCode = 1;
  return null;
}

/**
 * Load a candidate by id and, if missing, emit the standard "not found" CLI
 * error and set process.exitCode = 1. Returns null when the candidate is
 * missing so callers can early-return without re-implementing the same
 * error block in every review subcommand.
 * @param root - Project root directory.
 * @param id - Candidate id to look up.
 */
export async function loadCandidateOrFail(
  root: string,
  id: string,
): Promise<ReviewCandidate | null> {
  const candidate = await readCandidate(root, id);
  if (!candidate) return failWithError(`Candidate not found: ${id}`);
  return candidate;
}

/**
 * Re-read a candidate under the lock and abort if it has disappeared.
 *
 * This is the authoritative TOCTOU guard: a concurrent approve or reject may
 * have removed the candidate after the pre-lock fast-fail but before the lock
 * was acquired. Returning `null` signals the caller to abort without writing
 * any output artefact.
 * @param root - Project root directory.
 * @param id - Candidate id to load.
 * @returns The candidate if still present, or `null` after setting exit code 1.
 */
export async function loadCandidateUnderLockOrFail(
  root: string,
  id: string,
): Promise<ReviewCandidate | null> {
  const candidate = await readCandidate(root, id);
  if (!candidate) {
    return failWithError(`Candidate ${id} was removed by another process during review.`);
  }
  return candidate;
}

/**
 * Parse a single candidate JSON file. Returns null when the file is missing.
 * Structurally invalid files (unparseable JSON or missing required fields) are
 * skipped with a warning rather than throwing, so `review list`/`show` never
 * crash due to a hand-edited or truncated candidate file.
 */
export async function readCandidate(
  root: string,
  id: string,
): Promise<ReviewCandidate | null> {
  const raw = await safeReadFile(await candidatePath(root, id));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as ReviewCandidate;
    if (!isValidCandidate(parsed)) {
      output.note(`[llmwiki] Skipping malformed candidate file: ${id}.json (missing required fields)`);
      return null;
    }
    return sanitizeCandidate(parsed);
  } catch {
    output.note(`[llmwiki] Skipping unparseable candidate file: ${id}.json`);
    return null;
  }
}

/**
 * Sanitize and default every consumed field at the IO boundary. Ensures that
 * user-edited or legacy candidate files can never crash downstream consumers
 * (review list, review show, listCandidates).
 *
 * Fields that can be safely defaulted are corrected in place:
 * - `generatedAt`: non-string values are replaced with a sentinel ISO string.
 * - `reviewMode`: unknown values default to `"forced"` (safe legacy assumption).
 * - `heldReasons`: non-array, missing, or entries with invalid codes are cleaned;
 *   if the result is empty after filtering, defaults to `DEFAULT_HELD_REASONS`.
 * - `sourceStates`: non-object values are treated as absent; entries with unsafe
 *   keys (path separators, `..` traversal) or invalid field types are dropped so
 *   approval can never write malformed state from a bad candidate file.
 */
function sanitizeCandidate(candidate: ReviewCandidate): ReviewCandidate {
  const generatedAt =
    typeof candidate.generatedAt === "string"
      ? candidate.generatedAt
      : new Date(0).toISOString();

  const reviewMode: ReviewMode = VALID_REVIEW_MODES.includes(candidate.reviewMode)
    ? candidate.reviewMode
    : "forced";

  const heldReasons = sanitizeHeldReasons(candidate.heldReasons);
  const sourceStates = sanitizeSourceStates(candidate.sourceStates);
  const connectorProvenance = sanitizeConnectorProvenance(candidate.connectorProvenance);

  const result: ReviewCandidate = { ...candidate, generatedAt, reviewMode, heldReasons };
  if (sourceStates !== undefined) result.sourceStates = sourceStates;
  else delete result.sourceStates;
  if (connectorProvenance !== undefined) result.connectorProvenance = connectorProvenance;
  else delete result.connectorProvenance;
  sanitizeTypedTarget(result);
  return result;
}

/** Validate connector provenance read from disk, dropping malformed values. */
function sanitizeConnectorProvenance(raw: unknown): ReviewCandidate["connectorProvenance"] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  const keys = [
    "connectorId",
    "connectorVersion",
    "sourceUrl",
    "fetchedAt",
    "contentHash",
    "draftContentHash",
    "idempotencyKey",
  ];
  for (const key of keys) {
    if (typeof value[key] !== "string") return undefined;
  }
  if (!SHA256_HEX.test(value.contentHash as string)) return undefined;
  if (!SHA256_HEX.test(value.draftContentHash as string)) return undefined;
  if (!SHA256_HEX.test(value.idempotencyKey as string)) return undefined;
  return {
    connectorId: value.connectorId as string,
    connectorVersion: value.connectorVersion as string,
    sourceUrl: value.sourceUrl as string,
    fetchedAt: value.fetchedAt as string,
    contentHash: value.contentHash as string,
    draftContentHash: value.draftContentHash as string,
    idempotencyKey: value.idempotencyKey as string,
  };
}

/**
 * Validate the Phase-2 typed-staging fields in place. Drops `targetEntityType`
 * unless it's a string and `trustDecision` unless it's a valid TrustDecision,
 * so a hand-edited or malformed candidate file can never carry junk metadata.
 * @param candidate - The candidate to sanitize (mutated in place).
 */
function sanitizeTypedTarget(candidate: ReviewCandidate): void {
  if (typeof candidate.targetEntityType !== "string") {
    delete candidate.targetEntityType;
  }
  if (!VALID_TRUST_DECISIONS.includes(candidate.trustDecision as TrustDecision)) {
    delete candidate.trustDecision;
  }
}

/** Filter `heldReasons` to only entries with a valid code shape; default when empty. */
function sanitizeHeldReasons(raw: unknown): HeldReason[] {
  if (!Array.isArray(raw)) return DEFAULT_HELD_REASONS;
  const valid = raw.filter(
    (r): r is HeldReason =>
      r !== null &&
      typeof r === "object" &&
      typeof (r as Record<string, unknown>).code === "string" &&
      VALID_HELD_REASON_CODES.includes((r as HeldReason).code),
  );
  return valid.length > 0 ? valid : DEFAULT_HELD_REASONS;
}

/**
 * Return true when a source-state key is a safe plain basename.
 * Rejects any key containing `/`, `\`, or the sequence `..` to prevent
 * path-traversal attacks when the key is later used as a state.json entry.
 */
function isSourceKeysafe(key: string): boolean {
  return !key.includes("/") && !key.includes("\\") && !key.includes("..");
}

/**
 * Validate and filter a raw `sourceStates` value from disk.
 *
 * Rules enforced per entry:
 * - Key must be a safe plain basename (no path separators, no `..`).
 * - `hash` must be a non-empty string.
 * - `concepts` must be a `string[]`.
 * - `compiledAt` must be a string.
 *
 * If `raw` is not a plain object, returns `undefined` (treated as absent).
 * Valid entries are kept; invalid ones are silently dropped.
 */
function sanitizeSourceStates(
  raw: unknown,
): Record<string, SourceState> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const result: Record<string, SourceState> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!isSourceKeyValid(key, value)) continue;
    result[key] = value as SourceState;
  }
  return result;
}

/** Return true when both the key is path-safe and the entry fields are valid. */
function isSourceKeyValid(key: string, value: unknown): boolean {
  if (!isSourceKeysafe(key)) return false;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.hash === "string" &&
    entry.hash.length > 0 &&
    Array.isArray(entry.concepts) &&
    (entry.concepts as unknown[]).every((c) => typeof c === "string") &&
    typeof entry.compiledAt === "string"
  );
}

/** Defensive type-guard so corrupted candidate files don't blow up the CLI. */
function isValidCandidate(value: unknown): value is ReviewCandidate {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.title === "string" &&
    typeof candidate.slug === "string" &&
    typeof candidate.body === "string" &&
    Array.isArray(candidate.sources)
  );
}

/**
 * List every candidate currently pending review, sorted by generation time.
 * Skips files that aren't candidate JSON (e.g. the archive subdirectory).
 * @param root - Project root directory.
 * @returns All pending review candidates.
 */
export async function listCandidates(root: string): Promise<ReviewCandidate[]> {
  const dir = await resolveConfinedCandidatesDir(root, CANDIDATES_DIR);
  if (dir === null) return []; // absent candidates dir → nothing pending
  const ids = await listCandidateFileIds(dir);
  const candidates: ReviewCandidate[] = [];
  for (const id of ids) {
    const candidate = await readCandidate(root, id);
    if (candidate) candidates.push(candidate);
  }

  candidates.sort((a, b) => a.generatedAt.localeCompare(b.generatedAt));
  return candidates;
}

/**
 * Count pending candidates using the same validity filter as listCandidates,
 * so consumers (e.g. `wiki_status.pendingCandidates`) never report counts
 * that disagree with what `review list` actually shows. Malformed JSON files
 * are skipped here exactly as they are by listCandidates.
 */
export async function countCandidates(root: string): Promise<number> {
  const candidates = await listCandidates(root);
  return candidates.length;
}
