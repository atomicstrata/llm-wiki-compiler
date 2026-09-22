/**
 * @file src/compiler/candidate-selection.ts
 * @description Content-selected candidate mutation authority. Enumeration keeps
 * each parsed record paired with its confined filename, validates the complete
 * selected batch, and exposes only filename identities as mutation locators.
 */

import {
  captureCandidateMutationStoreBinding,
  listCandidateFileEntries,
  listCandidateMutationFileIdsForBinding,
  readCandidateEntryForMutation,
  sortCandidateFileEntries,
  type CandidateFileEntry,
  type CandidateMutationScanHooks,
} from "./candidate-read.js";
import {
  assertCandidateStoreBinding,
} from "./candidate-custody.js";
import { assertCandidateId, UnsafeCandidateIdError } from "./candidate-paths.js";
import type { ReviewCandidate } from "../utils/types.js";

/** Prefix reserved for operation-bundle review identities. */
const BUNDLE_ID_PREFIX = "bnd_";

/** Exact aggregate serialized-byte ceiling for one strict mutation scan. */
export const MAX_CANDIDATE_MUTATION_SCAN_BYTES = 64 * 1024 * 1024;

/** Predicate used to select candidate records by caller-owned content identity. */
export type CandidateMutationSelector = (candidate: ReviewCandidate) => boolean;

/** Optional stop-before-materialization bound for one content selection. */
export interface CandidateSelectionBounds {
  readonly maxSelected: number;
  readonly overflowError: () => Error;
}

/** End-to-end selection hooks used only for deterministic store-race tests. */
export interface CandidateMutationSelectionHooks extends CandidateMutationScanHooks {
  afterEnumerationForTest?: () => Promise<void>;
  beforeReturnForTest?: () => Promise<void>;
  maxMutationBytesForTest?: number;
}

/** One binding-owned strict snapshot used for projection and mutation. */
export interface CandidateMutationSelection {
  readonly totalPending: number;
  readonly entries: readonly CandidateFileEntry[];
}

/** A candidate record cannot authorize mutation of a differently named file. */
export class CandidateIdentityMismatchError extends Error {
  constructor(_fileId: string, _recordId: string) {
    super("candidate identity mismatch: filename and record identities differ");
    this.name = "CandidateIdentityMismatchError";
  }
}

/** Typed fixed refusal when a strict scan exceeds its aggregate byte budget. */
export class CandidateMutationScanCapacityError extends Error {
  constructor() {
    super("candidate mutation scan byte capacity exhausted");
    this.name = "CandidateMutationScanCapacityError";
  }
}

/** Add one exact receipt size without retaining an over-cap entry. */
function addScannedBytes(total: number, byteCount: number, limit: number): number {
  if (byteCount > limit - total) throw new CandidateMutationScanCapacityError();
  return total + byteCount;
}

/** Resolve a test ceiling that can tighten, but never widen, launch authority. */
function mutationScanByteLimit(testLimit?: number): number {
  if (testLimit === undefined) return MAX_CANDIDATE_MUTATION_SCAN_BYTES;
  if (!Number.isSafeInteger(testLimit) || testLimit < 0) {
    throw new CandidateMutationScanCapacityError();
  }
  return Math.min(testLimit, MAX_CANDIDATE_MUTATION_SCAN_BYTES);
}

/** The full target identity of one candidate or draft. */
export function candidateTargetKey(candidate: {
  targetEntityType?: string;
  targetDirectory?: string;
  slug: string;
}): string {
  const target = candidate.targetEntityType ?? candidate.targetDirectory ?? "concepts";
  return `${target}/${candidate.slug}`;
}

/** True when a candidate id aliases the bundle namespace on supported filesystems. */
function isReservedCandidateId(candidateId: string): boolean {
  return candidateId.slice(0, BUNDLE_ID_PREFIX.length).toLowerCase() === BUNDLE_ID_PREFIX;
}

/** Reject every candidate id that overlaps the operation-bundle namespace. */
export function assertCandidateIdsWritable(candidateIds: readonly (string | null)[]): void {
  for (const candidateId of candidateIds) {
    if (candidateId === null) continue;
    assertCandidateId(candidateId);
    if (isReservedCandidateId(candidateId)) {
      throw new UnsafeCandidateIdError("id", candidateId);
    }
  }
}

/** Validate both identities for the full selected batch before any mutation. */
function assertCandidateEntriesWritable(entries: readonly CandidateFileEntry[]): void {
  const observedIds = entries.flatMap(({ fileId, candidate }) => [fileId, candidate.id]);
  assertCandidateIdsWritable(observedIds);
  for (const { fileId, candidate } of entries) {
    if (fileId !== candidate.id) {
      throw new CandidateIdentityMismatchError(fileId, candidate.id);
    }
  }
}

/**
 * Enumerate, content-select, and validate a candidate mutation batch.
 * Callers must use each returned `fileId` for every archive, delete, restore,
 * audit, and result identity; the embedded record id is an assertion only.
 */
export async function selectCandidateEntriesForMutation(
  root: string,
  selector: CandidateMutationSelector,
  bounds?: CandidateSelectionBounds,
): Promise<CandidateFileEntry[]> {
  const selection = await selectCandidateEntriesForMutationWithTotal(root, selector, bounds);
  return [...selection.entries];
}

/**
 * Public candidate discovery skips malformed unrelated records. Preserve that
 * behavior for ordinary generation/cleanup while validating the selected files'
 * identities and retaining exact-byte receipts for subsequent mutation. New
 * authority operations use the strict whole-store selector above instead.
 */
export async function selectReadableCandidateEntriesForMutation(
  root: string, selector: CandidateMutationSelector,
  bounds?: CandidateSelectionBounds,
  hooks: CandidateMutationSelectionHooks = {},
): Promise<CandidateFileEntry[]> {
  const binding = await captureCandidateMutationStoreBinding(root, false);
  if (binding === null) return [];
  await hooks.afterInitialCustodyForTest?.();
  await hooks.afterOpenForTest?.();
  const selected = (await listCandidateFileEntries(root, true)).filter(entry => selector(entry.candidate));
  await hooks.afterEnumerationForTest?.();
  if (bounds && selected.length > bounds.maxSelected) throw bounds.overflowError();
  assertCandidateEntriesWritable(selected);
  await hooks.beforeReturnForTest?.();
  await assertCandidateStoreBinding(root, binding);
  return selected;
}

/** Select and count under one store binding through the final receipt read. */
export async function selectCandidateEntriesForMutationWithTotal(
  root: string,
  selector: CandidateMutationSelector,
  bounds?: CandidateSelectionBounds,
  hooks: CandidateMutationSelectionHooks = {},
): Promise<CandidateMutationSelection> {
  const binding = await captureCandidateMutationStoreBinding(root);
  if (binding === null) return Object.freeze({ totalPending: 0, entries: Object.freeze([]) });
  const fileIds = await listCandidateMutationFileIdsForBinding(root, binding, hooks);
  await hooks.afterEnumerationForTest?.();
  const selected: CandidateFileEntry[] = [];
  const byteLimit = mutationScanByteLimit(hooks.maxMutationBytesForTest);
  let scannedBytes = 0;
  for (const fileId of fileIds) {
    const entry = await readCandidateEntryForMutation(root, fileId, binding);
    scannedBytes = addScannedBytes(scannedBytes, entry.custodyReceipt.byteCount, byteLimit);
    if (!selector(entry.candidate)) continue;
    if (bounds && selected.length >= bounds.maxSelected) throw bounds.overflowError();
    selected.push(entry);
  }
  sortCandidateFileEntries(selected);
  assertCandidateEntriesWritable(selected);
  const result = Object.freeze({
    totalPending: fileIds.length,
    entries: Object.freeze(selected),
  });
  await hooks.beforeReturnForTest?.();
  await assertCandidateStoreBinding(root, binding);
  return result;
}
