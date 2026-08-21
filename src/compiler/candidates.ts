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
 *
 * This module owns the WRITE/dedup/identity/delete/archive half of the store.
 * The READ/list/sanitize/validate half lives in {@link file://./candidate-read.ts}
 * and the shared path resolvers in {@link file://./candidate-paths.ts}; both are
 * RE-EXPORTED below so existing importers of `candidates.ts` are unchanged.
 */

import { unlink } from "fs/promises";
import { existsSync } from "fs";
import { randomBytes } from "crypto";
import { isSafeFilenameComponent } from "../profile/identity.js";
import { atomicWrite } from "../utils/markdown.js";
import { moveCandidateToArchive } from "../utils/candidate-store.js";
import { candidatePath, archivePath, UnsafeCandidateIdError } from "./candidate-paths.js";
import {
  listCandidates,
  countCandidates,
  DEFAULT_HELD_REASONS,
} from "./candidate-read.js";
import type { ReviewCandidate, SourceState } from "../utils/types.js";
import type { HeldReason, ReviewMode } from "../review/policy.js";
import type { LintResult } from "../linter/types.js";
import type { TrustDecision } from "../trust/decision.js";
import type { ConnectorProvenance } from "../connectors/types.js";

// Re-export the read/list/sanitize half and shared path symbols so every
// existing importer of `candidates.ts` keeps working without churn.
export {
  readCandidate,
  readCandidateBySlug,
  listCandidates,
  listCandidatePage,
  countCandidates,
  listLinkResolvablePendingSlugs,
  loadCandidateOrFail,
  loadCandidateUnderLockOrFail,
} from "./candidate-read.js";
export type { CandidatePage } from "./candidate-read.js";
export { UnsafeCandidateIdError } from "./candidate-paths.js";

/** Length (bytes) of the random suffix appended to candidate ids. */
const ID_SUFFIX_BYTES = 4;

/** Input shape for creating a new candidate (id + timestamp generated here). */
export interface CandidateDraft {
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
   * Digest of the prompt modifiers this candidate was generated under, so
   * compile can tell a candidate that already covers this run's work from one
   * whose wording predates a modifier change.
   */
  promptModifiers?: string;
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
  /** Host-authored provenance for connector-fetched candidates. */
  connectorProvenance?: ConnectorProvenance;
  /** Confidence parsed from the generated page frontmatter, for display. */
  confidence?: number;
  /** True when the generated page frontmatter declares contradictions. */
  contradicted?: boolean;
  /**
   * Typed entity directory the approved page routes to under a configurable
   * profile (e.g. `"papers"`). Phase-2 typed-staging metadata; OMITTED for
   * default-profile candidates, so default candidate JSON stays byte-identical.
   */
  targetEntityType?: string;
  /**
   * Trust Guard decision attached to this candidate at generation time, so
   * reviewers see how the write was routed. Phase-2 typed-staging metadata;
   * OMITTED for default-profile candidates, so default candidate JSON stays
   * byte-identical.
   */
  trustDecision?: TrustDecision;
}

/** Build a deterministic-but-unique id from a slug and a short random suffix. */
function buildCandidateId(slug: string): string {
  const suffix = randomBytes(ID_SUFFIX_BYTES).toString("hex");
  return `${slug}-${suffix}`;
}

/**
 * The FULL target identity of a candidate: the tuple of where the approved page
 * lands AND its slug. Two candidates are duplicates only when BOTH components
 * match. For a DEFAULT concepts candidate the type component is the constant
 * `"concepts"`, so dedup on this key behaves EXACTLY as a slug-only dedup did —
 * default candidate behavior stays byte-identical. A typed candidate
 * (`targetEntityType`) or an OKF query candidate (`targetDirectory`) keys on its
 * own directory, so `papers/foo` and `ideas/foo` never collapse into one file.
 * @param candidate - The candidate (or draft) whose target identity is built.
 */
function candidateTargetKey(candidate: {
  targetEntityType?: string;
  targetDirectory?: string;
  slug: string;
}): string {
  const target = candidate.targetEntityType ?? candidate.targetDirectory ?? "concepts";
  return `${target}/${candidate.slug}`;
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
  if (!isSafeFilenameComponent(draft.slug)) throw new UnsafeCandidateIdError("slug", draft.slug);
  const { canonicalId, duplicateIds } = await findIdentityDuplicates(root, candidateTargetKey(draft));
  const candidate = buildCandidate(draft, canonicalId ?? buildCandidateId(draft.slug));

  await atomicWrite(await candidatePath(root, candidate.id), JSON.stringify(candidate, null, 2));
  await deleteDuplicates(root, duplicateIds);
  return candidate;
}

/** Persist a new candidate without target-key canonicalization. Used only by typed staging supersede. */
export async function writeFreshCandidate(
  root: string,
  draft: CandidateDraft,
): Promise<ReviewCandidate> {
  if (!isSafeFilenameComponent(draft.slug)) throw new UnsafeCandidateIdError("slug", draft.slug);
  const candidate: ReviewCandidate = buildCandidate(draft, buildCandidateId(draft.slug));
  await atomicWrite(await candidatePath(root, candidate.id), JSON.stringify(candidate, null, 2));
  return candidate;
}

/** Build a ReviewCandidate from a draft and chosen id. */
function buildCandidate(draft: CandidateDraft, id: string): ReviewCandidate {
  const candidate: ReviewCandidate = {
    id,
    title: draft.title,
    slug: draft.slug,
    summary: draft.summary,
    sources: draft.sources,
    body: draft.body,
    generatedAt: new Date().toISOString(),
    reviewMode: draft.reviewMode ?? "forced",
    heldReasons: draft.heldReasons ?? DEFAULT_HELD_REASONS,
  };
  copyCandidateOptionalFields(candidate, draft);
  return candidate;
}

/** Copy optional candidate fields while preserving the legacy omission rules. */
function copyCandidateOptionalFields(candidate: ReviewCandidate, draft: CandidateDraft): void {
  setCandidateField(candidate, "sourceStates", draft.sourceStates, draft.sourceStates !== undefined);
  setCandidateField(candidate, "promptModifiers", draft.promptModifiers, Boolean(draft.promptModifiers));
  setCandidateField(candidate, "schemaViolations", draft.schemaViolations, draft.schemaViolations !== undefined);
  setCandidateField(candidate, "provenanceViolations", draft.provenanceViolations, draft.provenanceViolations !== undefined);
  setCandidateField(candidate, "confidence", draft.confidence, draft.confidence !== undefined);
  setCandidateField(candidate, "contradicted", draft.contradicted, draft.contradicted !== undefined);
  setCandidateField(candidate, "targetDirectory", draft.targetDirectory, Boolean(draft.targetDirectory));
  setCandidateField(candidate, "okfPath", draft.okfPath, Boolean(draft.okfPath));
  setCandidateField(candidate, "connectorProvenance", draft.connectorProvenance, draft.connectorProvenance !== undefined);
  setCandidateField(candidate, "targetEntityType", draft.targetEntityType, Boolean(draft.targetEntityType));
  setCandidateField(candidate, "trustDecision", draft.trustDecision, Boolean(draft.trustDecision));
}

/** Assign one optional field to a candidate when its legacy include condition is met. */
function setCandidateField<K extends keyof ReviewCandidate>(
  candidate: ReviewCandidate,
  key: K,
  value: ReviewCandidate[K] | undefined,
  include: boolean,
): void {
  if (include) candidate[key] = value as ReviewCandidate[K];
}

/**
 * Collect all candidate ids matching a FULL target identity (target-type + slug,
 * via {@link candidateTargetKey}) and return the canonical (earliest) id plus the
 * list of extra duplicate ids to remove. Keying on the full identity — not slug
 * alone — keeps two distinct typed targets that share a slug (`papers/foo` vs
 * `ideas/foo`) as SEPARATE candidates, so neither is silently dropped, while a
 * DEFAULT concepts candidate (constant `concepts/` prefix) dedups exactly as
 * before.
 * @param root - Project root directory.
 * @param targetKey - The full target identity to match (see {@link candidateTargetKey}).
 */
async function findIdentityDuplicates(
  root: string,
  targetKey: string,
): Promise<{ canonicalId: string | null; duplicateIds: string[] }> {
  const all = await listCandidates(root);
  const matching = all.filter((c) => candidateTargetKey(c) === targetKey);
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

/** Remove a pending candidate from disk. Returns false when nothing existed to remove. */
export async function deleteCandidate(root: string, id: string): Promise<boolean> {
  const filePath = await candidatePath(root, id);
  if (!existsSync(filePath)) return false;
  await unlink(filePath);
  return true;
}

/**
 * Delete ALL pending candidate files for a DEFAULT concepts slug.
 *
 * When duplicates exist (e.g. legacy or hand-dropped files) the direct-write
 * reconcile path must remove every file matching the slug, not just the first
 * canonical one, so no stale duplicates remain after a concepts page is written
 * directly. Matches on the FULL `concepts/<slug>` identity (via
 * {@link candidateTargetKey}) so a typed `papers/<slug>` candidate that merely
 * shares the slug is NOT collaterally deleted when a default concepts page is
 * reconciled — the default caller only writes concepts, so its behavior is
 * unchanged.
 */
export async function deleteCandidateBySlug(root: string, slug: string): Promise<boolean> {
  const all = await listCandidates(root);
  const matching = all.filter((c) => candidateTargetKey(c) === `concepts/${slug}`);
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
  return moveCandidateToArchive(await candidatePath(root, id), await archivePath(root, id));
}

/**
 * Move an archived candidate back into the pending area — the compensation for
 * a multi-candidate archive batch that fails partway, so a supersede that
 * cannot complete never silently shrinks the review queue.
 * @param root - Project root directory.
 * @param id - Candidate id to restore.
 * @returns True when the archived candidate was found and restored.
 */
export async function restoreArchivedCandidate(root: string, id: string): Promise<boolean> {
  return moveCandidateToArchive(await archivePath(root, id), await candidatePath(root, id));
}
