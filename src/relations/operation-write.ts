/**
 * @file src/relations/operation-write.ts
 * @description The operation-aware relation append seam. It reuses the ordinary
 * canonicalization, profile validation, and store-full-guarded append, but
 * stamps the out-of-band {@link OperationBinding} onto the authority record and
 * emits the operation child audit event carrying the same binding. Content
 * identity stays distinct from operation identity: an exact pre-existing relation
 * is a valid post-state and is never duplicated solely to attach a mutation id.
 *
 * ONE BODY: {@link appendRelationForOperationLocked} runs
 * {@link appendRelationForOperationLockedFrom} over local-disk
 * {@link RelationOperationSources} — this store's graph (read and append), its
 * DURABLE whole-store replacement for the header upgrade, and the audit store's
 * bound-append sources (which carry their own durable replacement). The lookup,
 * the dedup, the promised-id refusal, the order upgrade-then-precondition-then-
 * record-then-event, and every conflict detail stay here; the sources only
 * answer. No lock is taken: the caller holds it.
 */

import type { OperationBinding } from "../utils/operation-binding.js";
import { diskEventBoundWriteSources, type EventBoundWriteSources } from "../events/store.js";
import type { ProfilePack } from "../profile/types.js";
import { applyRelationOperation, type RelationOperationApply, type RelationOperationStore } from "./operation-apply.js";
import { buildRelationRef, type AppendRelationInput } from "./relation-build.js";
import { appendRelationLineFrom, diskRelationGraphStore, type RelationGraphStore } from "./store.js";
import { readRelationRecordsFrom, type BoundRelationRecord } from "./store-read.js";

export type { RelationOperationApply } from "./operation-apply.js";
import { diskRelationUpgradeSources, ensureRelationOperationVersionLockedFrom, type RelationUpgradeSources } from "./store-version.js";
import type { RelationRef } from "./types.js";

/**
 * Everything {@link appendRelationForOperationLockedFrom} reads and writes: this
 * store's graph and its durable replacement (the upgrade's), and the audit
 * store's bound-append sources. Owned by the relation store; not `ProjectStore`,
 * not hosted, and it selects no backend.
 */
export interface RelationOperationSources extends RelationUpgradeSources {
  /** The relation store's read and append. */
  graph: RelationGraphStore;
  /** The audit store's read, repair, append, seal and durable replacement. */
  events: EventBoundWriteSources;
}

/**
 * LOCAL DISK. The sources for the project at `root`: this store's graph
 * (`./store.ts`), its durable replacement (`./store-version.ts`, through
 * `../utils/atomic-write.js`) and the event store's bound-append sources.
 * Building them does no I/O. In no package index.
 */
function diskRelationOperationSources(root: string): RelationOperationSources {
  return {
    graph: diskRelationGraphStore(root),
    replaceStoreDurable: diskRelationUpgradeSources(root).replaceStoreDurable,
    events: diskEventBoundWriteSources(root),
  };
}

/** The single-file store's answers, over one whole-record read made inside the caller's lock. */
function fileOperationStore(sources: RelationOperationSources, records: readonly BoundRelationRecord[]): RelationOperationStore {
  return {
    byMutation: async (mutationId) => records.filter((record) => record.operationBinding?.mutationId === mutationId),
    liveByContent: async (contentHash) => liveContentMatch(records, contentHash),
    hasId: async (id) => records.some((record) => record.ref.id === id),
    prepareCreate: () => ensureRelationOperationVersionLockedFrom(sources),
    create: (ref, binding) => appendRelationLineFrom(sources.graph, ref, binding),
  };
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
  return appendRelationForOperationLockedFrom(diskRelationOperationSources(root), profile, input, binding, promisedId);
}

/**
 * {@link appendRelationForOperationLocked} over {@link RelationOperationSources}:
 * THE ONE BODY, in the incumbent order. Only the create path upgrades this
 * store's header, and it does so BEFORE the audit store's precondition.
 */
export async function appendRelationForOperationLockedFrom(
  sources: RelationOperationSources,
  profile: ProfilePack,
  input: AppendRelationInput,
  binding: OperationBinding,
  promisedId?: RelationRef["id"],
): Promise<RelationOperationApply> {
  const segmented = await sources.graph.segmentedRelations?.();
  if (segmented) return segmented.appendForOperation(sources.events, profile, input, binding, promisedId); // local-indexed
  const ref = buildRelationRef(profile, input, promisedId); // canonical + profile-validated content
  const { records, problems } = await readRelationRecordsFrom(sources.graph);
  if (problems.length > 0) return { status: "conflict", detail: "relation store has an uncommitted tail" };
  return applyRelationOperation(fileOperationStore(sources, records), sources.events, ref, binding, promisedId);
}
