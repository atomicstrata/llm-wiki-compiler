/**
 * @file src/events/store-version.ts
 * @description The explicit, under-lock event-store schema upgrade. Before the
 * first operation-bound append, the store header is raised from the ordinary base
 * write version to the operation version through a durable whole-file
 * replacement, preserving every existing record byte and its order — so the hash
 * chain, per-record checksums, and sealed head anchor all remain valid (the
 * header participates in none of them). An absent store is created header-only at
 * the operation version; an already-upgraded store is left untouched; a corrupt,
 * torn, too-new, symlinked, or unavailable store throws and is never upgraded.
 */

import path from "node:path";
import { EVENTS_FILE } from "../utils/constants.js";
import { atomicWrite } from "../utils/atomic-write.js";
import { parseStoreHeaderVersion, splitStoreHeaderLine } from "../utils/store-header.js";
import { eventHeaderLine } from "./store-record.js";
import { readEvents, readEventStoreRaw } from "./store-read.js";
import { EVENT_STORE_BASE_WRITE_VERSION, EVENT_STORE_OPERATION_VERSION } from "./types.js";

/** Durably replace the whole store body through the confined atomic writer. */
async function writeStoreBody(root: string, body: string): Promise<void> {
  await atomicWrite(path.join(root, EVENTS_FILE), body, {
    confineRoot: root, exactParent: true, durable: true, strictDurability: true,
  });
}

/**
 * Ensure the event store header declares the operation schema version. The caller
 * holds the project lock and must have already repaired any uncommitted tail.
 * Throws when the store cannot be safely upgraded.
 */
export async function ensureEventOperationVersionLocked(root: string): Promise<void> {
  const raw = await readEventStoreRaw(root); // no-follow; symlink/oversize throw
  if (raw === null) {
    await writeStoreBody(root, eventHeaderLine(EVENT_STORE_OPERATION_VERSION));
    return;
  }
  const split = splitStoreHeaderLine(raw);
  const version = split === null ? null : parseStoreHeaderVersion(split.headerLine, "event-store-header");
  if (version === EVENT_STORE_OPERATION_VERSION) return;
  if (split === null || version !== EVENT_STORE_BASE_WRITE_VERSION) {
    throw new Error("event store header is not upgradable to the operation version");
  }
  const { problems } = await readEvents(root); // interior corruption/too-new throw
  if (problems.length > 0) throw new Error("event store has an uncommitted or broken tail and is not upgraded");
  await writeStoreBody(root, eventHeaderLine(EVENT_STORE_OPERATION_VERSION) + split.recordBytes);
}
