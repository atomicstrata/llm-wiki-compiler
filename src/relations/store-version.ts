/**
 * @file src/relations/store-version.ts
 * @description The explicit, under-lock relation-store schema upgrade. Before the
 * first operation-bound append, the store header is raised from the ordinary base
 * write version to the operation version through a durable whole-file
 * replacement, preserving every existing record byte and its order. An absent
 * store is created header-only at the operation version; an already-upgraded
 * store is left untouched; a corrupt, torn, too-new, symlinked, or unavailable
 * store throws (surfaced through the no-follow reader) and is never upgraded.
 *
 * ONE BODY: {@link ensureRelationOperationVersionLocked} runs
 * {@link ensureRelationOperationVersionLockedFrom} over local-disk
 * {@link RelationUpgradeSources}: this store's graph read plus ONE raw write,
 * the DURABLE whole-store replacement, a member of its own. The version
 * decisions, the refusals and their messages, and the bytes written stay here.
 */

import path from "node:path";
import { RELATIONS_FILE } from "../utils/constants.js";
import { atomicWrite } from "../utils/atomic-write.js";
import { type GraphStoreReads } from "../utils/jsonl-store.js";
import { diskRelationGraphReads } from "./graph-reads.js";
import { parseStoreHeaderVersion, splitStoreHeaderLine } from "../utils/store-header.js";
import { headerLine } from "./store-record.js";
import { readRelationRecordsFrom, readRelationStoreRawFrom } from "./store-read.js";
import { RELATION_STORE_BASE_WRITE_VERSION, RELATION_STORE_OPERATION_VERSION } from "./types.js";

/**
 * Everything {@link ensureRelationOperationVersionLockedFrom} reads and writes.
 * Owned by the relation store; not `ProjectStore`, not hosted, and it selects no
 * backend.
 */
export interface RelationUpgradeSources {
  /** This store's confined graph read. */
  graph: GraphStoreReads;
  /**
   * Replace the WHOLE store body with `body`, DURABLY. Disk: the incumbent
   * `atomicWrite` of `<root>/wiki/graph/relations.jsonl` (the root as given)
   * with `confineRoot`, `exactParent`, `durable` and `strictDurability`: an
   * fsynced O_EXCL temp, the rename, the published-destination check and the
   * strict directory-chain fsync. A rejection AFTER the rename is the writer's
   * `AtomicWritePostCommitError`: the body is published and its durability is
   * unproven. REJECTS raw otherwise.
   */
  replaceStoreDurable(body: string): Promise<void>;
}

/** Durably replace the whole store body through the confined atomic writer. */
async function writeStoreBody(root: string, body: string): Promise<void> {
  await atomicWrite(path.join(root, RELATIONS_FILE), body, {
    confineRoot: root, exactParent: true, durable: true, strictDurability: true,
  });
}

/**
 * LOCAL DISK. The upgrade sources for the project at `root`: the shared graph
 * read and the durable replacement, which reaches `atomicWrite` through
 * `../utils/atomic-write.js` at call time. Building them does no I/O. In no
 * package index.
 */
export function diskRelationUpgradeSources(root: string): RelationUpgradeSources {
  return { graph: diskRelationGraphReads(root), replaceStoreDurable: (body) => writeStoreBody(root, body) };
}

/**
 * Ensure the relation store header declares the operation schema version. The
 * caller holds the project lock. Throws when the store cannot be safely upgraded.
 */
export async function ensureRelationOperationVersionLocked(root: string): Promise<void> {
  await ensureRelationOperationVersionLockedFrom(diskRelationUpgradeSources(root));
}

/**
 * {@link ensureRelationOperationVersionLocked} over {@link RelationUpgradeSources}:
 * THE ONE BODY. The raw read, then: absent → header-only at the operation
 * version; already there → nothing; not the base version → refused; a tail
 * problem → refused; otherwise the new header over the record bytes verbatim.
 */
export async function ensureRelationOperationVersionLockedFrom(sources: RelationUpgradeSources): Promise<void> {
  const raw = await readRelationStoreRawFrom(sources.graph); // no-follow; symlink/oversize throw
  if (raw === null) {
    await sources.replaceStoreDurable(headerLine(RELATION_STORE_OPERATION_VERSION));
    return;
  }
  const split = splitStoreHeaderLine(raw);
  const version = split === null ? null : parseStoreHeaderVersion(split.headerLine, "relation-store-header");
  if (version === RELATION_STORE_OPERATION_VERSION) return;
  if (split === null || version !== RELATION_STORE_BASE_WRITE_VERSION) {
    throw new Error("relation store header is not upgradable to the operation version");
  }
  const { problems } = await readRelationRecordsFrom(sources.graph); // interior corruption throws
  if (problems.length > 0) throw new Error("relation store has an uncommitted tail and is not upgraded");
  await sources.replaceStoreDurable(headerLine(RELATION_STORE_OPERATION_VERSION) + split.recordBytes);
}
