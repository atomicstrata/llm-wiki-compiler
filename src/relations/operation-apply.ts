/**
 * @file src/relations/operation-apply.ts
 * @description THE ONE BODY of an operation-bound relation create, over a
 * {@link RelationOperationStore}: the single-file store (`./operation-write.ts`,
 * over its whole-record read) and the segmented log (`../history/relations-write.ts`,
 * over point indexes) each answer the same four questions and perform the
 * create; the decisions are made here once.
 *
 * Order: a record already bound to this mutation is idempotent when exact
 * (the child audit event is forward-repaired) and a conflict otherwise; an
 * exact live relation (dedup by content) is an UNBOUND idempotent skip; a
 * promised id already live with other content is a conflict; otherwise the
 * store prepares, the audit store is pre-flighted, the record is created and
 * the child event appended. Content identity stays distinct from operation
 * identity: an existing relation is never duplicated to attach a mutation id.
 */

import { appendOperationEventLockedFrom } from "../events/operation-events.js";
import type { EventBoundWriteSources } from "../events/store.js";
import { prepareEventStoreForAppendFrom } from "../events/store-read.js";
import type { EventRecord } from "../events/types.js";
import { operationBindingEquals, type OperationBinding } from "../utils/operation-binding.js";
import type { BoundRelationRecord } from "./record-check.js";
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

/** What one relation store answers for an operation-bound create, and how it creates. */
export interface RelationOperationStore {
  /** The records carrying `mutationId` (more than one is a conflict). */
  byMutation(mutationId: string): Promise<readonly BoundRelationRecord[]>;
  /** The latest live relation with this content, if any. */
  liveByContent(contentHash: string): Promise<RelationRef | undefined>;
  /** Whether a relation with this id is present. */
  hasId(id: RelationRef["id"]): Promise<boolean>;
  /** Store-specific preparation before the audit pre-flight (the file store's header upgrade). */
  prepareCreate(): Promise<void>;
  /** Write the bound record. */
  create(ref: RelationRef, binding: OperationBinding): Promise<void>;
}

/** Append the relation-create child audit event carrying the operation binding (idempotent per mutation). */
async function emitRelationOperationEvent(events: EventBoundWriteSources, ref: RelationRef, binding: OperationBinding): Promise<EventRecord> {
  const result = await appendOperationEventLockedFrom(events, {
    type: "relation-create", origin: "sdk",
    payload: { id: ref.id, relType: ref.type, from: ref.from, to: ref.to },
    at: new Date().toISOString(),
  }, binding);
  if (result.status === "conflict") throw new Error(`operation relation event conflict: ${result.detail}`);
  return result.event;
}

/** The idempotent outcome for a record already bound to this mutation, or a conflict when it is not exact. */
async function sameMutation(events: EventBoundWriteSources, bound: readonly BoundRelationRecord[], ref: RelationRef, binding: OperationBinding): Promise<RelationOperationApply> {
  if (bound.length > 1) return { status: "conflict", detail: "duplicate relation record for mutation" };
  const existing = bound[0]!;
  const exact = existing.operationBinding !== undefined && operationBindingEquals(existing.operationBinding, binding) && existing.ref.contentHash === ref.contentHash;
  if (!exact) return { status: "conflict", detail: "relation mutation content mismatch" };
  // Forward-repair a missing child audit event (a crash between the record and its event); the emit is idempotent.
  await emitRelationOperationEvent(events, existing.ref, binding);
  return { status: "skipped-idempotent", ref: existing.ref, bound: true };
}

/** Apply one relation mutation under the caller's lock (see the file overview for the order). */
export async function applyRelationOperation(
  store: RelationOperationStore, events: EventBoundWriteSources, ref: RelationRef, binding: OperationBinding, promisedId?: RelationRef["id"],
): Promise<RelationOperationApply> {
  const bound = await store.byMutation(binding.mutationId);
  if (bound.length > 0) return sameMutation(events, bound, ref, binding);
  const live = await store.liveByContent(ref.contentHash);
  if (live !== undefined) {
    // A pre-existing relation deduped by content: this run did not produce it, so the skip is unbound.
    await emitRelationOperationEvent(events, live, binding);
    return { status: "skipped-idempotent", ref: live, bound: false };
  }
  // A promised id already present with different content would be silently superseded: a conflict, never an append.
  if (promisedId !== undefined && (await store.hasId(promisedId))) return { status: "conflict", detail: "promised relation id is already live with different content" };
  await store.prepareCreate();
  await prepareEventStoreForAppendFrom(events); // fail closed on a tampered/symlinked audit store
  await store.create(ref, binding);
  return { status: "created", ref, event: await emitRelationOperationEvent(events, ref, binding) };
}
