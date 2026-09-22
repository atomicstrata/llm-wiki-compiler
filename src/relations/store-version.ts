/**
 * @file src/relations/store-version.ts
 * @description The explicit, under-lock relation-store schema upgrade. Before the
 * first operation-bound append, the store header is raised from the ordinary base
 * write version to the operation version through a durable whole-file
 * replacement, preserving every existing record byte and its order. An absent
 * store is created header-only at the operation version; an already-upgraded
 * store is left untouched; a corrupt, torn, too-new, symlinked, or unavailable
 * store throws (surfaced through the no-follow reader) and is never upgraded.
 */

import path from "node:path";
import { RELATIONS_FILE } from "../utils/constants.js";
import { atomicWrite } from "../utils/atomic-write.js";
import { parseStoreHeaderVersion, splitStoreHeaderLine } from "../utils/store-header.js";
import { headerLine } from "./store-record.js";
import { readRelationRecords, readRelationStoreRaw } from "./store-read.js";
import { RELATION_STORE_BASE_WRITE_VERSION, RELATION_STORE_OPERATION_VERSION } from "./types.js";

/** Durably replace the whole store body through the confined atomic writer. */
async function writeStoreBody(root: string, body: string): Promise<void> {
  await atomicWrite(path.join(root, RELATIONS_FILE), body, {
    confineRoot: root, exactParent: true, durable: true, strictDurability: true,
  });
}

/**
 * Ensure the relation store header declares the operation schema version. The
 * caller holds the project lock. Throws when the store cannot be safely upgraded.
 */
export async function ensureRelationOperationVersionLocked(root: string): Promise<void> {
  const raw = await readRelationStoreRaw(root); // no-follow; symlink/oversize throw
  if (raw === null) {
    await writeStoreBody(root, headerLine(RELATION_STORE_OPERATION_VERSION));
    return;
  }
  const split = splitStoreHeaderLine(raw);
  const version = split === null ? null : parseStoreHeaderVersion(split.headerLine, "relation-store-header");
  if (version === RELATION_STORE_OPERATION_VERSION) return;
  if (split === null || version !== RELATION_STORE_BASE_WRITE_VERSION) {
    throw new Error("relation store header is not upgradable to the operation version");
  }
  const { problems } = await readRelationRecords(root); // interior corruption throws
  if (problems.length > 0) throw new Error("relation store has an uncommitted tail and is not upgraded");
  await writeStoreBody(root, headerLine(RELATION_STORE_OPERATION_VERSION) + split.recordBytes);
}
