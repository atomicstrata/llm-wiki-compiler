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

import { realpath, unlink } from "fs/promises";
import { atomicWrite } from "../utils/markdown.js";
import {
  assertCandidateSlug,
  assertWritableCandidateId,
  candidatePath,
} from "./candidate-paths.js";
import {
  listCandidates,
  countCandidates,
  DEFAULT_HELD_REASONS,
  type CandidateFileEntry,
} from "./candidate-read.js";
import {
  candidateTargetKey,
  selectReadableCandidateEntriesForMutation,
} from "./candidate-selection.js";
import type { ReviewCandidate, SourceState } from "../utils/types.js";
import type { HeldReason, ReviewMode } from "../review/policy.js";
import type { LintResult } from "../linter/types.js";
import type { TrustDecision } from "../trust/decision.js";
import type { ConnectorProvenance } from "../connectors/types.js";
import {
  assertCandidateNamespacesHealthy,
  captureCandidateCustody,
  CandidateCustodyUnavailableError,
  moveCandidateWithCustody,
  observeCandidateCustody,
  type CandidateCustodyReceipt,
} from "./candidate-custody.js";
import { captureCandidateCustodyReceipt } from "./candidate-custody-snapshot.js";
import {
  publishFreshCandidate,
  writableCandidateId,
  type CandidatePublication,
  type FreshCandidateWriteOptions,
} from "./candidate-publication.js";

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
export {
  CandidateIdentityMismatchError,
} from "./candidate-selection.js";
export {
  CandidatePublicationUnavailableError,
  FreshCandidateIdExhaustedError,
} from "./candidate-publication.js";
export type { FreshCandidateWriteOptions } from "./candidate-publication.js";

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
  /**
   * SHA-256 (hex) of the target page at propose time — the stale-state guard for
   * a candidate that UPDATES an existing page (see {@link ReviewCandidate.expectedTargetHash}).
   */
  expectedTargetHash?: string;
  /**
   * The complementary CLOSED precondition: the proposal expected NO page at the
   * target (see {@link ReviewCandidate.expectTargetAbsent}). Mutually exclusive
   * with {@link expectedTargetHash}.
   */
  expectTargetAbsent?: boolean;
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

/** Deterministic seams for custody replacement tests; normal callers omit them. */
export interface CandidateDeletionHooks {
  afterCustodyForTest?: (fileId: string) => Promise<void>;
  afterCandidateDeleteForTest?: (fileId: string, index: number) => Promise<void>;
}

/** Generic candidate-write options, including duplicate-cleanup test seams. */
export type CandidateWriteOptions = FreshCandidateWriteOptions & CandidateDeletionHooks;

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
  options: CandidateWriteOptions = {},
): Promise<ReviewCandidate> {
  const generatedId = writableCandidateId(draft.slug, 0, options);
  const targetKey = candidateTargetKey(draft);
  const matches = await selectReadableCandidateEntriesForMutation(
    root,
    (candidate) => candidateTargetKey(candidate) === targetKey,
  );
  const [canonical, ...duplicates] = matches;
  if (canonical) {
    return replaceCanonicalCandidate(root, draft, canonical.custodyReceipt,
      duplicates, options);
  }
  return publishNewCandidate(root, draft, generatedId, options);
}

/** Persist a new candidate without target-key canonicalization. Used only by typed staging supersede. */
export async function writeFreshCandidate(
  root: string,
  draft: CandidateDraft,
  options: FreshCandidateWriteOptions = {},
): Promise<ReviewCandidate> {
  const firstId = writableCandidateId(draft.slug, 0, options);
  return publishNewCandidate(root, draft, firstId, options);
}

/** Materialize one public candidate publication. */
function candidatePublication(draft: CandidateDraft, id: string): CandidatePublication<ReviewCandidate> {
  const candidate = buildCandidate(draft, id);
  return { candidate, serialized: serializeCandidate(candidate) };
}

/** Publish a newly allocated candidate through the shared exclusive allocator. */
function publishNewCandidate(
  root: string,
  draft: CandidateDraft,
  firstId: string,
  options: FreshCandidateWriteOptions,
): Promise<ReviewCandidate> {
  return publishFreshCandidate(
    root, draft.slug, firstId, (id) => candidatePublication(draft, id), options,
  );
}

/** Replace only the exact pending-only canonical custody snapshot. */
async function replaceCanonicalCandidate(
  root: string,
  draft: CandidateDraft,
  receipt: CandidateCustodyReceipt,
  duplicates: readonly CandidateFileEntry[],
  options: CandidateWriteOptions,
): Promise<ReviewCandidate> {
  assertWritableCandidateId(receipt.fileId);
  await options.beforePublishForTest?.(receipt.fileId, 0);
  if (await observeCandidateCustody(root, receipt, "public") !== "restored") {
    throw new CandidateCustodyUnavailableError();
  }
  const publication = candidatePublication(draft, receipt.fileId);
  await atomicWrite(await candidatePath(root, receipt.fileId), publication.serialized, {
    confineRoot: await realpath(root),
  });
  await deleteDuplicates(root, duplicates, options);
  return publication.candidate;
}

/** Preserve the public writer's serialization without a new record-size cap. */
function serializeCandidate(candidate: ReviewCandidate): string {
  return JSON.stringify(candidate, null, 2);
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
  setCandidateField(candidate, "expectedTargetHash", draft.expectedTargetHash, Boolean(draft.expectedTargetHash));
  setCandidateField(candidate, "expectTargetAbsent", draft.expectTargetAbsent, draft.expectTargetAbsent === true);
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

/** Delete exact selected duplicates in deterministic order. */
async function deleteDuplicates(
  root: string,
  entries: readonly CandidateFileEntry[],
  hooks: CandidateDeletionHooks,
): Promise<void> {
  for (const [index, entry] of entries.entries()) {
    await deleteCandidateWithCustody(root, entry.custodyReceipt);
    await hooks.afterCandidateDeleteForTest?.(entry.fileId, index);
  }
}

/** Remove only the exact pending object authorized by one custody receipt. */
async function deleteCandidateWithCustody(
  root: string,
  receipt: CandidateCustodyReceipt,
): Promise<boolean> {
  const captured = captureCandidateCustodyReceipt(receipt, "public");
  await assertCandidateNamespacesHealthy(root);
  if (await observeCandidateCustody(root, captured, "public") !== "restored") {
    throw new CandidateCustodyUnavailableError();
  }
  await assertCandidateNamespacesHealthy(root);
  const filePath = await candidatePath(root, captured.fileId);
  try {
    await unlink(filePath);
    return true;
  } catch (error) {
    throw new CandidateCustodyUnavailableError();
  }
}

/** Remove a pending candidate after capturing its exact current custody. */
export async function deleteCandidate(
  root: string,
  id: string,
  hooks: CandidateDeletionHooks = {},
): Promise<boolean> {
  await assertCandidateNamespacesHealthy(root);
  const custody = await captureCandidateCustody(root, id, undefined, "public");
  if (custody === null) return false;
  await hooks.afterCustodyForTest?.(id);
  return deleteCandidateWithCustody(root, custody.receipt);
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
export async function deleteCandidateBySlug(
  root: string,
  slug: string,
  hooks: CandidateDeletionHooks = {},
): Promise<boolean> {
  assertCandidateSlug(slug);
  const matching = await selectReadableCandidateEntriesForMutation(
    root,
    (candidate) => candidateTargetKey(candidate) === `concepts/${slug}`,
  );
  if (matching.length === 0) return false;
  for (const [index, entry] of matching.entries()) {
    await deleteCandidateWithCustody(root, entry.custodyReceipt);
    await hooks.afterCandidateDeleteForTest?.(entry.fileId, index);
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
  const custody = await captureCandidateCustody(root, id, undefined, "public");
  if (custody === null) return false;
  return moveCandidateWithCustody({
    root,
    fileId: id,
    direction: "archive",
    receipt: custody.receipt,
  }, "public");
}
