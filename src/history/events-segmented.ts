/**
 * @file src/history/events-segmented.ts
 * @description What the incumbent event bodies ask of the segmented event log
 * when the project is `local-indexed`, and its local-disk binding. The event
 * reader loads this on demand; it is the only module joining the append path
 * (`./events-log.ts`) and the read path (`./events-read.ts`), so neither
 * imports the other.
 */

import type { AppendEventInput } from "../events/event-build.js";
import type { EventRecord } from "../events/types.js";
import { indexedActive } from "../indexed/routing.js";
import type { OperationBinding } from "../utils/operation-binding.js";
import { appendSegmentedEvent, preflightSegmentedEvent, verifyEventLogForAppend } from "./events-log.js";
import { findEventsByMutation, readAllEvents } from "./events-read.js";

/** What the incumbent event bodies ask of the segmented log when the project is `local-indexed`. */
export interface SegmentedEventLog {
  append(input: AppendEventInput, binding?: OperationBinding): Promise<EventRecord>;
  preflight(input: AppendEventInput): Promise<void>;
  verifyForAppend(): Promise<void>;
  readAll(): Promise<{ events: EventRecord[]; problems: string[] }>;
  /** The events bound to one operation mutation, from the binding index (at most two: enough to detect a duplicate). */
  findByMutation(mutationId: string): Promise<EventRecord[]>;
}

/** The segmented log of `root` when it is the active authority, else `null` (the incumbent file stays authoritative). */
export async function segmentedEventLogFor(root: string): Promise<SegmentedEventLog | null> {
  if (!(await indexedActive(root))) return null;
  return {
    append: (input, binding) => appendSegmentedEvent(root, input, binding),
    preflight: (input) => preflightSegmentedEvent(root, input),
    verifyForAppend: async () => { await verifyEventLogForAppend(root); },
    readAll: () => readAllEvents(root),
    findByMutation: (mutationId) => findEventsByMutation(root, mutationId),
  };
}
