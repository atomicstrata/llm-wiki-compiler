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
import type { HeldReason, ReviewMode } from "../review/policy.js";
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
  /** Confidence parsed from the generated page frontmatter, for display. */
  confidence?: number;
  /** True when the generated page frontmatter declares contradictions. */
  contradicted?: boolean;
}

/** Default metadata for legacy `compile --review` callers. */
const DEFAULT_HELD_REASONS: HeldReason[] = [{ code: "manual-review-requested" }];

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
 * @param root - Project root directory.
 * @param draft - The candidate fields to persist.
 * @returns The full ReviewCandidate (with id + generatedAt populated).
 */
export async function writeCandidate(
  root: string,
  draft: CandidateDraft,
): Promise<ReviewCandidate> {
  const existing = await readCandidateBySlug(root, draft.slug);
  const candidate: ReviewCandidate = {
    id: existing?.id ?? buildCandidateId(draft.slug),
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
  };

  await atomicWrite(candidatePath(root, candidate.id), JSON.stringify(candidate, null, 2));
  return candidate;
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

/** Parse a single candidate JSON file. Returns null when the file is missing or malformed. */
export async function readCandidate(
  root: string,
  id: string,
): Promise<ReviewCandidate | null> {
  const raw = await safeReadFile(candidatePath(root, id));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as ReviewCandidate;
    if (!isValidCandidate(parsed)) return null;
    return applyLegacyDefaults(parsed);
  } catch {
    return null;
  }
}

/**
 * Apply defaults for legacy candidates written before `reviewMode` and
 * `heldReasons` were required fields. Called at the IO boundary so every
 * in-memory candidate always has these fields populated.
 */
function applyLegacyDefaults(candidate: ReviewCandidate): ReviewCandidate {
  return {
    ...candidate,
    reviewMode: candidate.reviewMode ?? "forced",
    heldReasons: candidate.heldReasons ?? DEFAULT_HELD_REASONS,
  };
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

/** Delete the pending candidate for a slug, if one exists. */
export async function deleteCandidateBySlug(root: string, slug: string): Promise<boolean> {
  const candidate = await readCandidateBySlug(root, slug);
  if (!candidate) return false;
  return deleteCandidate(root, candidate.id);
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
