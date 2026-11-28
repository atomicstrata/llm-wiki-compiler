/**
 * @file src/history/operation-catalog-read.ts
 * @description Reads of the segmented workspace operation catalog, and the
 * port the incumbent catalog bodies dispatch to on a `local-indexed` project.
 *
 * - `readAll` is the CAPPED compatibility materializer: the incumbent
 *   `readCatalogStore` shape, refused beyond the incumbent 50,000-record /
 *   32 MiB caps (`history_materialization_too_large`) instead of growing.
 * - `findByMutation` is the bounded lookup the adapter's observation uses.
 * - `summary` is what the gate's inventory leg needs (count and health) from
 *   the manifest alone, so a gated write never reads catalog history.
 */

import { indexedActive } from "../indexed/routing.js";
import { storeMayHoldLeaves } from "../segments/io.js";
import type { SegmentStore } from "../segments/store.js";
import type { CatalogAppendResult, CatalogRecord, CatalogStoreRead } from "../operation-bundles/catalog-record.js";
import { MAX_CATALOG_FILE_BYTES, MAX_CATALOG_RECORDS_PER_WORKSPACE } from "../operation-bundles/constants.js";
import { HistoryMaterializationTooLargeError } from "./contracts.js";
import {
  appendSegmentedCatalogRecord, CATALOG_RECORD_PREFIX, catalogRecordByMutation, openOperationCatalog, readyOperationCatalogMeta,
  readyOperationCatalogMetaFrom,
} from "./operation-catalog.js";
import { normalizeCatalogRecord } from "../operation-bundles/catalog-record.js";

/** A catalog's count and health from its manifest alone. */
export type CatalogSummary =
  | { readonly status: "absent" }
  | { readonly status: "ok"; readonly records: number }
  | { readonly status: "invalid" | "unavailable"; readonly detail: string };

/** The detail of a store fault, as the incumbent read reports it. */
function faultOf(error: unknown): { status: "invalid"; detail: string } {
  return { status: "invalid", detail: error instanceof Error ? error.message : "catalog is invalid" };
}

/**
 * Whether the workspace has NO segmented catalog at all: no manifest AND an
 * empty (or absent) store directory. A directory with segments but no
 * manifest is a lost manifest and fails closed, never an empty history.
 */
async function cleanlyAbsent(store: SegmentStore): Promise<boolean> {
  if (store.exists) return false;
  if ((await storeMayHoldLeaves(store.io))) throw new Error("catalog is unavailable: the workspace's segmented catalog directory exists but its manifest is missing");
  return true;
}

/** Every record in append order, capped at the incumbent caps. O(history). */
async function readAllCatalogRecords(root: string, workspaceId: string): Promise<CatalogStoreRead> {
  try {
    const store = await openOperationCatalog(root, workspaceId);
    if (await cleanlyAbsent(store)) return { status: "absent" };
    readyOperationCatalogMeta(store, root, workspaceId);
    const records: CatalogRecord[] = [];
    let bytes = 0;
    for await (const row of store.scan({ prefix: CATALOG_RECORD_PREFIX })) {
      const record = normalizeCatalogRecord(row.v as CatalogRecord);
      bytes += record.bytes.byteLength + 1;
      if (records.length >= MAX_CATALOG_RECORDS_PER_WORKSPACE || bytes > MAX_CATALOG_FILE_BYTES) {
        return { status: "unavailable", detail: new HistoryMaterializationTooLargeError("operation catalog", MAX_CATALOG_FILE_BYTES).message };
      }
      records.push(record.record);
    }
    return { status: "ok", records };
  } catch (error) {
    return faultOf(error);
  }
}

/** The catalog's count and health from its manifest (one read). */
export async function catalogSummary(root: string, workspaceId: string): Promise<CatalogSummary> {
  try {
    const store = await openOperationCatalog(root, workspaceId);
    if (await cleanlyAbsent(store)) return { status: "absent" };
    return { status: "ok", records: readyOperationCatalogMeta(store, root, workspaceId).count };
  } catch (error) {
    return faultOf(error);
  }
}

/** The summary {@link catalogSummary} would give for a catalog whose manifest `meta` is already read and verified (a verified backup's). */
export function catalogSummaryOfMeta(meta: SegmentStore["meta"], root: string, workspaceId: string): CatalogSummary {
  try {
    return { status: "ok", records: readyOperationCatalogMetaFrom(meta, root, workspaceId).count };
  } catch (error) {
    return faultOf(error);
  }
}

/** What the incumbent catalog bodies ask of the segmented catalog when the project is `local-indexed`. */
export interface SegmentedOperationCatalog {
  append(candidate: CatalogRecord): Promise<CatalogAppendResult>;
  readAll(): Promise<CatalogStoreRead>;
  findByMutation(mutationId: string): Promise<CatalogRecord | undefined>;
  summary(): Promise<CatalogSummary>;
}

/** The segmented catalog of `workspaceId` when the project is `local-indexed`, else `null`. */
export async function segmentedOperationCatalogFor(root: string, workspaceId: string): Promise<SegmentedOperationCatalog | null> {
  if (!(await indexedActive(root))) return null;
  return {
    append: (candidate) => appendSegmentedCatalogRecord(root, workspaceId, candidate),
    readAll: () => readAllCatalogRecords(root, workspaceId),
    findByMutation: async (mutationId) => {
      const store = await openOperationCatalog(root, workspaceId);
      if (await cleanlyAbsent(store)) return undefined;
      readyOperationCatalogMeta(store, root, workspaceId);
      return catalogRecordByMutation(store, mutationId);
    },
    summary: () => catalogSummary(root, workspaceId),
  };
}
