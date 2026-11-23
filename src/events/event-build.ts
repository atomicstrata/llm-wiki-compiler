/**
 * @file src/events/event-build.ts
 * @description Building one chained, checksummed event record, shared by the
 * incumbent single-file event log (`./store.ts`) and the segmented event log
 * of a `local-indexed` project (`../history/events-log.ts`), so both mint ids,
 * chain `prevHash` and checksum records identically.
 */

import { ulid } from "../relations/ulid.js";
import { MAX_EVENT_RECORD_BYTES } from "../utils/constants.js";
import type { OperationBinding } from "../utils/operation-binding.js";
import { eventPrevHash } from "./event-digest.js";
import { eventChecksum, type EventChecksumInput } from "./store-record.js";
import { EventStoreFullError, GENESIS_PREV_HASH, type EventContent, type EventId, type EventRecord, type EventType } from "./types.js";

/** The caller-supplied content of a new event (id, prevHash, checksum are derived). */
export interface AppendEventInput {
  type: EventType;
  origin: string;
  payload: Record<string, unknown>;
  decision?: string;
  /** ISO-8601 emit timestamp; the caller supplies one (e.g. `new Date().toISOString()`). */
  at: string;
}

/** Mint a fresh `evt_<ULID>` id, allocated once at emit. */
function mintEventId(): EventId {
  return `evt_${ulid()}`;
}

/** The chain digest of the LAST event (or {@link GENESIS_PREV_HASH} for an empty store). */
export function prevHashFor(events: EventRecord[]): string {
  if (events.length === 0) return GENESIS_PREV_HASH;
  return eventPrevHash(events[events.length - 1]);
}

/** Build the chained, checksummed {@link EventRecord} from caller input + the prior digest. */
export function buildEventRecord(input: AppendEventInput, prevHash: string, binding?: OperationBinding): EventRecord {
  const content: EventContent = {
    id: mintEventId(),
    type: input.type,
    origin: input.origin,
    payload: input.payload,
    decision: input.decision,
    ...(binding === undefined ? {} : { operationBinding: binding }),
    at: input.at,
  };
  const unchecked: EventChecksumInput = { ...content, prevHash };
  return { ...unchecked, checksum: eventChecksum(unchecked) };
}

/**
 * Reject a record whose serialized on-disk form exceeds {@link MAX_EVENT_RECORD_BYTES}.
 * Throws {@link EventStoreFullError} BEFORE any write so the store is never touched.
 */
export function assertRecordWithinCap(serialized: string): void {
  const bytes = Buffer.byteLength(serialized, "utf8");
  if (bytes > MAX_EVENT_RECORD_BYTES) {
    throw new EventStoreFullError();
  }
}
