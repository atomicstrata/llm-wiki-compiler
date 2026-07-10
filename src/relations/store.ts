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
 *
 * TRUST BOUNDARY: the per-record `contentHash` is an INTEGRITY checksum (it
 * detects an accidentally-corrupted or torn record, failing the read closed) — it
 * is NOT an AUTHENTICITY chain. Unlike the event store, this store carries no
 * hash-CHAIN linking each record to the prior, so it cannot detect a well-formed
 * record that was FORGED or a live record that was SILENTLY DELETED by something
 * writing the file directly. Every TOOLED write path is guarded (profile-lock
 * single-writer + graph-dir confinement), so no CLI/SDK/MCP caller can forge an
 * edge; the residual exposure is an actor with DIRECT filesystem write access to
 * `wiki/graph`, who could plant a relation that satisfies a gated lifecycle
 * precondition (G1) with no tamper-evidence. Deployments that must resist that
 * threat MUST protect the graph directory at the OS/filesystem layer (restrictive
 * ownership/permissions, or an immutable/append-only mount); a future authenticity
 * hash-chain over the relation store would close it in-band. This is a deliberate
 * v0 boundary, scoped and documented rather than silently assumed.
 */

import { open, mkdir, rename, stat } from "fs/promises";
import { randomBytes } from "node:crypto";
import path from "path";
import { RELATIONS_FILE, MAX_RELATION_RECORD_BYTES, MAX_RELATION_STORE_BYTES } from "../utils/constants.js";
import { acquireLockBlocking, releaseLock } from "../utils/lock.js";
import type { EntityId, ProfilePack, RelationTypeDef } from "../profile/types.js";
import type { CitationRef, RelationRef } from "./types.js";
import { RelationEndpointError, RelationStoreFullError } from "./types.js";
import { mintRelationId } from "./ulid.js";
import { canonicalEndpoints, relationContentHash } from "./digest.js";
import { headerLine, serializeRecord, resolveGraphDir, openStoreFileAppend } from "./store-record.js";
import { readRelations } from "./store-read.js";
import { validateRelationAttributes, validateRelationEndpoints, validateRelationEvidence, validateRelationAgainstProfile } from "./relation-contract.js";
import { validateArtifactRefsAgainstProfile } from "../profile/artifact-ref-validate.js";
import { appendEventLocked, preflightEventAppend, type AppendEventInput } from "../events/store.js";
import { prepareEventStoreForAppend } from "../events/store-read.js";
import type { EventType } from "../events/types.js";

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
 * {@link validateRelationAttributes}), PLUS the profile-aware artifactRef scope
 * check ({@link validateArtifactRefsAgainstProfile}). Any violation fails closed
 * BEFORE any write, so a relation whose attribute mismatches its declared type —
 * or carries an undeclared/out-of-scope artifact ref — is never appended.
 */
function assertAttributesValid(
  profile: ProfilePack,
  def: RelationTypeDef,
  attributes: Record<string, unknown>,
  type: string,
): void {
  const violations = [
    ...validateRelationAttributes(def, attributes),
    ...validateArtifactRefsAgainstProfile(profile, def.attributes ?? {}, attributes),
  ];
  if (violations.length > 0) {
    throw new RelationEndpointError(`relation '${type}' has invalid attributes: ${violations.join(" ")}`);
  }
}

/**
 * Assert a relation's `evidence` citations satisfy the {@link validateRelationEvidence}
 * contract — each a plain object carrying ONLY `sourcePath`/`sourceSpan`, with a
 * SAFE project-relative `sourcePath` and a string `sourceSpan` (within caps). Any
 * violation fails closed BEFORE any write, so the unvalidated, path-bearing
 * evidence side channel (which feeds the content hash) can never land on disk —
 * the SAME fail-closed boundary attributes/endpoints get, mirrored on the read
 * side by {@link validateRelationAgainstProfile}.
 */
function assertEvidenceValid(evidence: CitationRef[] | undefined, type: string): void {
  const violations = validateRelationEvidence(evidence);
  if (violations.length > 0) {
    throw new RelationEndpointError(`relation '${type}' has invalid evidence: ${violations.join(" ")}`);
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
 * validate the CANONICAL endpoints + required attributes + evidence citations
 * against the relation-type def, mint the id (or reuse `existingId` for an update), and
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
  assertAttributesValid(profile, def, attributes, input.type);
  assertEvidenceValid(input.evidence, input.type);
  const content = { type: input.type, from, to, attributes, evidence: input.evidence };
  const ref: RelationRef = { id: existingId ?? mintRelationId(), ...content, contentHash: relationContentHash(content) };
  assertRecordWithinCap(ref);
  return ref;
}

/**
 * Append one serialized record line to the store under O_APPEND, creating the
 * dir/header. The leaf is opened through the shared NO-FOLLOW
 * {@link openStoreFileAppend} (the LEAF defense complementing the
 * {@link resolveGraphDir} DIR defense): a symlinked `relations.jsonl` fails the
 * open closed, so the append NEVER lands outside root. FAILS CLOSED with
 * {@link RelationStoreFullError} (FIX #4) when the append would reach/exceed
 * {@link MAX_RELATION_STORE_BYTES} — the same bound the reader rejects at — so the
 * store can never be driven past the read cap into an unreadable-yet-appendable
 * state. {@link compactRelations} is the escape valve.
 */
async function appendLine(root: string, ref: RelationRef): Promise<void> {
  const { dir } = await resolveGraphDir(root); // throws on symlink escape (DIR defense)
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, path.basename(RELATIONS_FILE));
  const handle = await openStoreFileAppend(file); // throws on symlink leaf (LEAF defense)
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

/**
 * Build the relation audit event INPUT (no write). Separating the build from the
 * append lets the caller size+store-full PRE-FLIGHT the EXACT event it will later
 * append (the same object, same `at` timestamp), so the relation mutation can fail
 * CLOSED — with nothing committed — when the trailing audit append would exceed the
 * per-record cap or drive the event store past {@link MAX_EVENT_STORE_BYTES}.
 *
 * SIZE-SAFE (no caller-inflatable payload): the payload records ONLY bounded,
 * derived identifiers — the minted `rel_<ULID>` id, the declared `relType`, and
 * the two canonical `EntityId` endpoints. It does NOT serialize the caller's
 * `attributes`/`evidence` (those are size-capped on the relation RECORD via
 * {@link buildRelationRef}'s {@link MAX_RELATION_RECORD_BYTES} check, and never
 * reach this event). The remaining store-full window is the WHOLE-FILE event cap,
 * which the caller's {@link preflightEventAppend} now closes BEFORE the relation
 * record commits.
 */
function buildRelationEvent(type: EventType, ref: RelationRef, decision?: string): AppendEventInput {
  return {
    type,
    origin: "sdk",
    payload: { id: ref.id, relType: ref.type, from: ref.from, to: ref.to },
    decision,
    at: new Date().toISOString(),
  };
}

/**
 * Emit one relation audit event into the chained event store under the CALLER's
 * held lock (the lock-free {@link appendEventLocked}). Appends the SAME
 * {@link AppendEventInput} the caller already {@link preflightEventAppend}ed, so the
 * record that lands is byte-for-byte the one whose size+store-full was pre-checked.
 * Called only after a real {@link appendLine} (a dedup hit appends nothing and
 * emits nothing), so the event trails the durable mutation it records. With the
 * caller's size+health pre-flight (FIX F2 + store-full), this emit only fails on the
 * deferred cross-store-atomicity gap (healthy at pre-flight, fails mid-emit).
 */
async function emitRelationEvent(root: string, event: AppendEventInput): Promise<void> {
  await appendEventLocked(root, event);
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
 * MANDATORY AUDIT (FIX F2 + store-full): the audit event store is PRE-FLIGHTED
 * before the relation write — {@link prepareEventStoreForAppend} (under the held
 * lock) REPAIRS a torn trailing line (an uncommitted prior append) then requires the
 * store to be healthy (not symlinked / corrupt / too-new / tampered), AND
 * {@link preflightEventAppend} checks the EXACT `relation-create` event's SIZE +
 * whole-store fit ({@link MAX_EVENT_STORE_BYTES}) — all over the SAME event object
 * that will be appended. A tampered audit store, an over-cap event record, OR a
 * near-full event store therefore BLOCKS the mutation up front and fails the WHOLE
 * operation closed with the relation UNCHANGED; only the dedup short-circuit (which
 * appends nothing) skips it. The residual gap is a store healthy AND fitting at
 * pre-flight that fails mid-emit AFTER the append (the deferred
 * cross-store-atomicity item — true atomicity needs an intent journal). The event
 * emit is therefore no longer best-effort-after-mutation: a healthy, fitting event
 * store is a PRECONDITION.
 *
 * @param root - Absolute project root.
 * @param profile - The governing profile pack (its `relations` block is the schema).
 * @param input - The new relation's content.
 * @param decision - The trust decision the planner composed for this write, recorded
 *   on the audit event (B7). OPTIONAL: a direct/non-trust append omits it.
 * @returns The persisted relation reference.
 */
export async function appendRelationLocked(
  root: string,
  profile: ProfilePack,
  input: AppendRelationInput,
  decision?: string,
): Promise<RelationRef> {
  const ref = buildRelationRef(profile, input); // throws before any write
  await prepareEventStoreForAppend(root); // FIX F2 pre-flight (under the held lock): REPAIR a torn tail, else fail closed on a tampered/symlinked/corrupt audit store
  const { relations } = await readRelations(root); // under the caller's lock
  const duplicate = relations.find((rel) => rel.contentHash === ref.contentHash);
  if (duplicate) return duplicate; // idempotent create (FIX #6) — append nothing, emit nothing (no preflight: nothing will be appended)
  const event = buildRelationEvent("relation-create", ref, decision); // records the composed trust decision (B7)
  await preflightEventAppend(root, event); // size + store-full pre-flight BEFORE the relation commits: an over-cap/full event fails closed with relations.jsonl untouched
  await appendLine(root, ref);
  await emitRelationEvent(root, event); // the SAME pre-flighted event object
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
    await prepareEventStoreForAppend(root); // FIX F2 pre-flight (under the held lock): REPAIR a torn tail, else fail closed on a tampered/symlinked/corrupt audit store
    const event = buildRelationEvent("relation-update", ref);
    await preflightEventAppend(root, event); // size + store-full pre-flight BEFORE the superseding record commits: fails closed with relations.jsonl untouched
    await appendLine(root, ref);
    await emitRelationEvent(root, event); // the SAME pre-flighted event object, after the append
    return ref;
  });
}

/**
 * The maximum number of dropped relation ids carried as a SAMPLE in the
 * `relation-compact` event payload. A large compaction can drop thousands of
 * records; embedding every id could push the event record past
 * {@link MAX_EVENT_RECORD_BYTES} and throw {@link EventStoreFullError} AFTER the
 * relation store was rewritten. The full `droppedCount` is always recorded; only
 * the id list is sampled so the payload stays well under the record cap.
 */
const MAX_COMPACTION_SAMPLE_IDS = 50;

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
 * Build the `relation-compact` audit event INPUT (no write) recording the rewrite
 * (A5): the live-record counts before/after, the full `droppedCount`, and a BOUNDED
 * `droppedIdsSample` (at most {@link MAX_COMPACTION_SAMPLE_IDS} ids), so the very
 * audit log the relation store protects no longer has a silent gap where compaction
 * discards superseded/invalid records — yet a large compaction can never push the
 * event RECORD past {@link MAX_EVENT_RECORD_BYTES} by embedding every dropped id.
 * Building the input separately lets {@link compactRelations} size+store-full
 * PRE-FLIGHT this EXACT event BEFORE rewriting the relation store, so an event that
 * would not fit fails the compaction CLOSED with `relations.jsonl` byte-identical.
 */
function buildCompactionEvent(before: RelationRef[], survivors: RelationRef[]): AppendEventInput {
  const survivingIds = new Set(survivors.map((ref) => ref.id));
  const droppedIds = before.filter((ref) => !survivingIds.has(ref.id)).map((ref) => ref.id);
  return {
    type: "relation-compact",
    origin: "sdk",
    payload: {
      countBefore: before.length,
      countAfter: survivors.length,
      droppedCount: droppedIds.length,
      droppedIdsSample: droppedIds.slice(0, MAX_COMPACTION_SAMPLE_IDS),
    },
    at: new Date().toISOString(),
  };
}

/**
 * Write `body` to a RANDOM-named temp file inside the CONFINED graph dir, then
 * atomic-rename it over `file`. The temp is opened with `"wx"` (O_CREAT|O_EXCL),
 * so a pre-planted entry at that path — INCLUDING a symlink-to-FILE — makes the
 * open throw `EEXIST` and compaction FAILS CLOSED, never following the link to
 * overwrite an out-of-tree file. The random suffix means the temp path cannot be
 * predicted and pre-targeted. The write goes through the file HANDLE (never a
 * path), and the handle is always closed in `finally`.
 *
 * @param dir - The already-confined graph directory (from {@link resolveGraphDir}).
 * @param file - The destination store file inside `dir`.
 * @param body - The compacted store body to persist.
 */
async function writeCompactedAtomically(dir: string, file: string, body: string): Promise<void> {
  const tmp = path.join(dir, `${path.basename(RELATIONS_FILE)}.compact.${randomBytes(8).toString("hex")}.tmp`);
  const handle = await open(tmp, "wx"); // O_EXCL: refuses any pre-existing entry, incl. a symlink
  try {
    await handle.writeFile(body, "utf8");
  } finally {
    await handle.close();
  }
  await rename(tmp, file);
}

/**
 * Compact the relation store IN PLACE (FIX #4): under the lock, read the
 * latest-per-id records that are still VALID against `profile`, rewrite just the
 * header + those records to a RANDOM-named, O_EXCL-created temp file in the
 * confined graph dir (see {@link writeCompactedAtomically} — a pre-planted
 * symlink at the temp path fails the open closed, never followed outside root),
 * and atomic-rename it over `relations.jsonl`. Superseded/duplicate/now-invalid
 * records are dropped, so the store SHRINKS — the escape valve that recovers a
 * store driven up to {@link RelationStoreFullError}. The latest-per-id collapse
 * is the reader's, so no live relation is lost.
 *
 * MANDATORY AUDIT (FIX F2, mirroring {@link appendRelationLocked}): the audit
 * event store is PRE-FLIGHTED for both HEALTH ({@link prepareEventStoreForAppend})
 * AND the `relation-compact` event's SIZE + whole-store fit
 * ({@link preflightEventAppend} over the EXACT event built by
 * {@link buildCompactionEvent}), under the held lock, BEFORE
 * {@link writeCompactedAtomically} mutates the relation store. A tampered /
 * too-new / symlinked audit store, an over-cap event record, OR a near-full event
 * store therefore BLOCKS the compaction up front (throws) and leaves
 * `relations.jsonl` BYTE-IDENTICAL — a healthy, fitting audit log is a
 * PRECONDITION, not a best-effort after-mutation emit.
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
    await prepareEventStoreForAppend(root); // FIX F2 pre-flight BEFORE mutating: a tampered audit store blocks compaction, store left byte-identical
    const event = buildCompactionEvent(relations, survivors);
    await preflightEventAppend(root, event); // size + store-full pre-flight BEFORE the rewrite: a too-large/full event leaves relations.jsonl byte-identical
    await writeCompactedAtomically(dir, file, compactedBody(survivors));
    await emitRelationEvent(root, event); // the SAME pre-flighted event object — audit the rewrite (A5), under the held lock
    return { before, after: await fileSize(file) };
  });
}
