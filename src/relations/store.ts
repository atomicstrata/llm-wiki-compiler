/**
 * @file src/relations/store.ts
 * @description The WRITE half of the append-only relation store. Canonicalizes
 * symmetric endpoints, validates the CANONICAL relation against its profile
 * relation-type def, mints a stable `rel_<ULID>` id, and APPENDS the record
 * (record + checksum) under the project lock as a single writer. A new store
 * gets a header line first. The read half lives in `store-read.ts`.
 *
 * DEDUP (FIX #6): under the lock, an append whose `contentHash` matches a LIVE
 * relation short-circuits to that existing ref WITHOUT appending — so a
 * symmetric (a→b) then (b→a) (which canonicalize identically) collapse to ONE
 * record. Creates are idempotent on content.
 *
 * DURABILITY: appends use O_APPEND under a bounded-blocking project lock so a
 * single writer extends the file. There is NO fsync: a clean process crash can
 * leave a torn TRAILING line (the reader tolerates and reports it), but
 * power-loss durability is NOT provided, and an interior tear fails the store
 * closed. Appends FAIL CLOSED ({@link RelationStoreFullError}) at the read cap;
 * {@link compactRelations} is the escape valve. CONFINEMENT: the graph dir is
 * resolved through {@link resolveGraphDir}, which fails closed if `wiki/graph` is
 * a symlink escaping root.
 *
 * UPDATE: because the store is append-only, {@link updateRelation} appends a
 * NEW record carrying the SAME `id` with a recomputed `contentHash`, under ONE
 * lock with its base re-read (FIX #5, no lost update). The reader returns the
 * latest record per id, so the prior record is superseded while staying on disk
 * for audit. Changing `type`/`from`/`to` is a delete+create (a different edge)
 * and is NOT an update — callers pass only attributes/evidence.
 */

import { open, mkdir, rename, stat, writeFile } from "fs/promises";
import path from "path";
import { RELATIONS_FILE, MAX_RELATION_RECORD_BYTES, MAX_RELATION_STORE_BYTES } from "../utils/constants.js";
import { acquireLockBlocking, releaseLock } from "../utils/lock.js";
import type { EntityId, ProfilePack, RelationTypeDef } from "../profile/types.js";
import type { CitationRef, RelationRef } from "./types.js";
import { RelationEndpointError, RelationStoreFullError } from "./types.js";
import { mintRelationId } from "./ulid.js";
import { canonicalEndpoints, relationContentHash } from "./digest.js";
import { headerLine, serializeRecord, resolveGraphDir } from "./store-record.js";
import { readRelations } from "./store-read.js";
import { validateRelationAttributes, validateRelationEndpoints, validateRelationAgainstProfile } from "./relation-contract.js";

/** The caller-supplied content of a new relation (id + hash are derived). */
export interface AppendRelationInput {
  type: string;
  from: EntityId;
  to: EntityId;
  attributes?: Record<string, unknown>;
  evidence?: CitationRef[];
}

/** An in-place attribute/evidence patch applied under an existing relation id. */
export interface UpdateRelationPatch {
  attributes?: Record<string, unknown>;
  evidence?: CitationRef[];
}

/** Look up a relation-type def, failing closed if the type is undeclared. */
function relationDef(profile: ProfilePack, type: string): RelationTypeDef {
  const def = profile.relations?.[type];
  if (!def) {
    throw new RelationEndpointError(`unknown relation type '${type}'`);
  }
  return def;
}

/**
 * Assert a relation's CANONICAL endpoints satisfy the relation-type def via the
 * SHARED {@link validateRelationEndpoints}, throwing on any violation. Called
 * AFTER canonicalization so the WRITE enforces exactly what the READ
 * ({@link validateRelationAgainstProfile}) re-validates on the same stored bytes —
 * for a symmetric type whose `from`-type sorts after its `to`-type, the swap can
 * never produce a record the read surfaces then flag invalid.
 */
function assertCanonicalEndpoints(def: RelationTypeDef, from: EntityId, to: EntityId, type: string): void {
  const reasons = validateRelationEndpoints(def, from, to);
  if (reasons.length > 0) {
    throw new RelationEndpointError(`relation '${type}' ${reasons.join("; ")}`);
  }
}

/**
 * Assert a relation's attributes satisfy the relation-type def's declared
 * contract — required-attribute PRESENCE AND each declared attribute's
 * type/enum/min/max (the SAME field contract entity fields enforce, via
 * {@link validateRelationAttributes}). Any violation fails closed BEFORE any
 * write, so a relation whose attribute mismatches its declared type is never
 * appended.
 */
function assertAttributesValid(def: RelationTypeDef, attributes: Record<string, unknown>, type: string): void {
  const violations = validateRelationAttributes(def, attributes);
  if (violations.length > 0) {
    throw new RelationEndpointError(`relation '${type}' has invalid attributes: ${violations.join(" ")}`);
  }
}

/**
 * Reject a relation whose serialized on-disk record exceeds
 * {@link MAX_RELATION_RECORD_BYTES}, so attacker-controlled attribute/evidence
 * size cannot grow one record unbounded (nor reach the per-store cap with one
 * line). Throws {@link RelationEndpointError} BEFORE any write.
 */
function assertRecordWithinCap(ref: RelationRef): void {
  const bytes = Buffer.byteLength(serializeRecord(ref), "utf8");
  if (bytes > MAX_RELATION_RECORD_BYTES) {
    throw new RelationEndpointError(
      `relation '${ref.type}' record ${bytes} bytes exceeds the ${MAX_RELATION_RECORD_BYTES}-byte cap`,
    );
  }
}

/**
 * Build the {@link RelationRef}: canonicalize symmetric endpoints FIRST, then
 * validate the CANONICAL endpoints + required attributes against the
 * relation-type def, mint the id (or reuse `existingId` for an update), and
 * compute the content hash. Canonicalize-THEN-validate (FIX #1) means the WRITE
 * enforces exactly what the READ re-validates, so a symmetric edge whose
 * `from`-type sorts after its `to`-type is never written swapped-then-rejected.
 * The serialized record size is capped LAST. NOTHING is written here —
 * validation throwing leaves the store untouched.
 */
function buildRelationRef(
  profile: ProfilePack,
  input: AppendRelationInput,
  existingId?: RelationRef["id"],
): RelationRef {
  const def = relationDef(profile, input.type);
  const { from, to } = canonicalEndpoints(input.from, input.to, def.direction);
  assertCanonicalEndpoints(def, from, to, input.type);
  const attributes = input.attributes ?? {};
  assertAttributesValid(def, attributes, input.type);
  const content = { type: input.type, from, to, attributes, evidence: input.evidence };
  const ref: RelationRef = { id: existingId ?? mintRelationId(), ...content, contentHash: relationContentHash(content) };
  assertRecordWithinCap(ref);
  return ref;
}

/**
 * Append one serialized record line to the store under O_APPEND, creating the
 * dir/header. FAILS CLOSED with {@link RelationStoreFullError} (FIX #4) when the
 * append would reach/exceed {@link MAX_RELATION_STORE_BYTES} — the same bound the
 * reader rejects at — so the store can never be driven past the read cap into an
 * unreadable-yet-appendable state. {@link compactRelations} is the escape valve.
 */
async function appendLine(root: string, ref: RelationRef): Promise<void> {
  const { dir } = await resolveGraphDir(root); // throws on symlink escape
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, path.basename(RELATIONS_FILE));
  const handle = await open(file, "a");
  try {
    const existing = (await handle.stat()).size;
    const header = existing === 0 ? headerLine() : "";
    const addition = Buffer.byteLength(header + serializeRecord(ref), "utf8");
    if (existing + addition >= MAX_RELATION_STORE_BYTES) {
      throw new RelationStoreFullError();
    }
    if (header) await handle.write(header);
    await handle.write(serializeRecord(ref));
  } finally {
    await handle.close();
  }
}

/** Run `fn` while holding the project lock (bounded-blocking acquire); release in a finally. */
async function underLock<T>(root: string, fn: () => Promise<T>): Promise<T> {
  await acquireLockBlocking(root); // throws LockBusyError on timeout
  try {
    return await fn();
  } finally {
    await releaseLock(root);
  }
}

/**
 * Validate and APPEND a new relation WHILE THE CALLER ALREADY HOLDS the project
 * lock — the lock-free core shared with {@link appendRelation}, mirroring the
 * {@link applyApprovedMutationsLocked} split on the page path.
 *
 * The caller MUST already hold the project lock; this function acquires NOTHING,
 * so a planner-routed write path ({@link createRelation}) can take ONE lock and
 * run validation + append inside it without a nested-acquire deadlock. Validation
 * (canonical endpoint entity types, required attributes) still runs BEFORE any
 * write, so a violation throws {@link RelationEndpointError} and writes nothing.
 * DEDUP (FIX #6): a content-hash match against a LIVE relation short-circuits to
 * that ref WITHOUT appending, so the create is idempotent on content.
 *
 * @param root - Absolute project root.
 * @param profile - The governing profile pack (its `relations` block is the schema).
 * @param input - The new relation's content.
 * @returns The persisted relation reference.
 */
export async function appendRelationLocked(
  root: string,
  profile: ProfilePack,
  input: AppendRelationInput,
): Promise<RelationRef> {
  const ref = buildRelationRef(profile, input); // throws before any write
  const { relations } = await readRelations(root); // under the caller's lock
  const duplicate = relations.find((rel) => rel.contentHash === ref.contentHash);
  if (duplicate) return duplicate; // idempotent create (FIX #6) — append nothing
  await appendLine(root, ref);
  return ref;
}

/**
 * Validate and APPEND a new relation, returning its {@link RelationRef}.
 *
 * The self-locking entry point for callers that do NOT already hold the lock:
 * acquires the project lock and delegates to {@link appendRelationLocked}.
 * Validation (endpoint entity types, required attributes) runs BEFORE any
 * write, so a violation throws {@link RelationEndpointError} and writes nothing.
 * The id is minted once; symmetric endpoints are canonicalized so (a→b) and
 * (b→a) share a content hash. The append occurs under the project lock.
 *
 * @param root - Absolute project root.
 * @param profile - The governing profile pack (its `relations` block is the schema).
 * @param input - The new relation's content.
 * @returns The persisted relation reference.
 */
export async function appendRelation(
  root: string,
  profile: ProfilePack,
  input: AppendRelationInput,
): Promise<RelationRef> {
  return underLock(root, () => appendRelationLocked(root, profile, input));
}

/**
 * Apply an in-place attribute/evidence update to an existing relation. Appends
 * a new record carrying the SAME `id` with a recomputed `contentHash`; the
 * reader returns the latest record per id, so this supersedes the prior one.
 * The relation's `type`/`from`/`to` are preserved from the existing record.
 *
 * FIX #5: the base-record lookup and the append run UNDER ONE lock — a single
 * locked read-modify-append, so two cross-process updates to the same id cannot
 * read the same stale base and last-wins clobber each other (lost update). The
 * base merged against is always the current on-disk latest.
 *
 * @param root - Absolute project root.
 * @param profile - The governing profile pack.
 * @param id - The id of the relation to update.
 * @param patch - The attribute/evidence patch to apply.
 * @returns The updated relation reference (same id, new content hash).
 */
export async function updateRelation(
  root: string,
  profile: ProfilePack,
  id: RelationRef["id"],
  patch: UpdateRelationPatch,
): Promise<RelationRef> {
  return underLock(root, async () => {
    const { relations } = await readRelations(root); // re-read INSIDE the lock
    const existing = relations.find((rel) => rel.id === id);
    if (!existing) {
      throw new RelationEndpointError(`no relation with id '${id}' to update`);
    }
    const input: AppendRelationInput = {
      type: existing.type,
      from: existing.from,
      to: existing.to,
      attributes: patch.attributes ?? existing.attributes,
      evidence: patch.evidence ?? existing.evidence,
    };
    const ref = buildRelationRef(profile, input, id);
    await appendLine(root, ref);
    return ref;
  });
}

/** The byte sizes of the store file before and after a compaction. */
export interface CompactionResult {
  /** File size before compaction (bytes). */
  before: number;
  /** File size after compaction (bytes). */
  after: number;
}

/** Stat a file's size, treating an absent file as zero bytes. */
async function fileSize(file: string): Promise<number> {
  try {
    return (await stat(file)).size;
  } catch {
    return 0;
  }
}

/** Serialize the header + the surviving records into one store-file body. */
function compactedBody(records: RelationRef[]): string {
  return headerLine() + records.map((ref) => serializeRecord(ref)).join("");
}

/**
 * Compact the relation store IN PLACE (FIX #4): under the lock, read the
 * latest-per-id records that are still VALID against `profile`, rewrite just the
 * header + those records to a temp file in the confined graph dir, and
 * atomic-rename it over `relations.jsonl`. Superseded/duplicate/now-invalid
 * records are dropped, so the store SHRINKS — the escape valve that recovers a
 * store driven up to {@link RelationStoreFullError}. The latest-per-id collapse
 * is the reader's, so no live relation is lost.
 *
 * @param root - Absolute project root.
 * @param profile - The governing profile pack (records invalid against it are dropped).
 * @returns The store file's byte size before and after compaction.
 */
export async function compactRelations(root: string, profile: ProfilePack): Promise<CompactionResult> {
  return underLock(root, async () => {
    const { dir } = await resolveGraphDir(root); // throws on symlink escape
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, path.basename(RELATIONS_FILE));
    const before = await fileSize(file);
    const { relations } = await readRelations(root);
    const survivors = relations.filter((ref) => validateRelationAgainstProfile(ref, profile).length === 0);
    const tmp = file + ".compact.tmp";
    await writeFile(tmp, compactedBody(survivors), "utf8");
    await rename(tmp, file);
    return { before, after: await fileSize(file) };
  });
}
