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
 *
 * ONE BODY for the create: {@link appendRelationLocked} runs
 * {@link appendRelationLockedFrom} over local-disk {@link RelationAppendSources}
 * — this store's graph (its confined read and its handle-held append) and the
 * audit store's write sources. Validation, the audit pre-flight and repair, the
 * dedup, the event, the record bytes, the cap and the order record-then-event
 * are decided here; the sources only answer. The disk append reaches this
 * store's own `resolveGraphDir` and `openStoreFileAppend` (`./store-record.ts`)
 * at call time. The exported root {@link appendLine} (the operation-bound
 * writer's) runs the same record chunks. The cross-store residual below is
 * unchanged: the record and its event are NOT co-committed.
 *
 * ONE BODY for the update and the compaction too: {@link updateRelation} runs
 * {@link updateRelationLockedFrom} over the SAME local-disk
 * {@link RelationAppendSources}, and {@link compactRelations} runs
 * {@link compactRelationsLockedFrom} over {@link RelationCompactionSources},
 * whose disk rewrite keeps the confined graph dir, the mkdir, the sizing and the
 * random `wx` temp then rename. Both keep their lock, their read-before-mkdir
 * order, the bound-history refusal and the event pre-flight and order.
 */

import { open, mkdir, rename, stat } from "fs/promises";
import { randomBytes } from "node:crypto";
import path from "path";
import { RELATIONS_FILE, MAX_RELATION_STORE_BYTES } from "../utils/constants.js";
import type { OperationBinding } from "../utils/operation-binding.js";
import { withOrdinaryMutationLock as underLock } from "../operation-bundles/with-mutation-lock.js";
import type { ProfilePack } from "../profile/types.js";
import type { RelationRef } from "./types.js";
import { RelationEndpointError, RelationStoreFullError } from "./types.js";
import { headerLine, serializeRecord, resolveGraphDir, openStoreFileAppend } from "./store-record.js";
import { buildRelationEvent, buildRelationRef, updatedRelationInput, type AppendRelationInput, type UpdateRelationPatch } from "./relation-build.js";
import { diskRelationGraphReads, type RelationGraphReads } from "./graph-reads.js";
import { readRelationRecordsFrom, readRelationsFrom } from "./store-read.js";
import { validateRelationAgainstProfile } from "./relation-contract.js";
import {
  appendEventLockedFrom, diskEventWriteSources, preflightEventAppendFrom, type AppendEventInput, type EventWriteSources,
} from "../events/store.js";
import { prepareEventStoreForAppendFrom } from "../events/store-read.js";
import { appendToGraphLeaf, type GraphStoreAppend } from "../utils/jsonl-store.js";

export { buildRelationRef, type AppendRelationInput, type UpdateRelationPatch } from "./relation-build.js";

/** The relation store's graph: its confined read and its handle-held append. */
export interface RelationGraphStore extends RelationGraphReads, GraphStoreAppend {}

/**
 * Everything {@link appendRelationLockedFrom} reads and writes: this store's
 * graph and the audit (event) store's write sources. Owned by the relation
 * store; not `ProjectStore`, not hosted, and it selects no backend.
 */
export interface RelationAppendSources {
  /** The relation store's read and append. */
  graph: RelationGraphStore;
  /** The audit store's read, repair, append, size and seal. */
  events: EventWriteSources;
}

/**
 * LOCAL DISK. The relation store's graph for the project at `root`: the shared
 * confined read, and the append through this store's own `resolveGraphDir` and
 * `openStoreFileAppend`, reached at call time. Building it does no I/O. In no
 * package index.
 */
export function diskRelationGraphStore(root: string): RelationGraphStore {
  return {
    ...diskRelationGraphReads(root),
    appendStore: (plan) => appendToGraphLeaf({
      resolveDir: () => resolveGraphDir(root), // throws on symlink escape (DIR defense)
      openAppend: (file) => openStoreFileAppend(file), // throws on symlink leaf (LEAF defense)
      fileName: path.basename(RELATIONS_FILE),
    }, plan),
  };
}

/** LOCAL DISK. The create's sources for the project at `root`: this store's graph and the event store's write sources. In no package index. */
export function diskRelationAppendSources(root: string): RelationAppendSources {
  return { graph: diskRelationGraphStore(root), events: diskEventWriteSources(root) };
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
export async function appendLine(root: string, ref: RelationRef, binding?: OperationBinding): Promise<void> {
  await appendRelationLineFrom(diskRelationGraphStore(root), ref, binding);
}

/** {@link appendLine} over this store's {@link GraphStoreAppend}: THE ONE BODY of the record append. */
export function appendRelationLineFrom(graph: GraphStoreAppend, ref: RelationRef, binding?: OperationBinding): Promise<void> {
  return graph.appendStore((existing) => relationChunks(existing, ref, binding));
}

/**
 * The chunks one record append writes, for a store leaf of `existing` bytes,
 * exactly as the record append always computed them. Lazy and pulled one chunk
 * at a time: the header choice, the FIRST serialization and the cap run on the
 * first pull (after the open, before any write, so a refused append still
 * leaves a created empty leaf); the record is serialized a SECOND time only
 * when its chunk is pulled — after the header's write was awaited when there is
 * a header — so the serialization count and timing are the incumbent's.
 */
function* relationChunks(existing: number, ref: RelationRef, binding?: OperationBinding): Generator<string> {
  const header = existing === 0 ? headerLine() : "";
  const addition = Buffer.byteLength(header + serializeRecord(ref, binding), "utf8");
  if (existing + addition >= MAX_RELATION_STORE_BYTES) {
    throw new RelationStoreFullError();
  }
  if (header) yield header;
  yield serializeRecord(ref, binding);
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
 * before the relation write — {@link prepareEventStoreForAppendFrom} (under the held
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
  return appendRelationLockedFrom(diskRelationAppendSources(root), profile, input, decision);
}

/**
 * {@link appendRelationLocked} over {@link RelationAppendSources}: THE ONE BODY.
 * Build and validate; the audit pre-flight and repair; the live read and dedup;
 * the event; its size pre-flight; the record append; then the SAME event's
 * append and seal. The caller MUST already hold the project lock. A store
 * healthy at pre-flight that fails mid-emit still leaves the record without its
 * event (the cross-store residual; not co-committed).
 *
 * @param sources - This store's graph and the audit store's write sources.
 * @param profile - The governing profile pack (its `relations` block is the schema).
 * @param input - The new relation's content.
 * @param decision - The composed trust decision recorded on the audit event, when any.
 * @returns The persisted relation reference, or the live duplicate.
 */
export async function appendRelationLockedFrom(
  sources: RelationAppendSources,
  profile: ProfilePack,
  input: AppendRelationInput,
  decision?: string,
): Promise<RelationRef> {
  const segmented = await sources.graph.segmentedRelations?.();
  if (segmented) return segmented.append(sources.events, profile, input, decision); // local-indexed: point lookups
  const ref = buildRelationRef(profile, input); // throws before any write
  await prepareEventStoreForAppendFrom(sources.events); // FIX F2 pre-flight (under the held lock): REPAIR a torn tail, else fail closed on a tampered/symlinked/corrupt audit store
  const { relations } = await readRelationsFrom(sources.graph); // under the caller's lock
  const duplicate = relations.find((rel) => rel.contentHash === ref.contentHash);
  if (duplicate) return duplicate; // idempotent create (FIX #6) — append nothing, emit nothing (no preflight: nothing will be appended)
  const event = buildRelationEvent("relation-create", ref, decision); // records the composed trust decision (B7)
  await preflightEventAppendFrom(sources.events, event); // size + store-full pre-flight BEFORE the relation commits: an over-cap/full event fails closed with relations.jsonl untouched
  await appendRelationLineFrom(sources.graph, ref);
  await appendEventLockedFrom(sources.events, event); // the SAME pre-flighted event object
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
  return underLock(root, () => updateRelationLockedFrom(diskRelationAppendSources(root), profile, id, patch));
}

/**
 * {@link updateRelation} over {@link RelationAppendSources}: THE ONE BODY. The caller
 * holds the project lock. Re-read the base, build, the audit pre-flight and
 * repair, the event and its size pre-flight, the superseding record append, then
 * the SAME event's append (the event trails the durable record it audits).
 */
export async function updateRelationLockedFrom(
  sources: RelationAppendSources,
  profile: ProfilePack,
  id: RelationRef["id"],
  patch: UpdateRelationPatch,
): Promise<RelationRef> {
  const segmented = await sources.graph.segmentedRelations?.();
  if (segmented) return segmented.update(sources.events, profile, id, patch); // local-indexed: point lookups
  const { relations } = await readRelationsFrom(sources.graph); // re-read INSIDE the lock
  const existing = relations.find((rel) => rel.id === id);
  if (!existing) {
    throw new RelationEndpointError(`no relation with id '${id}' to update`);
  }
  const ref = buildRelationRef(profile, updatedRelationInput(existing, patch), id);
  await prepareEventStoreForAppendFrom(sources.events); // FIX F2 pre-flight (under the held lock): REPAIR a torn tail, else fail closed on a tampered/symlinked/corrupt audit store
  const event = buildRelationEvent("relation-update", ref);
  await preflightEventAppendFrom(sources.events, event); // size + store-full pre-flight BEFORE the superseding record commits: fails closed with relations.jsonl untouched
  await appendRelationLineFrom(sources.graph, ref);
  await appendEventLockedFrom(sources.events, event); // the SAME pre-flighted event object, after the append
  return ref;
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

/** One prepared in-place rewrite of the relation store leaf. */
export interface RelationStoreRewrite {
  /** The store leaf's size when the rewrite was prepared (absent = 0). */
  readonly sizeBefore: number;
  /** Replace the store leaf with `body` atomically; rejects on a planted temp entry. */
  replace(body: string): Promise<void>;
  /** The store leaf's size now (absent = 0). */
  size(): Promise<number>;
}

/** The relation store as the compaction reads and rewrites it. */
export interface RelationCompactionGraph extends RelationGraphReads {
  /** Confine and create the graph dir and size the store leaf; rejects on a symlink escape. */
  prepareRewrite(): Promise<RelationStoreRewrite>;
}

/** Everything {@link compactRelationsLockedFrom} reads and writes: this store and the audit store. */
export interface RelationCompactionSources {
  graph: RelationCompactionGraph;
  events: EventWriteSources;
}

/** LOCAL DISK. The compaction's sources for the project at `root`, built per call; no I/O until asked. In no package index. */
export function diskRelationCompactionSources(root: string): RelationCompactionSources {
  return {
    graph: { ...diskRelationGraphReads(root), prepareRewrite: () => prepareDiskRewrite(root) },
    events: diskEventWriteSources(root),
  };
}

/** The incumbent physical half: the confined graph dir (throws on symlink escape), its mkdir, then the leaf size. */
async function prepareDiskRewrite(root: string): Promise<RelationStoreRewrite> {
  const { dir } = await resolveGraphDir(root); // throws on symlink escape
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, path.basename(RELATIONS_FILE));
  return {
    sizeBefore: await fileSize(file),
    replace: (body) => writeCompactedAtomically(dir, file, body),
    size: () => fileSize(file),
  };
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
 * event store is PRE-FLIGHTED for both HEALTH ({@link prepareEventStoreForAppendFrom})
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
  return underLock(root, () => compactRelationsLockedFrom(diskRelationCompactionSources(root), profile));
}

/**
 * {@link compactRelations} over {@link RelationCompactionSources}: THE ONE BODY. The
 * caller holds the project lock. The bound-history refusal reads BEFORE any
 * directory is created; then the rewrite is prepared, the live set filtered, the
 * audit pre-flighted, the store replaced, and the SAME event appended.
 */
export async function compactRelationsLockedFrom(
  sources: RelationCompactionSources, profile: ProfilePack,
): Promise<CompactionResult> {
  if (await sources.graph.segmentedRelations?.()) {
    throw new Error("relation compaction is unavailable on a local-indexed project: the segmented log has no single-file cap, and its authoritative history is never rewritten");
  }
  // Bound history is recovery authority, including superseded records. The
  // legacy latest-per-id compactor cannot safely discard or unbind it.
  const { records } = await readRelationRecordsFrom(sources.graph);
  if (records.some((record) => record.operationBinding !== undefined)) {
    throw new Error("relation compaction is unavailable for operation-bound history; retained authority was not changed");
  }
  const rewrite = await sources.graph.prepareRewrite();
  const { relations } = await readRelationsFrom(sources.graph);
  const survivors = relations.filter((ref) => validateRelationAgainstProfile(ref, profile).length === 0);
  await prepareEventStoreForAppendFrom(sources.events); // FIX F2 pre-flight BEFORE mutating: a tampered audit store blocks compaction, store left byte-identical
  const event = buildCompactionEvent(relations, survivors);
  await preflightEventAppendFrom(sources.events, event); // size + store-full pre-flight BEFORE the rewrite: a too-large/full event leaves relations.jsonl byte-identical
  await rewrite.replace(compactedBody(survivors));
  await appendEventLockedFrom(sources.events, event); // the SAME pre-flighted event object — audit the rewrite (A5), under the held lock
  return { before: rewrite.sizeBefore, after: await rewrite.size() };
}
