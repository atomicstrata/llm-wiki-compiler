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
 *
 * The targeted loads and the bounded page each have ONE BODY over the record
 * directories ({@link loadCandidateOrFailFrom}, {@link loadCandidateUnderLockOrFailFrom},
 * {@link listCandidatePageFrom}); their root forms hand them the local disk's.
 * Each body keeps its CLI output and exit code exactly as the root form had them.
 */

import { candidateLeafFrom, UnsafeCandidateIdError } from "./candidate-paths.js";
import { diskLocalRecordDirs } from "../storage/disk-local-record-dirs.js";
import type { LegacyLocalRecordDirs, LocalRecordDirectory, LocalRecordLeaf } from "../storage/legacy-local-record-dirs.js";
import { TextDecoder } from "node:util";
import { listCandidateFileIdsFrom } from "../utils/candidate-store.js";
import {
  UnsafeCandidateDirError,
} from "./candidate-store-paths.js";
import * as output from "../utils/output.js";
import { CANDIDATES_DIR } from "../utils/constants.js";
import {
  assertCandidateStoreBindingFrom,
  captureCandidateCustodyFrom,
  CandidateCustodyUnavailableError,
  CandidateLeafUnavailableError,
  diskCandidateCustodyReads,
  type CandidateCustodyRead,
  type CandidateCustodyReads,
  type CandidateCustodyReceipt,
  type CandidateStoreListReads,
  type CandidateStoreScanReads,
  type CandidateStoreBinding,
} from "./candidate-custody.js";
import { sanitizeCandidate } from "./candidate-sanitize.js";
import type { CandidateCustodyPolicy } from "./candidate-custody-limits.js";
export { DEFAULT_HELD_REASONS } from "./candidate-sanitize.js";
import type { ReviewCandidate } from "../utils/types.js";
import type { StrictIoOptions } from "../utils/path-confine.js";
import { assertAnswerCandidateMetadata, InvalidCandidateMetadataError } from "../citations/answer-manifest.js";

/** Targeted review reads report invalid metadata; collection reads warn and skip. */
interface CandidateReadOptions extends StrictIoOptions { rejectInvalidMetadata?: boolean }

/** Fatal decoder: persisted mutation authority never repairs malformed UTF-8. */
const CANDIDATE_DECODER = new TextDecoder("utf-8", { fatal: true });

/** Internal candidate enumeration entry retaining both observable identities. */
export interface CandidateFileEntry {
  readonly fileId: string;
  readonly candidate: ReviewCandidate;
  readonly custodyReceipt: CandidateCustodyReceipt;
}

/** A bounded regular candidate leaf whose bytes cannot form a valid record. */
export class CandidateRecordMalformedError extends Error {
  constructor() {
    super("candidate record is malformed; inspect .llmwiki/candidates and repair or quarantine invalid records before compiling");
    this.name = "CandidateRecordMalformedError";
  }
}

/** Maximum pending JSON leaves a strict mutation scan will authorize. */
const MAX_MUTATION_JSON_LEAVES = 200;

/** One archive entry plus the maximum JSON leaves may exist directly. */
const MAX_MUTATION_DIRECT_ENTRIES = 201;
/** Suffix of the entries the strict mutation scan names; the stem is the file id. */
const MUTATION_LEAF_SUFFIX = ".json";

/** Deterministic seams for candidate-store replacement tests. */
export interface CandidateMutationScanHooks {
  afterInitialCustodyForTest?: () => Promise<void>;
  afterOpenForTest?: () => Promise<void>;
}

/**
 * Validate the public store path, then capture one race-sensitive binding,
 * over the custody-read mechanisms. The ordinary confined resolution (aliases
 * allowed) decides absence first (`null`); only then is the binding captured,
 * literal by default, and a binding that vanished in between is
 * `CandidateCustodyUnavailableError`. When aliases are allowed the resolution
 * already IS that binding (the same capture with the same arguments), so it is
 * returned rather than captured again back to back.
 */
export async function captureCandidateMutationStoreBindingFrom(
  reads: CandidateCustodyReads,
  requireLiteral = true,
): Promise<CandidateStoreBinding | null> {
  const resolved = await reads.captureDirectory(CANDIDATES_DIR);
  if (resolved === null || !requireLiteral) return resolved;
  const binding = await reads.captureDirectory(CANDIDATES_DIR, requireLiteral);
  if (binding === null) throw new CandidateCustodyUnavailableError();
  return binding;
}

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
export async function listLinkResolvablePendingSlugs(root: string, options: StrictIoOptions = {}): Promise<Set<string>> {
  return listLinkResolvablePendingSlugsFrom(diskLocalRecordDirs(root), options);
}

/** {@link listLinkResolvablePendingSlugs} through `dirs`: THE ONE BODY. The tolerant pending list, then the one rule: typed candidates are left out. */
export async function listLinkResolvablePendingSlugsFrom(dirs: LegacyLocalRecordDirs, options: StrictIoOptions = {}): Promise<Set<string>> {
  const candidates = await listCandidatesFrom(dirs, options);
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
  return loadCandidateOrFailFrom(diskLocalRecordDirs(root), id);
}

/** {@link loadCandidateOrFail} through `dirs`: THE ONE BODY. */
export async function loadCandidateOrFailFrom(dirs: LegacyLocalRecordDirs, id: string): Promise<ReviewCandidate | null> {
  const candidate = await readTargetedCandidate(dirs, id);
  if (candidate === undefined) return null;
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
  return loadCandidateUnderLockOrFailFrom(diskLocalRecordDirs(root), id);
}

/** {@link loadCandidateUnderLockOrFail} through `dirs`: THE ONE BODY. */
export async function loadCandidateUnderLockOrFailFrom(dirs: LegacyLocalRecordDirs, id: string): Promise<ReviewCandidate | null> {
  const candidate = await readTargetedCandidate(dirs, id);
  if (candidate === undefined) return null;
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
export function readCandidate(
  root: string,
  id: string,
  opts: CandidateReadOptions = {},
): Promise<ReviewCandidate | null> {
  return readCandidateFrom(diskLocalRecordDirs(root), id, opts);
}

/** {@link readCandidate}, with the leaf resolved and read through `dirs`. */
export async function readCandidateFrom(
  dirs: LegacyLocalRecordDirs,
  id: string,
  opts: CandidateReadOptions = {},
): Promise<ReviewCandidate | null> {
  return (await readCandidateSnapshotFrom(dirs, id, opts))?.candidate ?? null;
}

/** Render typed admission failures without disguising them as missing files. */
async function readTargetedCandidate(dirs: LegacyLocalRecordDirs, id: string): Promise<ReviewCandidate | null | undefined> {
  try { return await readCandidateFrom(dirs, id, { rejectInvalidMetadata: true }); }
  catch (error) {
    if (!(error instanceof InvalidCandidateMetadataError)) throw error;
    failWithError(error.message);
    return undefined;
  }
}

/** Preserve missing-file semantics while allowing snapshot callers to see faults. */
async function readCandidateBytes(leaf: LocalRecordLeaf, opts: StrictIoOptions): Promise<string> {
  if (!opts.strictIo) return leaf.readText().catch(() => "");
  try {
    return await leaf.readText();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw err;
  }
}

/** Load once and retain original bytes for advisory evaluation revision/evidence identity. */
export function readCandidateSnapshot(
  root: string,
  id: string,
  opts: CandidateReadOptions = {},
): Promise<{ candidate: ReviewCandidate; raw: string } | null> {
  return readCandidateSnapshotFrom(diskLocalRecordDirs(root), id, opts);
}

/**
 * {@link readCandidateSnapshot}, with the leaf resolved and read through `dirs`.
 * The leaf is resolved BEFORE the read and outside its error handling, so a
 * resolution failure propagates and only a failed read is treated as absence.
 * In no package index.
 */
export async function readCandidateSnapshotFrom(
  dirs: LegacyLocalRecordDirs,
  id: string,
  opts: CandidateReadOptions = {},
): Promise<{ candidate: ReviewCandidate; raw: string } | null> {
  const raw = await readCandidateBytes(await candidateLeafFrom(dirs, id), opts);
  if (!raw) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch {
    output.note(`[llmwiki] Skipping unparseable candidate file: ${id}.json`);
    return null;
  }
  try { assertAnswerCandidateMetadata(parsed, id); }
  catch (error) {
    if (!(error instanceof InvalidCandidateMetadataError) || opts.rejectInvalidMetadata) throw error;
    output.note(`[llmwiki] Skipping candidate file: ${id}.json (${error.message})`);
    return null;
  }
  if (!isValidCandidate(parsed)) {
    output.note(`[llmwiki] Skipping malformed candidate file: ${id}.json (missing required fields)`);
    return null;
  }
  return { candidate: sanitizeCandidate(parsed), raw };
}

/** Parse, validate, and sanitize one exact bounded custody read. */
function parseCandidateEntry(
  fileId: string,
  custody: CandidateCustodyRead,
): CandidateFileEntry {
  const candidate = parseCandidateRecord(fileId, custody.bytes);
  return { fileId, candidate, custodyReceipt: custody.receipt };
}

/**
 * Decode, validate and sanitize one stored candidate record from its bytes.
 * Pure: it reads no store, so any proposal store shares this exact admission.
 *
 * @param fileId - The id the record is stored under (bound into its metadata check).
 * @param bytes - The stored record bytes.
 * @returns The sanitized candidate.
 * @throws CandidateRecordMalformedError when the bytes are not a valid record.
 */
function parseCandidateRecord(fileId: string, bytes: Uint8Array): ReviewCandidate {
  let parsed: unknown;
  try {
    parsed = JSON.parse(CANDIDATE_DECODER.decode(bytes));
  } catch {
    throw new CandidateRecordMalformedError();
  }
  // Invalid validated-answer metadata is malformed for mutation purposes too:
  // such a record is never a canonical dedup match and never a strict read.
  try {
    assertAnswerCandidateMetadata(parsed, fileId);
  } catch (error) {
    if (error instanceof InvalidCandidateMetadataError) throw new CandidateRecordMalformedError();
    throw error;
  }
  if (!isValidCandidate(parsed)) throw new CandidateRecordMalformedError();
  return sanitizeCandidate(parsed);
}

/** Read one candidate entry, returning null only for a genuinely absent leaf. */
async function readCandidateEntryFrom(
  reads: CandidateCustodyReads,
  fileId: string,
  expectedStore?: CandidateStoreBinding,
  policy: CandidateCustodyPolicy = "bounded",
): Promise<CandidateFileEntry | null> {
  const custody = await captureCandidateCustodyFrom(reads, fileId, expectedStore, policy);
  return custody === null ? null : parseCandidateEntry(fileId, custody);
}

/** List tolerant-read identities while mapping store I/O to typed unavailability. */
async function listCandidateFileIdsForRead(directory: LocalRecordDirectory): Promise<string[]> {
  return idsOrCustodyUnavailable(() => listCandidateFileIdsFrom(directory));
}

/** Run one tolerant id listing; any failure of the listing itself means custody is unavailable. */
async function idsOrCustodyUnavailable(list: () => Promise<string[]>): Promise<string[]> {
  try {
    return await list();
  } catch {
    throw new CandidateCustodyUnavailableError();
  }
}

/** Strict mutation reader: absence and malformed/unavailable bytes fail closed. */
export async function readCandidateEntryForMutation(
  root: string,
  fileId: string,
  expectedStore?: CandidateStoreBinding,
): Promise<CandidateFileEntry> {
  // `async` so that a throw while the disk mechanisms are built REJECTS.
  return readCandidateEntryForMutationFrom(diskCandidateCustodyReads(root), fileId, expectedStore);
}

/**
 * {@link readCandidateEntryForMutation} over the custody-read mechanisms: THE
 * ONE BODY. A bounded custody capture, then the shared record admission; an
 * absent leaf fails closed as unavailable custody.
 */
export async function readCandidateEntryForMutationFrom(
  reads: CandidateCustodyReads,
  fileId: string,
  expectedStore?: CandidateStoreBinding,
): Promise<CandidateFileEntry> {
  const custody = await captureCandidateCustodyFrom(reads, fileId, expectedStore);
  if (custody === null) throw new CandidateCustodyUnavailableError();
  return parseCandidateEntry(fileId, custody);
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

/** Enumerate sanitized candidates with their confined filename identities. */
export async function listCandidateFileEntries(
  root: string,
  rejectUnsafeIds = false,
): Promise<CandidateFileEntry[]> {
  // `async` so that a throw while the disk mechanisms are built REJECTS.
  return listCandidateFileEntriesFrom(diskCandidateCustodyReads(root), rejectUnsafeIds);
}

/**
 * {@link listCandidateFileEntries} over the custody-read mechanisms: THE ONE
 * BODY. The confined resolution (aliases allowed) decides absence; the tolerant
 * direct-file `.json` listing, the public-policy reads, which faults skip a
 * leaf and which propagate, the skip note and the generation-then-UTF-8 order
 * all stay here.
 */
export async function listCandidateFileEntriesFrom(
  reads: CandidateStoreListReads,
  rejectUnsafeIds = false,
): Promise<CandidateFileEntry[]> {
  const dir = (await reads.captureDirectory(CANDIDATES_DIR))?.realDir ?? null;
  if (dir === null) return []; // absent candidates dir → nothing pending
  const ids = await listCandidateFileIdsForRead(reads.recordDirectory(dir));
  const entries: CandidateFileEntry[] = [];
  for (const fileId of ids) {
    try {
      const entry = await readCandidateEntryFrom(reads, fileId, undefined, "public");
      if (entry) entries.push(entry);
    } catch (error) {
      if (error instanceof UnsafeCandidateDirError ||
          (error instanceof CandidateCustodyUnavailableError && !(error instanceof CandidateLeafUnavailableError)) ||
          (rejectUnsafeIds && error instanceof UnsafeCandidateIdError)) throw error;
      output.note(`[llmwiki] Skipping unparseable candidate file: ${fileId}.json`);
    }
  }
  entries.sort(compareCandidateEntries);
  return entries;
}

/** Compare exact filename identities by their UTF-8 byte sequence. */
export function compareCandidateFileIdsUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

/** Deterministic generation-time then exact filename-byte ordering. */
function compareCandidateEntries(left: CandidateFileEntry, right: CandidateFileEntry): number {
  const generated = left.candidate.generatedAt < right.candidate.generatedAt
    ? -1
    : Number(left.candidate.generatedAt > right.candidate.generatedAt);
  return generated || compareCandidateFileIdsUtf8(left.fileId, right.fileId);
}

/** Enumerate through one previously captured store binding. */
export async function listCandidateMutationFileIdsForBinding(
  root: string,
  binding: CandidateStoreBinding,
  hooks: CandidateMutationScanHooks = {},
): Promise<string[]> {
  // `async` so that a throw while the disk mechanisms are built REJECTS.
  return listCandidateMutationFileIdsForBindingFrom(diskCandidateCustodyReads(root), binding, hooks);
}

/**
 * {@link listCandidateMutationFileIdsForBinding} over the custody-read
 * mechanisms: THE ONE BODY. The scan's caps, suffix, store re-proof, overflow
 * refusal, fault mapping and UTF-8 order stay here; the mechanism only streams.
 */
export async function listCandidateMutationFileIdsForBindingFrom(
  reads: CandidateStoreScanReads,
  binding: CandidateStoreBinding,
  hooks: CandidateMutationScanHooks = {},
): Promise<string[]> {
  let ids: string[];
  try {
    ids = await reads.enumerate(binding, {
      suffix: MUTATION_LEAF_SUFFIX,
      maxDirectEntries: MAX_MUTATION_DIRECT_ENTRIES,
      maxNames: MAX_MUTATION_JSON_LEAVES,
      recheck: () => assertCandidateStoreBindingFrom(reads, binding),
      overflow: () => new CandidateCustodyUnavailableError(),
      beforeOpen: async () => { await hooks.afterInitialCustodyForTest?.(); },
      afterOpen: async () => { await hooks.afterOpenForTest?.(); },
    });
  } catch (error) {
    if (error instanceof CandidateCustodyUnavailableError) throw error;
    throw new CandidateCustodyUnavailableError();
  }
  return ids.sort(compareCandidateFileIdsUtf8);
}

/** Sort a selected mutation batch using the shared deterministic order. */
export function sortCandidateFileEntries(entries: CandidateFileEntry[]): CandidateFileEntry[] {
  return entries.sort(compareCandidateEntries);
}

/**
 * File ids of every pending candidate file, from one `readdir`. Nothing is
 * opened here — this is the cheap half of listing, and the only half
 * {@link listCandidatePage} is willing to pay in full.
 * @param root - Project root directory.
 * @returns Candidate file ids, or an empty list when the directory is absent.
 */
async function pendingCandidateFileIds(dirs: LegacyLocalRecordDirs): Promise<string[]> {
  const directory = await dirs.directory(CANDIDATES_DIR);
  if (directory === null) return []; // absent candidates dir → nothing pending
  return idsOrCustodyUnavailable(() => listCandidateFileIdsFrom(directory));
}

/** Read and sanitize the named candidates, dropping the ones that fail to parse. */
async function readCandidatesByIds(dirs: LegacyLocalRecordDirs, ids: string[], opts: StrictIoOptions = {}): Promise<ReviewCandidate[]> {
  const candidates: ReviewCandidate[] = [];
  for (const id of ids) {
    const candidate = await readCandidateFrom(dirs, id, opts);
    if (candidate) candidates.push(candidate);
  }
  return candidates;
}

/**
 * List every candidate currently pending review, sorted by generation time.
 * Skips files that aren't candidate JSON (e.g. the archive subdirectory).
 *
 * Reads and parses EVERY candidate file, which is what sorting on
 * `generatedAt` — a field inside each file — costs. Callers serving a request
 * per visit should use {@link listCandidatePage} instead.
 * @param root - Project root directory.
 * @param opts - Strict I/O propagates per-file read faults while retaining admission warnings.
 * @returns All pending review candidates.
 */
export function listCandidates(root: string, opts: StrictIoOptions = {}): Promise<ReviewCandidate[]> {
  return listCandidatesFrom(diskLocalRecordDirs(root), opts);
}

/**
 * {@link listCandidates}, with the directory and each leaf resolved and read
 * through `dirs`. Ordered by generation time ONLY: records generated at the
 * same instant keep the backend's listing order, with no id tie-break.
 */
export async function listCandidatesFrom(dirs: LegacyLocalRecordDirs, opts: StrictIoOptions = {}): Promise<ReviewCandidate[]> {
  const candidates = await readCandidatesByIds(dirs, await pendingCandidateFileIds(dirs), opts);
  candidates.sort((a, b) => a.generatedAt.localeCompare(b.generatedAt));
  return candidates;
}

/** A bounded slice of the pending queue, plus how many candidates exist behind it. */
export interface CandidatePage {
  /** The candidates actually read, at most `limit` of them. */
  candidates: ReviewCandidate[];
  /** How many pending candidates exist on disk — NOT the length of `candidates`. */
  total: number;
}

/**
 * Read a BOUNDED slice of the pending queue, plus the total behind it.
 *
 * ORDERING GUARANTEE: candidates are selected AND returned in ascending
 * candidate file id order — for compiler-written candidates that is
 * `<slug>-<random suffix>`, so effectively alphabetical by proposed slug. It is
 * deliberately NOT {@link listCandidates}' `generatedAt` order: `generatedAt`
 * lives inside each file, so honouring it would mean reading and parsing every
 * candidate to decide which handful to serve — exactly the unbounded cost this
 * function exists to remove. Id order is acceptable in exchange because it is
 * stable (the same call returns the same slice, so a revisit is not a reshuffle)
 * and because a review queue is a set of things to work through rather than a
 * timeline. `listCandidates` keeps its `generatedAt` ordering for `review list`
 * and every other caller.
 *
 * `total` counts candidate FILES, since counting them exactly is what reading
 * them all would cost. Files inside the served slice that fail to parse are
 * discounted, so when the whole queue fits under `limit` the total is exactly
 * `listCandidates(root).length`; above it, a malformed file beyond the slice
 * inflates the total by one rather than being silently dropped.
 *
 * @param root - Project root directory.
 * @param limit - Maximum candidates to read and return.
 * @returns The bounded slice and the true pending total.
 */
export async function listCandidatePage(root: string, limit: number): Promise<CandidatePage> {
  return listCandidatePageFrom(diskLocalRecordDirs(root), limit);
}

/** {@link listCandidatePage} through `dirs`: THE ONE BODY. */
export async function listCandidatePageFrom(dirs: LegacyLocalRecordDirs, limit: number): Promise<CandidatePage> {
  const page = await listCandidateIdentityPageFrom(dirs, limit);
  return { candidates: page.entries.map(entry => entry.candidate), total: page.total };
}

/** Bounded read retaining the file identity used by targeted review commands. */
export function listCandidateIdentityPage(root: string, limit: number): Promise<{
  entries: Array<{ fileId: string; candidate: ReviewCandidate }>; total: number;
}> {
  return listCandidateIdentityPageFrom(diskLocalRecordDirs(root), limit);
}

/** {@link listCandidateIdentityPage}, with the directory and each leaf resolved and read through `dirs`. */
export async function listCandidateIdentityPageFrom(dirs: LegacyLocalRecordDirs, limit: number): Promise<{
  entries: Array<{ fileId: string; candidate: ReviewCandidate }>; total: number;
}> {
  // Plain sort: lexicographic by UTF-16 code unit, so the slice is identical on
  // every machine. `localeCompare` would make it depend on the host locale.
  const ids = (await pendingCandidateFileIds(dirs)).sort();
  const served = ids.slice(0, limit);
  const entries = [];
  for (const fileId of served) {
    const candidate = await readCandidateFrom(dirs, fileId);
    if (candidate) entries.push({ fileId, candidate });
  }
  const unreadableInSlice = served.length - entries.length;
  return { entries, total: ids.length - unreadableInSlice };
}

/**
 * Count pending candidates using the same validity filter as listCandidates,
 * so consumers (e.g. `wiki_status.pendingCandidates`) never report counts
 * that disagree with what `review list` actually shows. Malformed JSON files
 * are skipped here exactly as they are by listCandidates.
 */
export function countCandidates(root: string): Promise<number> {
  return countCandidatesFrom(diskLocalRecordDirs(root));
}

/** {@link countCandidates} through `dirs`: the length of the tolerant, NON-strict list. */
export async function countCandidatesFrom(dirs: LegacyLocalRecordDirs): Promise<number> {
  const candidates = await listCandidatesFrom(dirs);
  return candidates.length;
}
