/**
 * @file src/relations/store-record.ts
 * @description Shared record (de)serialization for the relation store: the
 * per-record checksum, the header line, and the graph-directory confinement
 * helper. Kept separate so the append (write) and read paths compute the
 * checksum and resolve the directory through ONE definition — a write and a
 * read can never disagree on what a valid line is.
 *
 * The checksum is a SHA-256 over the RFC 8785 canonicalization of the record's
 * content fields (the {@link RelationRef}, i.e. everything except `checksum`),
 * recomputed on read and compared. It detects a flipped byte anywhere in the
 * line independently of the content hash (which a writer could, in principle,
 * have written wrong).
 *
 * The NO-FOLLOW append primitive for the canonical store FILE leaf
 * (`openStoreFileAppend`) and the confined graph-DIR resolver (`resolveGraphDir`)
 * are thin relation-typed wrappers around the SHARED `src/utils/jsonl-store.ts`
 * primitives (which the event store reuses). The write path routes through them,
 * so a symlinked `relations.jsonl` leaf can never be followed to append to an
 * out-of-tree file (the read path opens the leaf through the shared
 * `readConfinedGraphStore`). This is the LEAF defense; {@link resolveGraphDir} is
 * the DIR defense — BOTH are required to confine the store.
 */

import { createHash } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import canonicalize from "canonicalize";
import { resolveConfinedGraphDir, openGraphFileAppend } from "../utils/jsonl-store.js";
import type { RelationRef, RelationRecord, RelationStoreHeader } from "./types.js";
import { RELATION_STORE_SCHEMA_VERSION, RelationStoreSymlinkError } from "./types.js";

/** Build the relation store's typed symlink error from a reason string. */
function relationSymlinkError(reason: string): Error {
  return new RelationStoreSymlinkError(reason);
}

/** Compute the per-record checksum over a relation's content (excludes `checksum`). */
export function recordChecksum(ref: RelationRef): string {
  const canonical = canonicalize(ref);
  if (canonical === undefined) {
    throw new Error("relation record canonicalization produced no output");
  }
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/** Serialize a {@link RelationRef} to its on-disk JSONL line (with trailing newline). */
export function serializeRecord(ref: RelationRef): string {
  const record: RelationRecord = { ...ref, checksum: recordChecksum(ref) };
  return JSON.stringify(record) + "\n";
}

/** The header line (with trailing newline) written when a store is created. */
export function headerLine(): string {
  const header: RelationStoreHeader = {
    kind: "relation-store-header",
    schemaVersion: RELATION_STORE_SCHEMA_VERSION,
  };
  return JSON.stringify(header) + "\n";
}

/**
 * Resolve the trusted on-disk graph directory for `root`: the relation-typed
 * wrapper over the shared {@link resolveConfinedGraphDir} (a symlinked
 * `wiki/graph` or escaping ancestor fails closed). Returns `{ dir, exists }`;
 * `exists` is false when the directory is simply absent (the "no relations" state).
 *
 * @param root - Absolute project root.
 * @returns The confined graph dir and whether it currently exists on disk.
 */
export function resolveGraphDir(root: string): Promise<{ dir: string; exists: boolean }> {
  return resolveConfinedGraphDir(root);
}

/**
 * Open the canonical store FILE leaf for APPEND with `O_NOFOLLOW` (the
 * relation-typed wrapper over the shared {@link openGraphFileAppend}). A symlinked
 * leaf fails closed ({@link RelationStoreSymlinkError}). The LEAF defense
 * complementing the {@link resolveGraphDir} DIR defense.
 *
 * @param file - The store file path inside the already-confined graph dir.
 * @returns An open append handle to a confirmed regular file.
 */
export function openStoreFileAppend(file: string): Promise<FileHandle> {
  return openGraphFileAppend(file, relationSymlinkError);
}
