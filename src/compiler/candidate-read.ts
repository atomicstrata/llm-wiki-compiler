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

import { candidatePath, UnsafeCandidateIdError } from "./candidate-paths.js";
import { safeReadFile } from "../utils/markdown.js";
import { TextDecoder } from "node:util";
import { opendir } from "node:fs/promises";
import { listCandidateFileIds } from "../utils/candidate-store.js";
import {
  resolveConfinedCandidatesDir,
  UnsafeCandidateDirError,
} from "./candidate-store-paths.js";
import * as output from "../utils/output.js";
import { CANDIDATES_DIR } from "../utils/constants.js";
import {
  assertCandidateStoreBinding,
  captureCandidateCustody,
  captureCandidateStoreBinding,
  CandidateCustodyUnavailableError,
  CandidateLeafUnavailableError,
  type CandidateCustodyRead,
  type CandidateCustodyReceipt,
  type CandidateStoreBinding,
} from "./candidate-custody.js";
import { sanitizeCandidate } from "./candidate-sanitize.js";
import type { CandidateCustodyPolicy } from "./candidate-custody-limits.js";
export { DEFAULT_HELD_REASONS } from "./candidate-sanitize.js";
import type { ReviewCandidate } from "../utils/types.js";
import { readFile } from "fs/promises";
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

/** Deterministic seams for candidate-store replacement tests. */
export interface CandidateMutationScanHooks {
  afterInitialCustodyForTest?: () => Promise<void>;
  afterOpenForTest?: () => Promise<void>;
}

/** Validate the public store path, then capture one race-sensitive binding. */
export async function captureCandidateMutationStoreBinding(
  root: string,
  requireLiteral = true,
): Promise<CandidateStoreBinding | null> {
  const resolved = await resolveConfinedCandidatesDir(root, CANDIDATES_DIR);
  if (resolved === null) return null;
  const binding = await captureCandidateStoreBinding(root, requireLiteral);
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
  const candidates = await listCandidates(root, options);
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
  const candidate = await readTargetedCandidate(root, id);
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
  const candidate = await readTargetedCandidate(root, id);
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
export async function readCandidate(
  root: string,
  id: string,
  opts: CandidateReadOptions = {},
): Promise<ReviewCandidate | null> {
  return (await readCandidateSnapshot(root, id, opts))?.candidate ?? null;
}

/** Render typed admission failures without disguising them as missing files. */
async function readTargetedCandidate(root: string, id: string): Promise<ReviewCandidate | null | undefined> {
  try { return await readCandidate(root, id, { rejectInvalidMetadata: true }); }
  catch (error) {
    if (!(error instanceof InvalidCandidateMetadataError)) throw error;
    failWithError(error.message);
    return undefined;
  }
}

/** Preserve missing-file semantics while allowing snapshot callers to see faults. */
async function readCandidateBytes(file: string, opts: StrictIoOptions): Promise<string> {
  if (!opts.strictIo) return safeReadFile(file);
  try {
    return await readFile(file, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw err;
  }
}

/** Load once and retain original bytes for advisory evaluation revision/evidence identity. */
export async function readCandidateSnapshot(
  root: string,
  id: string,
  opts: CandidateReadOptions = {},
): Promise<{ candidate: ReviewCandidate; raw: string } | null> {
  const raw = await readCandidateBytes(await candidatePath(root, id), opts);
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
  let parsed: unknown;
  try {
    parsed = JSON.parse(CANDIDATE_DECODER.decode(custody.bytes));
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
  return { fileId, candidate: sanitizeCandidate(parsed), custodyReceipt: custody.receipt };
}

/** Read one candidate entry, returning null only for a genuinely absent leaf. */
async function readCandidateEntry(
  root: string,
  fileId: string,
  expectedStore?: CandidateStoreBinding,
  policy: CandidateCustodyPolicy = "bounded",
): Promise<CandidateFileEntry | null> {
  const custody = await captureCandidateCustody(root, fileId, expectedStore, policy);
  return custody === null ? null : parseCandidateEntry(fileId, custody);
}

/** List tolerant-read identities while mapping store I/O to typed unavailability. */
async function listCandidateFileIdsForRead(dir: string): Promise<string[]> {
  try {
    return await listCandidateFileIds(dir);
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
  const entry = await readCandidateEntry(root, fileId, expectedStore);
  if (entry === null) throw new CandidateCustodyUnavailableError();
  return entry;
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
  const dir = await resolveConfinedCandidatesDir(root, CANDIDATES_DIR);
  if (dir === null) return []; // absent candidates dir → nothing pending
  const ids = await listCandidateFileIdsForRead(dir);
  const entries: CandidateFileEntry[] = [];
  for (const fileId of ids) {
    try {
      const entry = await readCandidateEntry(root, fileId, undefined, "public");
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
  const ids: string[] = [];
  let directEntries = 0;
  let directory: Awaited<ReturnType<typeof opendir>> | undefined;
  try {
    await hooks.afterInitialCustodyForTest?.();
    await assertCandidateStoreBinding(root, binding);
    directory = await opendir(binding.realDir);
    await hooks.afterOpenForTest?.();
    await assertCandidateStoreBinding(root, binding);
    for await (const entry of directory) {
      directEntries += 1;
      if (directEntries > MAX_MUTATION_DIRECT_ENTRIES) {
        throw new CandidateCustodyUnavailableError();
      }
      if (!entry.name.endsWith(".json")) continue;
      if (ids.length >= MAX_MUTATION_JSON_LEAVES) {
        throw new CandidateCustodyUnavailableError();
      }
      ids.push(entry.name.slice(0, -5));
    }
    await assertCandidateStoreBinding(root, binding);
  } catch (error) {
    if (error instanceof CandidateCustodyUnavailableError) throw error;
    throw new CandidateCustodyUnavailableError();
  } finally {
    await directory?.close().catch(() => {});
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
async function pendingCandidateFileIds(root: string): Promise<string[]> {
  const dir = await resolveConfinedCandidatesDir(root, CANDIDATES_DIR);
  if (dir === null) return []; // absent candidates dir → nothing pending
  return listCandidateFileIdsForRead(dir);
}

/** Read and sanitize the named candidates, dropping the ones that fail to parse. */
async function readCandidatesByIds(root: string, ids: string[], opts: StrictIoOptions = {}): Promise<ReviewCandidate[]> {
  const candidates: ReviewCandidate[] = [];
  for (const id of ids) {
    const candidate = await readCandidate(root, id, opts);
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
export async function listCandidates(root: string, opts: StrictIoOptions = {}): Promise<ReviewCandidate[]> {
  const candidates = await readCandidatesByIds(root, await pendingCandidateFileIds(root), opts);
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
  // Plain sort: lexicographic by UTF-16 code unit, so the slice is identical on
  // every machine. `localeCompare` would make it depend on the host locale.
  const ids = (await pendingCandidateFileIds(root)).sort();
  const served = ids.slice(0, limit);
  const candidates = await readCandidatesByIds(root, served);
  const unreadableInSlice = served.length - candidates.length;
  return { candidates, total: ids.length - unreadableInSlice };
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
