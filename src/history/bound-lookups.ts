/**
 * @file src/history/bound-lookups.ts
 * @description The narrow lookups the operation-bundle adapters make when a
 * project is `local-indexed`: the events bound to one mutation, and the
 * relation records bound to it plus the live record for one content hash.
 * Each answers `null` on any other project, where the adapter keeps its
 * incumbent whole-history read.
 */

import type { EventRecord } from "../events/types.js";
import { indexedActive } from "../indexed/routing.js";
import type { BoundRelationRecord } from "../relations/store-read.js";
import { findEventsByMutation } from "./events-read.js";
import { liveRelationByContent, openRelationLog, readyRelationLogMeta, relationsByMutation } from "./relations-log.js";

/** The events bound to `mutationId` from the binding index, or `null` when the project is not indexed. */
export async function indexedBoundEvents(root: string, mutationId: string): Promise<EventRecord[] | null> {
  return (await indexedActive(root)) ? findEventsByMutation(root, mutationId) : null;
}

/** The relation state one operation mutation needs, through point lookups. */
export interface IndexedRelationState {
  readonly bound: readonly BoundRelationRecord[];
  readonly boundEvents: number;
  live(contentHash: string): Promise<BoundRelationRecord | undefined>;
}

/** The relation state of `mutationId`, or `null` when the project is not indexed. */
export async function indexedRelationState(root: string, mutationId: string): Promise<IndexedRelationState | null> {
  if (!(await indexedActive(root))) return null;
  const store = await openRelationLog(root);
  readyRelationLogMeta(store);
  const bound = await relationsByMutation(store, mutationId);
  const boundEvents = (await findEventsByMutation(root, mutationId)).length;
  return { bound, boundEvents, live: (contentHash) => liveRelationByContent(store, contentHash) };
}
