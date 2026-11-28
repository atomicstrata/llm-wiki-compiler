/**
 * @file src/portable/project/proposal-records.ts
 * @description The immutable record batch of one proposal, and the only way to
 * read it back: re-hashing everything.
 *
 * A proposal is three kinds of record under `proposals/<id>/`: one per
 * candidate (the shared candidate record, with the exact draft body), the plan
 * (each target with its pre-image and the digest of the bytes that would be
 * written), and the read-set (the apply dependencies). The proposal's receipt
 * holds the digests of all of them.
 *
 * {@link loadVerifiedProposal} never trusts a digest a record states about
 * itself. It hashes the stored bytes and recomputes every digest, and anything
 * that does not match the receipt is `candidate_drift`: changed proposal bytes
 * are never adopted, never reconciled and never shown to a reviewer.
 */

import { serializeCandidate } from "../../compiler/candidates.js";
import { parseCandidateRecord } from "../../compiler/candidate-read.js";
import type { ReviewCandidate } from "../../utils/types.js";
import type {
  ApplyDependenciesV1,
  CandidateSummary,
  ContentDigest,
  LabelSet,
  ObjectImage,
  ProposalReceiptV1,
  SkippedItem,
} from "../contracts.js";
import { bytesDigest, recordBytes, recordDigest, textDigest } from "../digest.js";
import { PortableDenied, PortableRefusal } from "../errors.js";
import { conceptPagePath, proposalPaths } from "../logical-paths.js";
import type { ReadView, StoredWrite } from "../store/store.js";

/** One target of a proposal's plan. */
export interface PlanTarget {
  candidateId: string;
  path: string;
  pre: ObjectImage;
  /** Digest of the exact bytes an apply would write. */
  postDigest: ContentDigest;
}

/** The stored plan record. */
export interface ProposalPlanV1 {
  targets: readonly PlanTarget[];
  skipped: readonly SkippedItem[];
}

/** One candidate of a verified proposal, with its recomputed digests. */
export interface VerifiedCandidate {
  candidate: ReviewCandidate;
  target: PlanTarget;
  draftDigest: ContentDigest;
  summary: CandidateSummary;
}

/** A proposal whose every stored byte matched its receipt, with dependencies of record shape `D`. */
export interface VerifiedProposalOf<D> {
  receipt: ProposalReceiptV1;
  plan: ProposalPlanV1;
  dependencies: D;
  candidates: readonly VerifiedCandidate[];
  proposer: string;
  labels: LabelSet;
}

/** A version 1 proposal: its dependencies are the V1 read-set. */
export type VerifiedProposal = VerifiedProposalOf<ApplyDependenciesV1>;

/** The digest that identifies one candidate: its id, target, pre-image, draft and labels. */
function candidateDigest(target: PlanTarget, labels: LabelSet): ContentDigest {
  return recordDigest({
    candidateId: target.candidateId, targetPath: target.path, targetPre: target.pre,
    draftDigest: target.postDigest, labels,
  });
}

/** The digest of a candidate set: its candidate digests, ordered by candidate id. */
function candidateSetDigest(summaries: readonly CandidateSummary[]): ContentDigest {
  const ordered = [...summaries].sort((a, b) => a.id.localeCompare(b.id));
  return recordDigest(ordered.map((summary) => summary.candidateDigest));
}

/** What a proposal is built from once generation has finished. */
export interface ProposalDraft {
  operationId: string;
  intentDigest: ContentDigest;
  candidates: readonly { candidate: ReviewCandidate; pre: ObjectImage }[];
  skipped: readonly SkippedItem[];
  dependencies: Omit<ApplyDependenciesV1, "targets">;
  labels: LabelSet;
}

/** The plan target of one candidate written at `path`. */
function planTargetOf(candidate: ReviewCandidate, path: string, pre: ObjectImage): PlanTarget {
  return { candidateId: candidate.id, path, pre, postDigest: textDigest(candidate.body) };
}

/** The current pre-image of `path` in `view`: absent, or its digest, size and the labels bound to exactly those bytes. */
export async function preImageIn(view: ReadView, path: string): Promise<ObjectImage> {
  const seen = await view.observe(path);
  if (seen === null) return { state: "absent" };
  return { state: "present", digest: seen.digest, byteCount: seen.bytes.byteLength, labels: (await view.labelsFor(path, seen.digest)) ?? [] };
}

/** Each candidate with its plan target at `pathOf(candidate)`, the pre-image read from `view` now. */
export async function planEntriesIn(
  view: ReadView, candidates: readonly ReviewCandidate[], pathOf: (candidate: ReviewCandidate) => string,
): Promise<{ candidate: ReviewCandidate; target: PlanTarget }[]> {
  const entries = [];
  for (const candidate of candidates) entries.push({ candidate, target: planTargetOf(candidate, pathOf(candidate), await preImageIn(view, pathOf(candidate))) });
  return entries;
}

/** What any proposal path stores: candidates with their targets, the dependency record, and further records. */
export interface RecordBatchInput {
  operationId: string;
  intentDigest: ContentDigest;
  entries: readonly { candidate: ReviewCandidate; target: PlanTarget }[];
  skipped: readonly SkippedItem[];
  labels: LabelSet;
  /** The dependency record and where it lives. Its digest is the receipt's `applyDependenciesDigest`. */
  dependencies: { path: string; value: unknown };
  /** Further create-only records the receipt binds by the digest of their stored bytes. */
  extra?: readonly { path: string; value: unknown }[];
}

/** The record batch and receipt for one proposal. Every record is create-only. */
export function buildRecordBatch(input: RecordBatchInput): { writes: StoredWrite[]; receipt: ProposalReceiptV1 } {
  const paths = proposalPaths(input.operationId);
  const targets = input.entries.map(({ target }) => target);
  const plan: ProposalPlanV1 = { targets, skipped: input.skipped };
  const summaries = targets.map((target) => ({
    id: target.candidateId, targetPath: target.path, labels: input.labels,
    candidateDigest: candidateDigest(target, input.labels),
  }));
  const record = (path: string, bytes: Uint8Array): StoredWrite => ({
    path, bytes, pre: { state: "absent" }, labels: input.labels,
  });
  const writes = [
    ...input.entries.map(({ candidate }) =>
      record(paths.candidate(candidate.id), Buffer.from(serializeCandidate(candidate), "utf8"))),
    record(paths.plan, recordBytes(plan)),
    record(input.dependencies.path, recordBytes(input.dependencies.value)),
    ...(input.extra ?? []).map(({ path, value }) => record(path, recordBytes(value))),
  ];
  const receipt: ProposalReceiptV1 = {
    operationId: input.operationId, intentDigest: input.intentDigest,
    candidateSetDigest: candidateSetDigest(summaries), planDigest: recordDigest(plan),
    applyDependenciesDigest: recordDigest(input.dependencies.value), candidates: summaries, skipped: input.skipped,
  };
  return { writes, receipt };
}

/** The version 1 record batch and receipt for one proposal. */
export function buildProposalBatch(draft: ProposalDraft): {
  writes: StoredWrite[]; receipt: ProposalReceiptV1; dependencies: ApplyDependenciesV1;
} {
  const entries = draft.candidates.map(({ candidate, pre }) => ({
    candidate, target: planTargetOf(candidate, conceptPagePath(candidate.slug), pre),
  }));
  const dependencies: ApplyDependenciesV1 = {
    ...draft.dependencies, targets: entries.map(({ target }) => ({ path: target.path, pre: target.pre })),
  };
  const { writes, receipt } = buildRecordBatch({
    operationId: draft.operationId, intentDigest: draft.intentDigest, entries, skipped: draft.skipped,
    labels: draft.labels, dependencies: { path: proposalPaths(draft.operationId).readSet, value: dependencies },
  });
  return { writes, receipt, dependencies };
}

/** Read one stored record and require its bytes to hash to `expected`. */
export async function readVerifiedRecord<T>(store: ReadView, path: string, expected: ContentDigest): Promise<T> {
  const bytes = await store.read(path);
  if (bytes === null || bytesDigest(bytes) !== expected) throw new PortableRefusal("candidate_drift", path);
  return JSON.parse(Buffer.from(bytes).toString("utf8")) as T;
}

/** Re-hash one stored candidate and check it against the plan and the receipt. */
async function verifyCandidate(
  store: ReadView, proposalOperationId: string, summary: CandidateSummary, plan: ProposalPlanV1,
  published: ReadonlyMap<string, ContentDigest>,
): Promise<VerifiedCandidate> {
  const path = proposalPaths(proposalOperationId).candidate(summary.id);
  const bytes = await store.read(path);
  const target = plan.targets.find((entry) => entry.candidateId === summary.id);
  if (bytes === null || target === undefined) throw new PortableRefusal("candidate_drift", path);
  // EVERY stored byte is bound to the commit receipt, not only the draft body:
  // a candidate's metadata (its source states) also shapes what an apply records.
  if (bytesDigest(bytes) !== published.get(path)) throw new PortableRefusal("candidate_drift", path);
  let candidate: ReviewCandidate;
  try {
    candidate = parseCandidateRecord(summary.id, bytes);
  } catch {
    throw new PortableRefusal("candidate_drift", path);
  }
  const draftDigest = textDigest(candidate.body);
  const recomputed = candidateDigest({ ...target, postDigest: draftDigest }, summary.labels);
  if (draftDigest !== target.postDigest || recomputed !== summary.candidateDigest) {
    throw new PortableRefusal("candidate_drift", path);
  }
  return { candidate, target, draftDigest, summary };
}

/**
 * Load a committed proposal, re-hashing every stored record against its receipt.
 *
 * @throws PortableDenied when no such committed proposal exists.
 * @throws PortableRefusal `candidate_drift` when any stored byte differs.
 */
export async function loadVerifiedProposal(store: ReadView, proposalOperationId: string): Promise<VerifiedProposal> {
  return loadVerifiedProposalWith<ApplyDependenciesV1>(store, proposalOperationId, proposalPaths(proposalOperationId).readSet);
}

/**
 * Load a committed proposal whose dependency record lives at `dependencyPath`,
 * re-hashing every stored record against its receipt. A proposal of another
 * path has no record there, so it is `candidate_drift` and never adopted.
 *
 * @throws PortableDenied when no such committed proposal exists.
 * @throws PortableRefusal `candidate_drift` when any stored byte differs or is missing.
 */
export async function loadVerifiedProposalWith<D>(
  store: ReadView, proposalOperationId: string, dependencyPath: string,
): Promise<VerifiedProposalOf<D>> {
  const commit = await store.getReceipt(proposalOperationId);
  if (commit === null || commit.proposal === undefined) throw new PortableDenied();
  const receipt = commit.proposal;
  const paths = proposalPaths(proposalOperationId);
  const plan = await readVerifiedRecord<ProposalPlanV1>(store, paths.plan, receipt.planDigest);
  const dependencies = await readVerifiedRecord<D>(store, dependencyPath, receipt.applyDependenciesDigest);
  const published = new Map(commit.published.map((object) => [object.path, object.digest]));
  const candidates: VerifiedCandidate[] = [];
  for (const summary of receipt.candidates) {
    candidates.push(await verifyCandidate(store, proposalOperationId, summary, plan, published));
  }
  if (candidateSetDigest(candidates.map((entry) => entry.summary)) !== receipt.candidateSetDigest) {
    throw new PortableRefusal("candidate_drift", "candidate set");
  }
  const labels = commit.published[0]?.labels ?? [];
  return { receipt, plan, dependencies, candidates, proposer: commit.actor, labels };
}
