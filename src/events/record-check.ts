/**
 * @file src/events/record-check.ts
 * @description The validators of ONE stored event record and of a chain of
 * them: the required fields and operation binding, the checksum, and the
 * `prevHash` links. Shared by the single-file event reader (`./store-read.ts`)
 * and the segmented event log (`../history/events-*.ts`); a leaf, so the
 * segmented log never imports the reader that dispatches to it.
 */

import { isOperationBinding } from "../utils/operation-binding.js";
import { eventPrevHash } from "./event-digest.js";
import { eventChecksum } from "./store-record.js";
import { EventStoreCorruptError, GENESIS_PREV_HASH, type EventRecord } from "./types.js";

/** Parse one record line into an {@link EventRecord}, validating its required shape. */
export function parseRecord(line: string): EventRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new EventStoreCorruptError("record line is not valid JSON");
  }
  const rec = parsed as Partial<EventRecord>;
  const idOk = typeof rec.id === "string" && rec.id.startsWith("evt_");
  if (!idOk || typeof rec.checksum !== "string" || typeof rec.prevHash !== "string" || typeof rec.type !== "string") {
    throw new EventStoreCorruptError("record line is missing required fields");
  }
  if (rec.operationBinding !== undefined && !isOperationBinding(rec.operationBinding)) {
    throw new EventStoreCorruptError(`event ${rec.id} has a malformed operation binding`);
  }
  return rec as EventRecord;
}

/** Verify a parsed record's stored checksum; throw {@link EventStoreCorruptError} on mismatch. */
export function verifyChecksum(record: EventRecord): EventRecord {
  const { checksum, ...rest } = record;
  if (eventChecksum(rest) !== checksum) {
    throw new EventStoreCorruptError(`checksum mismatch for event ${record.id}`);
  }
  return record;
}

/**
 * Verify the hash chain over `events` (file order): the first record's `prevHash`
 * must equal {@link GENESIS_PREV_HASH}, and each subsequent record's `prevHash`
 * must equal the chain digest of its predecessor ({@link eventPrevHash}). An edit,
 * reorder, deletion, or fork changes a digest and breaks a link.
 *
 * @param events - Events in append order.
 * @returns `{ ok }`, with a `problem` describing the first broken link when not ok.
 */
export function verifyEventChain(events: EventRecord[]): { ok: boolean; problem?: string } {
  for (let i = 0; i < events.length; i++) {
    const expected = i === 0 ? GENESIS_PREV_HASH : eventPrevHash(events[i - 1]);
    if (events[i].prevHash !== expected) {
      return { ok: false, problem: `chain link broken at event ${i} (${events[i].id})` };
    }
  }
  return { ok: true };
}

/**
 * Validate one STORED event value of the segmented event log (`local-indexed`):
 * the same required-field, operation-binding and checksum checks a JSONL line
 * gets here. Any failure is {@link EventStoreCorruptError}.
 */
export function checkedEventRecord(value: unknown): EventRecord {
  return verifyChecksum(parseRecord(JSON.stringify(value)));
}
