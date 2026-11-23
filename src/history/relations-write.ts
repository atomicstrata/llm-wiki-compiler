/**
 * @file src/history/relations-write.ts
 * @description The incumbent relation write bodies' `local-indexed`
 * counterparts, in the SAME order and with the same refusals: build and
 * validate the ref, pre-flight the audit (event) store, look up the
 * duplicate or the existing id through the point indexes (never a whole
 * read), pre-flight the event, commit the record, then append the event.
 * The record and its event are still two commits, as before.
 */

import { appendEventLockedFrom, preflightEventAppendFrom, type EventBoundWriteSources, type EventWriteSources } from "../events/store.js";
import { prepareEventStoreForAppendFrom } from "../events/store-read.js";
import type { ProfilePack } from "../profile/types.js";
import { applyRelationOperation, type RelationOperationApply, type RelationOperationStore } from "../relations/operation-apply.js";
import { buildRelationEvent, buildRelationRef, updatedRelationInput, type AppendRelationInput, type UpdateRelationPatch } from "../relations/relation-build.js";
import { RelationEndpointError, type RelationRef } from "../relations/types.js";
import type { OperationBinding } from "../utils/operation-binding.js";
import { commitRelation, latestRelationById, liveRelationByContent, relationLogForWrite, relationsByMutation } from "./relations-log.js";

/** Create a relation (deduped by live content) under the caller's lock. */
export async function appendSegmentedRelation(root: string, events: EventWriteSources, profile: ProfilePack, input: AppendRelationInput, decision?: string): Promise<RelationRef> {
  const ref = buildRelationRef(profile, input);
  await prepareEventStoreForAppendFrom(events);
  const { store, meta } = await relationLogForWrite(root);
  const duplicate = await liveRelationByContent(store, ref.contentHash);
  if (duplicate !== undefined) return duplicate.ref;
  const event = buildRelationEvent("relation-create", ref, decision);
  await preflightEventAppendFrom(events, event);
  await commitRelation(store, meta, ref);
  await appendEventLockedFrom(events, event);
  return ref;
}

/** Supersede a relation's attributes/evidence under its id, under the caller's lock. */
export async function updateSegmentedRelation(root: string, events: EventWriteSources, profile: ProfilePack, id: RelationRef["id"], patch: UpdateRelationPatch): Promise<RelationRef> {
  const { store, meta } = await relationLogForWrite(root);
  const existing = (await latestRelationById(store, id))?.ref;
  if (existing === undefined) throw new RelationEndpointError(`no relation with id '${id}' to update`);
  const ref = buildRelationRef(profile, updatedRelationInput(existing, patch), id);
  await prepareEventStoreForAppendFrom(events);
  const event = buildRelationEvent("relation-update", ref);
  await preflightEventAppendFrom(events, event);
  await commitRelation(store, meta, ref, undefined, existing);
  await appendEventLockedFrom(events, event);
  return ref;
}

/** The segmented log's answers to an operation-bound create, over its point indexes. */
function segmentedOperationStore(log: Awaited<ReturnType<typeof relationLogForWrite>>): RelationOperationStore {
  return {
    byMutation: (mutationId) => relationsByMutation(log.store, mutationId),
    liveByContent: async (contentHash) => (await liveRelationByContent(log.store, contentHash))?.ref,
    hasId: async (id) => (await latestRelationById(log.store, id)) !== undefined,
    prepareCreate: async () => {},
    create: async (ref, binding) => { await commitRelation(log.store, log.meta, ref, binding); },
  };
}

/** The operation-bundle relation create: the incumbent body (`../relations/operation-apply.ts`) over point lookups. */
export async function appendSegmentedRelationForOperation(
  root: string, events: EventBoundWriteSources, profile: ProfilePack, input: AppendRelationInput, binding: OperationBinding, promisedId?: RelationRef["id"],
): Promise<RelationOperationApply> {
  const ref = buildRelationRef(profile, input, promisedId);
  return applyRelationOperation(segmentedOperationStore(await relationLogForWrite(root)), events, ref, binding, promisedId);
}
