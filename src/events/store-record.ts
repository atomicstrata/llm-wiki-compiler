/**
 * @file src/events/store-record.ts
 * @description Shared record (de)serialization + leaf confinement for the EVENT
 * store, mirroring `src/relations/store-record.ts`. Owns the per-record checksum,
 * the header line, and the event-typed wrappers over the SHARED
 * `src/utils/jsonl-store.ts` no-follow open + confined graph-dir primitives — so
 * the event store inherits the relation store's symlink/regular-file hardening
 * rather than re-deriving it.
 *
 * The checksum is a SHA-256 over the RFC 8785 canonicalization of the record's
 * non-checksum fields (the {@link EventRecord} minus `checksum`, INCLUDING
 * `prevHash`), recomputed and compared on read. It detects a flipped byte
 * anywhere in the line independently of the chain digest.
 */

import { createHash } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import canonicalize from "canonicalize";
import {
  resolveConfinedGraphDir,
  openGraphFileRead,
  openGraphFileAppend,
} from "../utils/jsonl-store.js";
import type { EventRecord, EventStoreHeader } from "./types.js";
import { EVENT_STORE_SCHEMA_VERSION, EventStoreSymlinkError } from "./types.js";

/** The record fields the per-record checksum is computed over (all but `checksum`). */
export type EventChecksumInput = Omit<EventRecord, "checksum">;

/** Build the event store's typed symlink error from a reason string. */
function eventSymlinkError(reason: string): Error {
  return new EventStoreSymlinkError(reason);
}

/** Compute the per-record checksum over an event's content (excludes `checksum`). */
export function eventChecksum(input: EventChecksumInput): string {
  const canonical = canonicalize(input);
  if (canonical === undefined) {
    throw new Error("event record canonicalization produced no output");
  }
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/** Serialize an event (its non-checksum fields) to its on-disk JSONL line. */
export function serializeEventRecord(input: EventChecksumInput): string {
  const record: EventRecord = { ...input, checksum: eventChecksum(input) };
  return JSON.stringify(record) + "\n";
}

/** The header line (with trailing newline) written when a store is created. */
export function eventHeaderLine(): string {
  const header: EventStoreHeader = {
    kind: "event-store-header",
    schemaVersion: EVENT_STORE_SCHEMA_VERSION,
  };
  return JSON.stringify(header) + "\n";
}

/**
 * Resolve the confined graph dir for `root` (event-typed wrapper over the shared
 * {@link resolveConfinedGraphDir}; a symlinked `wiki/graph` fails closed). The
 * event store shares this dir with the relation store.
 */
export function resolveEventGraphDir(root: string): Promise<{ dir: string; exists: boolean }> {
  return resolveConfinedGraphDir(root);
}

/** Open the event store FILE leaf for READING with `O_NOFOLLOW` (symlink → fail closed). */
export function openEventFileRead(file: string): Promise<FileHandle | null> {
  return openGraphFileRead(file, eventSymlinkError);
}

/** Open the event store FILE leaf for APPEND with `O_NOFOLLOW` (symlink → fail closed). */
export function openEventFileAppend(file: string): Promise<FileHandle> {
  return openGraphFileAppend(file, eventSymlinkError);
}
