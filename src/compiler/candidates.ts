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

import {
  assertCandidateSlug,
  assertWritableCandidateId,
} from "./candidate-paths.js";
import {
  listCandidates,
  countCandidates,
  DEFAULT_HELD_REASONS,
  type CandidateFileEntry,
} from "./candidate-read.js";
import {
  candidateTargetKey,
  selectReadableCandidateEntriesForMutationFrom,
} from "./candidate-selection.js";
import type { ReviewCandidate, SourceState } from "../utils/types.js";
import { assertAnswerCandidateMetadata } from "../citations/answer-manifest.js";
import type { AnswerCitationManifest, ValidatedAnswerKind } from "../citations/answer-manifest.js";
import type { HeldReason, ReviewMode } from "../review/policy.js";
import type { LintResult } from "../linter/types.js";
import type { TrustDecision } from "../trust/decision.js";
import type { ConnectorProvenance } from "../connectors/types.js";
import {
  assertCandidateNamespacesHealthyFrom,
  captureCandidateCustodyFrom,
  CandidateCustodyUnavailableError,
  diskCandidateCustodyReads,
  moveCandidateWithCustodyFrom,
  observeCandidateCustodyFrom,
  type CandidateCustodyReceipt,
  type CandidateStoreMoveReads,
  type CandidateStoreWriteReads,
} from "./candidate-custody.js";
import { captureCandidateCustodyReceipt } from "./candidate-custody-snapshot.js";
import {
  candidatePublicationStoreFrom,
  diskCandidatePublicationStore,
  publishFreshCandidateFrom,
  writableCandidateId,
  type CandidatePublication,
  type CandidatePublicationStore,
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
  /** Exclusive reviewed-answer discriminator and proposal audit metadata. */
  candidateKind?: ValidatedAnswerKind;
  citationManifest?: AnswerCitationManifest;
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
  // `async` so that a throw while the disk mechanisms are built REJECTS.
  return writeCandidateFrom(diskCandidateCustodyReads(root), draft, options);
}

/**
 * {@link writeCandidate} over the store mechanisms: THE ONE BODY. A validated
 * answer takes the fresh allocator; otherwise the first identity is minted and
 * validated before any store access, the tolerant selection finds every
 * non-answer record with the same target key, the earliest is replaced under
 * its exact receipt and the rest are deleted in order, and no match falls to
 * the shared exclusive publisher.
 */
export async function writeCandidateFrom(
  reads: CandidateStoreWriteReads,
  draft: CandidateDraft,
  options: CandidateWriteOptions = {},
): Promise<ReviewCandidate> {
  // Validated answers always take a fresh id: a later import or generic write
  // for the same target must never rewrite an answer under its id or delete it.
  if (Object.hasOwn(draft, "candidateKind")) return writeFreshCandidateFrom(candidatePublicationStoreFrom(reads), draft, options);
  const generatedId = writableCandidateId(draft.slug, 0, options);
  const targetKey = candidateTargetKey(draft);
  const matches = await selectReadableCandidateEntriesForMutationFrom(
    reads,
    (candidate) => !candidate.candidateKind && candidateTargetKey(candidate) === targetKey,
  );
  const [canonical, ...duplicates] = matches;
  if (canonical) {
    return replaceCanonicalCandidateFrom(reads, draft, canonical.custodyReceipt,
      duplicates, options);
  }
  return publishNewCandidate(candidatePublicationStoreFrom(reads), draft, generatedId, options);
}

/** Persist a new candidate without target-key canonicalization. Used only by typed staging supersede. */
export async function writeFreshCandidate(
  root: string,
  draft: CandidateDraft,
  options: FreshCandidateWriteOptions = {},
): Promise<ReviewCandidate> {
  // `async` so that a throw while minting the first identity or building the disk store REJECTS.
  return writeFreshCandidateFrom(diskCandidatePublicationStore(root), draft, options);
}

/**
 * {@link writeFreshCandidate} over a publication store: THE ONE BODY. The first
 * identity is minted and validated before any store effect, then the record is
 * built, serialized and published by the shared allocator.
 */
export async function writeFreshCandidateFrom(
  store: CandidatePublicationStore,
  draft: CandidateDraft,
  options: FreshCandidateWriteOptions = {},
): Promise<ReviewCandidate> {
  const firstId = writableCandidateId(draft.slug, 0, options);
  return publishNewCandidate(store, draft, firstId, options);
}

/** Materialize one public candidate publication. */
function candidatePublication(draft: CandidateDraft, id: string): CandidatePublication<ReviewCandidate> {
  const candidate = buildCandidate(draft, id);
  return { candidate, serialized: serializeCandidate(candidate) };
}

/** Publish a newly allocated candidate through the shared exclusive allocator. */
function publishNewCandidate(
  store: CandidatePublicationStore,
  draft: CandidateDraft,
  firstId: string,
  options: FreshCandidateWriteOptions,
): Promise<ReviewCandidate> {
  return publishFreshCandidateFrom(
    store, draft.slug, firstId, (id) => candidatePublication(draft, id), options,
  );
}

/** Replace only the exact pending-only canonical custody snapshot. */
async function replaceCanonicalCandidateFrom(
  reads: CandidateStoreWriteReads,
  draft: CandidateDraft,
  receipt: CandidateCustodyReceipt,
  duplicates: readonly CandidateFileEntry[],
  options: CandidateWriteOptions,
): Promise<ReviewCandidate> {
  assertWritableCandidateId(receipt.fileId);
  await options.beforePublishForTest?.(receipt.fileId, 0);
  if (await observeCandidateCustodyFrom(reads, receipt, "public") !== "restored") {
    throw new CandidateCustodyUnavailableError();
  }
  const publication = candidatePublication(draft, receipt.fileId);
  await reads.replaceLeaf(await reads.leafPath(receipt.fileId, "pending"), publication.serialized);
  await deleteEntriesFrom(reads, duplicates, options);
  return publication.candidate;
}

/** Preserve the public writer's serialization without a new record-size cap. */
/**
 * The stored form of a candidate record. Exported so a proposal store other
 * than `.llmwiki/candidates/` writes records the shared parser reads back.
 */
export function serializeCandidate(candidate: ReviewCandidate): string {
  return JSON.stringify(candidate, null, 2);
}

/** Build a ReviewCandidate from a draft and chosen id. */
/**
 * Build the candidate record for `draft` under `id`, with no storage effect.
 * This is the one place a draft becomes a record, whichever store keeps it.
 */
export function buildCandidate(draft: CandidateDraft, id: string): ReviewCandidate {
  assertAnswerCandidateMetadata({ ...draft, id, reviewMode: draft.reviewMode ?? "forced" }, id);
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
  setCandidateField(candidate, "candidateKind", draft.candidateKind, draft.candidateKind !== undefined);
  setCandidateField(candidate, "citationManifest", draft.citationManifest, draft.citationManifest !== undefined);
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

/** Delete exact selected entries (duplicates, or a slug's matches) in deterministic order. */
async function deleteEntriesFrom(
  reads: CandidateStoreWriteReads,
  entries: readonly CandidateFileEntry[],
  hooks: CandidateDeletionHooks,
): Promise<void> {
  for (const [index, entry] of entries.entries()) {
    await deleteCandidateWithCustodyFrom(reads, entry.custodyReceipt);
    await hooks.afterCandidateDeleteForTest?.(entry.fileId, index);
  }
}

/** Remove only the exact pending object authorized by one custody receipt. */
async function deleteCandidateWithCustodyFrom(
  reads: CandidateStoreWriteReads,
  receipt: CandidateCustodyReceipt,
): Promise<boolean> {
  const captured = captureCandidateCustodyReceipt(receipt, "public");
  await assertCandidateNamespacesHealthyFrom(reads);
  if (await observeCandidateCustodyFrom(reads, captured, "public") !== "restored") {
    throw new CandidateCustodyUnavailableError();
  }
  await assertCandidateNamespacesHealthyFrom(reads);
  const filePath = await reads.leafPath(captured.fileId, "pending");
  try {
    await reads.removeLeaf(filePath);
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
  // `async` so that a throw while the disk mechanisms are built REJECTS.
  return deleteCandidateFrom(diskCandidateCustodyReads(root), id, hooks);
}

/** {@link deleteCandidate} over the store mechanisms: THE ONE BODY. */
export async function deleteCandidateFrom(
  reads: CandidateStoreWriteReads,
  id: string,
  hooks: CandidateDeletionHooks = {},
): Promise<boolean> {
  await assertCandidateNamespacesHealthyFrom(reads);
  const custody = await captureCandidateCustodyFrom(reads, id, undefined, "public");
  if (custody === null) return false;
  await hooks.afterCustodyForTest?.(id);
  return deleteCandidateWithCustodyFrom(reads, custody.receipt);
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
  // `async` so that a throw while the disk mechanisms are built REJECTS.
  return deleteCandidateBySlugFrom(diskCandidateCustodyReads(root), slug, hooks);
}

/** {@link deleteCandidateBySlug} over the store mechanisms: THE ONE BODY. */
export async function deleteCandidateBySlugFrom(
  reads: CandidateStoreWriteReads,
  slug: string,
  hooks: CandidateDeletionHooks = {},
): Promise<boolean> {
  assertCandidateSlug(slug);
  const matching = await selectReadableCandidateEntriesForMutationFrom(
    reads,
    (candidate) => candidateTargetKey(candidate) === `concepts/${slug}`,
  );
  if (matching.length === 0) return false;
  await deleteEntriesFrom(reads, matching, hooks);
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
  // `async` so that a throw while the disk mechanisms are built REJECTS.
  return archiveCandidateFrom(diskCandidateCustodyReads(root), root, id);
}

/**
 * {@link archiveCandidate} over the store mechanisms: THE ONE BODY. The
 * pending custody is captured under the public policy (absent is `false`), then
 * moved to the archive under that exact receipt. `root` only fills the move
 * request's validated legacy field; `reads` choose the project.
 */
export async function archiveCandidateFrom(reads: CandidateStoreMoveReads, root: string, id: string): Promise<boolean> {
  const custody = await captureCandidateCustodyFrom(reads, id, undefined, "public");
  if (custody === null) return false;
  return moveCandidateWithCustodyFrom(reads, {
    root,
    fileId: id,
    direction: "archive",
    receipt: custody.receipt,
  }, "public");
}
