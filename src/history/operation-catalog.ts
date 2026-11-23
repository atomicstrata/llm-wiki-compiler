/**
 * @file src/history/operation-catalog.ts
 * @description The SEGMENTED WORKSPACE OPERATION CATALOG of a `local-indexed`
 * project: the incumbent `CatalogRecord`s (canonical bytes, deterministic
 * physical ids, payload digests, supersession) as rows `r<index>`, with the
 * lineage indexes the incumbent whole-history replay derives written in the
 * SAME commit:
 *
 * - `m<mutationId>` → index (idempotent replay: byte-equal → `same`);
 * - `p<physicalRecordId>` → index (no duplicate physical identity);
 * - `l<sha256(logicalRecordId)>` → index of the logical root (no root fork);
 * - `s<predecessorPhysicalId>` → index of its successor (no supersession fork).
 *
 * An append validates the new record against committed history through these
 * point lookups and refuses with the incumbent messages. Its conditional
 * manifest publication is the incumbent pre-publication check: a concurrent
 * change throws `CatalogConcurrentChangeError` and publishes nothing. There is
 * no O_APPEND and no whole-file rewrite. One store per workspace, named by a
 * digest of the workspace id, which its manifest records exactly.
 */

import { createHash } from "node:crypto";
import path from "node:path";
import { backupAbsent } from "./contracts.js";
import { operationPaths } from "../operation-bundles/paths.js";
import { canonicalBytes } from "../profile/templates/signing/canonical.js";
import { IndexedStoreError, sortedByKey, type SegmentRow } from "../segments/contracts.js";
import type { IoCounters } from "../segments/counters.js";
import { diskSegmentStoreIo, storeMayHoldLeaves } from "../segments/io.js";
import { SegmentStore } from "../segments/store.js";
import {
  CatalogConcurrentChangeError, normalizeCatalogRecord, type CatalogAppendResult, type CatalogRecord,
} from "../operation-bundles/catalog-record.js";
import { hasExactKeys, indexKey, isCount, isLegacySnapshot, legacyDriftMessage, legacyUnchanged, type LegacySnapshot } from "./contracts.js";

/** Record key prefix. */
export const CATALOG_RECORD_PREFIX = "r";

/** The operation catalog's manifest facts. */
export interface OperationCatalogMeta {
  readonly schema: 1;
  readonly phase: "importing" | "ready";
  readonly workspaceId: string;
  readonly count: number;
  readonly legacy: LegacySnapshot;
}

/** The name prefix of every workspace operation-catalog store. */
export const OPERATION_CATALOG_STORE_PREFIX = "opcat-";

/** The segment store name of `workspaceId`'s catalog. */
export function operationCatalogStore(workspaceId: string): string {
  return `${OPERATION_CATALOG_STORE_PREFIX}${createHash("sha256").update(workspaceId, "utf8").digest("hex").slice(0, 24)}`;
}

/** Open the operation catalog of `workspaceId`. */
export function openOperationCatalog(root: string, workspaceId: string, counters?: IoCounters): Promise<SegmentStore> {
  return SegmentStore.open(diskSegmentStoreIo(root, operationCatalogStore(workspaceId)), counters === undefined ? {} : { counters });
}

/** The validated (closed) facts of an opened catalog of `workspaceId` in `root`; anything else throws (the incumbent `invalid`). */
export function operationCatalogMetaOf(store: SegmentStore, root: string, workspaceId: string): OperationCatalogMeta {
  return operationCatalogMetaFrom(store.meta, root, workspaceId);
}

/** {@link operationCatalogMetaOf} over a manifest's `meta` alone (a verified backup's manifest, for one). */
function operationCatalogMetaFrom(meta: SegmentStore["meta"], root: string, workspaceId: string): OperationCatalogMeta {
  const valid = hasExactKeys(meta, ["schema", "phase", "workspaceId", "count", "legacy"]) && meta.schema === 1
    && (meta.phase === "importing" || meta.phase === "ready") && meta.workspaceId === workspaceId && isCount(meta.count)
    && isLegacySnapshot(meta.legacy, legacyCatalogPath(root, workspaceId));
  if (!valid) throw new Error("catalog is invalid: the segmented operation catalog manifest is malformed or names another workspace");
  return meta as unknown as OperationCatalogMeta;
}

/** The facts of a catalog active readers may use: well formed and fully imported. */
export function readyOperationCatalogMeta(store: SegmentStore, root: string, workspaceId: string): OperationCatalogMeta {
  return readyOperationCatalogMetaFrom(store.meta, root, workspaceId);
}

/** {@link readyOperationCatalogMeta} over a manifest's `meta` alone. */
export function readyOperationCatalogMetaFrom(value: SegmentStore["meta"], root: string, workspaceId: string): OperationCatalogMeta {
  const meta = operationCatalogMetaFrom(value, root, workspaceId);
  if (meta.phase !== "ready") throw new Error("catalog is unavailable: the segmented operation catalog has not finished importing");
  return meta;
}

/** The index a lineage row stores. */
async function indexAt(store: SegmentStore, key: string): Promise<number | undefined> {
  const value = (await store.get(key)) as { index?: unknown } | undefined;
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value.index)) throw new Error("catalog is invalid: a lineage index row is malformed");
  return value.index as number;
}

/** The canonical record at `index`, re-validated as the incumbent reader validates a line. */
export async function catalogRecordAt(store: SegmentStore, index: number): Promise<CatalogRecord> {
  return normalizeCatalogRecord((await store.get(indexKey(CATALOG_RECORD_PREFIX, index))) as CatalogRecord).record;
}

/** The record appended for `mutationId`, or undefined: two point reads, cross-checked against the addressed identity. */
export async function catalogRecordByMutation(store: SegmentStore, mutationId: string): Promise<CatalogRecord | undefined> {
  const index = await indexAt(store, `m${mutationId}`);
  if (index === undefined) return undefined;
  const record = await catalogRecordAt(store, index);
  if (record.mutationId !== mutationId) throw new Error("catalog is invalid: the mutation index points at another record");
  return record;
}

/** The logical-root key of a logical id. */
export function logicalRootKey(logicalRecordId: string): string {
  return `l${createHash("sha256").update(logicalRecordId, "utf8").digest("hex")}`;
}

/** Refuse `record` exactly as the incumbent lineage replay would, through point lookups. */
async function assertLineage(store: SegmentStore, record: CatalogRecord): Promise<void> {
  if ((await indexAt(store, `p${record.physicalRecordId}`)) !== undefined) throw new Error("catalog has duplicate physical identity");
  if (record.supersedesRecordId === undefined) {
    if ((await indexAt(store, logicalRootKey(record.logicalRecordId))) !== undefined) throw new Error("catalog logical identity has a root fork");
    return;
  }
  const predecessorAt = await indexAt(store, `p${record.supersedesRecordId}`);
  if (predecessorAt === undefined) throw new Error("catalog predecessor is missing, forms a cycle, or is out of order");
  const predecessor = await catalogRecordAt(store, predecessorAt);
  if (predecessor.physicalRecordId !== record.supersedesRecordId) throw new Error("catalog is invalid: the physical index points at another record");
  if (predecessor.logicalRecordId !== record.logicalRecordId) throw new Error("catalog supersession changes logical identity");
  if ((await indexAt(store, `s${record.supersedesRecordId}`)) !== undefined) throw new Error("catalog supersession fork detected");
}

/** The record and lineage rows of `record` at `index`, sorted. */
export function catalogRows(index: number, record: CatalogRecord): SegmentRow[] {
  const rows: SegmentRow[] = [
    { k: indexKey(CATALOG_RECORD_PREFIX, index), v: record },
    { k: `m${record.mutationId}`, v: { index } },
    { k: `p${record.physicalRecordId}`, v: { index } },
    record.supersedesRecordId === undefined ? { k: logicalRootKey(record.logicalRecordId), v: { index } } : { k: `s${record.supersedesRecordId}`, v: { index } },
  ];
  return sortedByKey(rows);
}

/** The incumbent catalog file of `workspaceId`, project-relative. */
export function legacyCatalogPath(root: string, workspaceId: string): string {
  return path.relative(root, operationPaths(root, workspaceId).catalogFile).split(path.sep).join("/");
}

/**
 * The facts of a workspace catalog first created AFTER activation: allowed
 * only when the workspace has no incumbent catalog file (one that exists was
 * never imported, so the write refuses rather than forking its history).
 */
async function freshCatalogMeta(root: string, store: SegmentStore, workspaceId: string): Promise<OperationCatalogMeta> {
  const relPath = legacyCatalogPath(root, workspaceId);
  if (!(await backupAbsent(root, relPath, store.counters))) throw new Error("catalog is unavailable: this workspace has a catalog file (or something unusable in its place) that was never imported");
  if ((await storeMayHoldLeaves(store.io))) throw new Error("catalog is unavailable: the workspace's segmented catalog directory exists but its manifest is missing; restore it from a backup");
  return { schema: 1, phase: "ready", workspaceId, count: 0, legacy: { relPath, stamp: null, records: 0, bytes: 0, sha256: null } };
}

/** The ready catalog of `workspaceId` for a write; refuses an unfinished import or a changed legacy file. */
async function catalogForWrite(root: string, workspaceId: string): Promise<{ store: SegmentStore; meta: OperationCatalogMeta }> {
  const store = await openOperationCatalog(root, workspaceId);
  const meta = store.exists ? readyOperationCatalogMeta(store, root, workspaceId) : await freshCatalogMeta(root, store, workspaceId);
  if (!(await legacyUnchanged(root, meta.legacy, store.counters))) throw new Error(`catalog is unavailable: ${legacyDriftMessage(meta.legacy)}`);
  return { store, meta };
}

/** Run `work`, turning a store's concurrent change into the incumbent `CatalogConcurrentChangeError`. */
async function asCatalogConflict(work: () => Promise<unknown>): Promise<void> {
  try {
    await work();
  } catch (error) {
    if (error instanceof IndexedStoreError && error.code === "indexed_store_concurrent_change") throw new CatalogConcurrentChangeError();
    throw error;
  }
}

/** Append one validated record (idempotent on its mutation) under the caller's project lock. */
export async function appendSegmentedCatalogRecord(root: string, workspaceId: string, candidate: CatalogRecord): Promise<CatalogAppendResult> {
  const prepared = normalizeCatalogRecord(candidate);
  const { store, meta } = await catalogForWrite(root, workspaceId);
  const existing = await catalogRecordByMutation(store, prepared.record.mutationId);
  if (existing !== undefined) {
    if (!canonicalBytes(existing).equals(prepared.bytes)) throw new Error("catalog mutation replay conflict");
    await asCatalogConflict(() => store.assertCurrent()); // the replay writes nothing, but answers only from the current manifest
    return "same";
  }
  await assertLineage(store, prepared.record);
  await asCatalogConflict(() => store.commit({ rows: catalogRows(meta.count, prepared.record), meta: { ...meta, count: meta.count + 1 } }));
  return "created";
}
