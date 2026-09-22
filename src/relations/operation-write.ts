/**
 * @file src/relations/operation-write.ts
 * @description The operation-aware relation append seam. It reuses the ordinary
 * canonicalization, profile validation, and store-full-guarded append, but
 * stamps the out-of-band {@link OperationBinding} onto the authority record and
 * emits the operation child audit event carrying the same binding. Content
 * identity stays distinct from operation identity: an exact pre-existing relation
 * is a valid post-state and is never duplicated solely to attach a mutation id.
 */

import { operationBindingEquals, type OperationBinding } from "../utils/operation-binding.js";
import { appendOperationEventLocked } from "../events/operation-events.js";
import { prepareEventStoreForAppend } from "../events/store-read.js";
import type { EventRecord } from "../events/types.js";
import type { ProfilePack } from "../profile/types.js";
import { appendLine, buildRelationRef, type AppendRelationInput } from "./store.js";
import { readRelationRecords, type BoundRelationRecord } from "./store-read.js";
import { ensureRelationOperationVersionLocked } from "./store-version.js";
import type { RelationRef } from "./types.js";

/**
 * The outcome of applying one relation mutation through the operation seam. A
 * `skipped-idempotent` result reports `bound`: true when the present relation was
 * produced by THIS mutation (an exact same-mutation record), false when it is a
 * pre-existing relation deduped by content (this run did not create it).
 */
export type RelationOperationApply =
  | { status: "created"; ref: RelationRef; event: EventRecord }
  | { status: "skipped-idempotent"; ref: RelationRef; bound: boolean }
  | { status: "conflict"; detail: string };

type MutationLookup =
  | { status: "none" }
  | { status: "same-mutation"; ref: RelationRef }
  | { status: "conflict"; detail: string };

/** Classify the store's records against the target mutation identity. */
function lookupByMutation(
  records: readonly BoundRelationRecord[],
  binding: OperationBinding,
  contentHash: string,
): MutationLookup {
  const matches = records.filter((record) => record.operationBinding?.mutationId === binding.mutationId);
  if (matches.length > 1) return { status: "conflict", detail: "duplicate relation record for mutation" };
  if (matches.length === 0) return { status: "none" };
  const existing = matches[0]!;
  const exact = existing.operationBinding !== undefined
    && operationBindingEquals(existing.operationBinding, binding)
    && existing.ref.contentHash === contentHash;
  return exact
    ? { status: "same-mutation", ref: existing.ref }
    : { status: "conflict", detail: "relation mutation content mismatch" };
}

/** The latest live relation matching this content, if any (dedup by content). */
function liveContentMatch(records: readonly BoundRelationRecord[], contentHash: string): RelationRef | undefined {
  const byId = new Map<string, BoundRelationRecord>();
  for (const record of records) byId.set(record.ref.id, record);
  for (const record of byId.values()) {
    if (record.ref.contentHash === contentHash) return record.ref;
  }
  return undefined;
}

/** Append the relation-create child audit event carrying the operation binding. */
async function emitRelationOperationEvent(
  root: string,
  ref: RelationRef,
  binding: OperationBinding,
): Promise<EventRecord> {
  const result = await appendOperationEventLocked(root, {
    type: "relation-create", origin: "sdk",
    payload: { id: ref.id, relType: ref.type, from: ref.from, to: ref.to },
    at: new Date().toISOString(),
  }, binding);
  if (result.status === "conflict") throw new Error(`operation relation event conflict: ${result.detail}`);
  return result.event;
}

/**
 * Apply one relation mutation under the caller's lock, stamping the binding on a
 * newly created record and recording the child audit event. A record already
 * carrying this mutation id (exact) is idempotent; a divergent one parks; an
 * exact pre-existing relation is applied without a duplicate record.
 *
 * `promisedId` is the manifest's attested `postcondition.recordId`: when the
 * mutation creates a NEW record, the store writes exactly that id, so the
 * manifest's promise is a fact rather than an unverified attestation. Absent
 * (every non-operation caller), the store mints as it always has.
 */
export async function appendRelationForOperationLocked(
  root: string,
  profile: ProfilePack,
  input: AppendRelationInput,
  binding: OperationBinding,
  promisedId?: RelationRef["id"],
): Promise<RelationOperationApply> {
  const ref = buildRelationRef(profile, input, promisedId); // canonical + profile-validated content
  const { records, problems } = await readRelationRecords(root);
  if (problems.length > 0) return { status: "conflict", detail: "relation store has an uncommitted tail" };
  const lookup = lookupByMutation(records, binding, ref.contentHash);
  if (lookup.status === "conflict") return lookup;
  if (lookup.status === "same-mutation") {
    // The authority record for this mutation is already present; forward-repair a
    // missing child audit event (a crash between the record and its event). The
    // emit is idempotent — it appends nothing when the bound event already exists.
    // The record is bound to this mutation, so a crash recovery records applied.
    await emitRelationOperationEvent(root, lookup.ref, binding);
    return { status: "skipped-idempotent", ref: lookup.ref, bound: true };
  }
  const live = liveContentMatch(records, ref.contentHash);
  if (live !== undefined) {
    // A pre-existing relation deduped by content: this run did not produce it, so
    // the skip is unbound (it must never enter the compensation applied-set).
    await emitRelationOperationEvent(root, live, binding);
    return { status: "skipped-idempotent", ref: live, bound: false };
  }
  if (promisedId !== undefined && records.some((record) => record.ref.id === promisedId)) {
    // The promised id is already LIVE with different content (same content
    // dedupes above). Appending under it would silently supersede the live
    // relation — the reader keeps the newest record per id — so an id collision
    // is a conflict, never an append.
    return { status: "conflict", detail: "promised relation id is already live with different content" };
  }
  await ensureRelationOperationVersionLocked(root);
  await prepareEventStoreForAppend(root); // fail closed on a tampered/symlinked audit store
  await appendLine(root, ref, binding);
  return { status: "created", ref, event: await emitRelationOperationEvent(root, ref, binding) };
}
