/**
 * Review candidate persistence for the llmwiki compile pipeline.
 *
 * When `llmwiki compile --review` runs, generated wiki pages are routed
 * here as JSON candidate records under `.llmwiki/candidates/` instead of
 * being written directly to `wiki/`. Reviewers then approve or reject the
 * proposals via the `llmwiki review` subcommands.
 *
 * Candidates are deliberately kept as standalone JSON so they survive across
 * compile runs and can be inspected manually without the CLI. Each record
 * stores the full page body so approval is a pure copy — the LLM is never
 * called again at approval time.
 */

import { unlink } from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import { randomBytes } from "crypto";
import { atomicWrite, safeReadFile } from "../utils/markdown.js";
import {
  listCandidateFileIds,
  moveCandidateToArchive,
} from "../utils/candidate-store.js";
import * as output from "../utils/output.js";
import {
  CANDIDATES_DIR,
  CANDIDATES_ARCHIVE_DIR,
} from "../utils/constants.js";
import type { ReviewCandidate, SourceState } from "../utils/types.js";
import type { HeldReason, HeldReasonCode, ReviewMode } from "../review/policy.js";
import type { LintResult } from "../linter/types.js";

/** Length (bytes) of the random suffix appended to candidate ids. */
const ID_SUFFIX_BYTES = 4;

/** Filesystem extension used for candidate JSON files. */
const CANDIDATE_EXT = ".json";

/** Input shape for creating a new candidate (id + timestamp generated here). */
interface CandidateDraft {
  title: string;
  slug: string;
  summary: string;
  sources: string[];
  body: string;
  /**
   * Per-source state entries to persist into `.llmwiki/state.json` when this
   * candidate is approved. Keyed by source filename. Optional so callers that
   * never need incremental tracking (legacy / tests) can omit it.
   */
  sourceStates?: Record<string, SourceState>;
  /**
   * Schema lint violations for the candidate body detected at compile time.
   * Omit (or pass `undefined`) when the candidate body is clean.
   */
  schemaViolations?: LintResult[];
  /**
   * Provenance lint violations for the candidate body — malformed claim
   * citations, out-of-bounds spans, or missing source files. Surfaced
   * alongside schema violations so reviewers see citation issues before
   * approving.
   */
  provenanceViolations?: LintResult[];
  /** Whether this candidate was forced by --review or held by policy. */
  reviewMode?: ReviewMode;
  /** Structured reasons for holding this candidate. */
  heldReasons?: HeldReason[];
  /**
   * Wiki subdir the approved page is written to; defaults to concepts.
   * OKF query docs set `queries` to round-trip back into the right subdir.
   */
  targetDirectory?: "concepts" | "queries";
  /** Original OKF bundle-relative path, for imported candidates. */
  okfPath?: string;
  /** Confidence parsed from the generated page frontmatter, for display. */
  confidence?: number;
  /** True when the generated page frontmatter declares contradictions. */
  contradicted?: boolean;
}

/** Default metadata for legacy `compile --review` callers. */
const DEFAULT_HELD_REASONS: HeldReason[] = [{ code: "manual-review-requested" }];

/** All valid ReviewMode values. */
const VALID_REVIEW_MODES: ReviewMode[] = ["policy", "forced", "imported"];

/** All valid HeldReasonCode values — mirrors the union in policy.ts. */
const VALID_HELD_REASON_CODES: HeldReasonCode[] = [
  "low-confidence",
  "contradicted",
  "schema-violating",
  "provenance-violating",
  "all",
  "manual-review-requested",
  "imported-okf",
];

/** Build a deterministic-but-unique id from a slug and a short random suffix. */
function buildCandidateId(slug: string): string {
  const suffix = randomBytes(ID_SUFFIX_BYTES).toString("hex");
  return `${slug}-${suffix}`;
}

/** Absolute path to a candidate's JSON file. */
function candidatePath(root: string, id: string): string {
  return path.join(root, CANDIDATES_DIR, `${id}${CANDIDATE_EXT}`);
}

/** Absolute path to the archived JSON file for a rejected candidate. */
function archivePath(root: string, id: string): string {
  return path.join(root, CANDIDATES_ARCHIVE_DIR, `${id}${CANDIDATE_EXT}`);
}

/**
 * Persist a new candidate record and return it. The id is generated from the
 * slug plus a short random suffix so multiple compile runs can co-exist.
 *
 * When multiple candidate files for the same slug already exist (e.g. from a
 * hand-edited state or a legacy run), this canonicalizes to the earliest id and
 * deletes all extra duplicate files so at most one file per slug remains.
 * @param root - Project root directory.
 * @param draft - The candidate fields to persist.
 * @returns The full ReviewCandidate (with id + generatedAt populated).
 */
export async function writeCandidate(
  root: string,
  draft: CandidateDraft,
): Promise<ReviewCandidate> {
  const { canonicalId, duplicateIds } = await findSlugDuplicates(root, draft.slug);
  const candidate: ReviewCandidate = {
    id: canonicalId ?? buildCandidateId(draft.slug),
    title: draft.title,
    slug: draft.slug,
    summary: draft.summary,
    sources: draft.sources,
    body: draft.body,
    generatedAt: new Date().toISOString(),
    reviewMode: draft.reviewMode ?? "forced",
    heldReasons: draft.heldReasons ?? DEFAULT_HELD_REASONS,
    ...(draft.sourceStates ? { sourceStates: draft.sourceStates } : {}),
    ...(draft.schemaViolations ? { schemaViolations: draft.schemaViolations } : {}),
    ...(draft.provenanceViolations ? { provenanceViolations: draft.provenanceViolations } : {}),
    ...(draft.confidence !== undefined ? { confidence: draft.confidence } : {}),
    ...(draft.contradicted !== undefined ? { contradicted: draft.contradicted } : {}),
    ...(draft.targetDirectory ? { targetDirectory: draft.targetDirectory } : {}),
    ...(draft.okfPath ? { okfPath: draft.okfPath } : {}),
  };

  await atomicWrite(candidatePath(root, candidate.id), JSON.stringify(candidate, null, 2));
  await deleteDuplicates(root, duplicateIds);
  return candidate;
}

/**
 * Collect all candidate ids matching a slug and return the canonical (earliest)
 * id plus the list of extra duplicate ids to remove.
 * @param root - Project root directory.
 * @param slug - The page slug to search for.
 */
async function findSlugDuplicates(
  root: string,
  slug: string,
): Promise<{ canonicalId: string | null; duplicateIds: string[] }> {
  const all = await listCandidates(root);
  const matching = all.filter((c) => c.slug === slug);
  if (matching.length === 0) return { canonicalId: null, duplicateIds: [] };
  // Preserve the first match as canonical (listCandidates sorts by generatedAt).
  const [canonical, ...extras] = matching;
  return {
    canonicalId: canonical!.id,
    duplicateIds: extras.map((c) => c.id),
  };
}

/** Delete a list of candidate files by id, ignoring missing entries. */
async function deleteDuplicates(root: string, ids: string[]): Promise<void> {
  for (const id of ids) {
    await deleteCandidate(root, id);
  }
}

/** Find the pending candidate for a slug, if one exists. */
export async function readCandidateBySlug(
  root: string,
  slug: string,
): Promise<ReviewCandidate | null> {
  const candidates = await listCandidates(root);
  return candidates.find((candidate) => candidate.slug === slug) ?? null;
}

/** Collect every slug currently pending review. */
export async function listPendingCandidateSlugs(root: string): Promise<Set<string>> {
  const candidates = await listCandidates(root);
  return new Set(candidates.map((candidate) => candidate.slug));
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
  const raw = await safeReadFile(candidatePath(root, id));
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

  const result: ReviewCandidate = { ...candidate, generatedAt, reviewMode, heldReasons };
  if (sourceStates !== undefined) result.sourceStates = sourceStates;
  else delete result.sourceStates;
  return result;
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
  const dir = path.join(root, CANDIDATES_DIR);
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

/** Remove a pending candidate from disk. Returns false when nothing existed to remove. */
export async function deleteCandidate(root: string, id: string): Promise<boolean> {
  const filePath = candidatePath(root, id);
  if (!existsSync(filePath)) return false;
  await unlink(filePath);
  return true;
}

/**
 * Delete ALL pending candidate files for a slug.
 *
 * When duplicates exist (e.g. legacy or hand-dropped files) the direct-write
 * reconcile path must remove every file matching the slug, not just the first
 * canonical one, so no stale duplicates remain after a page is written directly.
 */
export async function deleteCandidateBySlug(root: string, slug: string): Promise<boolean> {
  const all = await listCandidates(root);
  const matching = all.filter((c) => c.slug === slug);
  if (matching.length === 0) return false;
  for (const candidate of matching) {
    await deleteCandidate(root, candidate.id);
  }
  return true;
}

/**
 * Move a candidate from the pending area into the archive subdirectory so
 * rejected proposals stay auditable without touching `wiki/`.
 * @param root - Project root directory.
 * @param id - Candidate id to archive.
 * @returns True when the candidate was found and archived.
 */
export async function archiveCandidate(root: string, id: string): Promise<boolean> {
  return moveCandidateToArchive(candidatePath(root, id), archivePath(root, id));
}
