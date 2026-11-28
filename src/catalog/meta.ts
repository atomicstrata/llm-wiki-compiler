/**
 * @file src/catalog/meta.ts
 * @description Open the catalog store and validate its manifest facts.
 *
 * The facts are checked strictly: a manifest whose catalog facts have the
 * wrong shape is corruption and fails closed, like any other store fault.
 * An absent catalog reads as empty and `building`.
 */

import { corrupt, MAX_KEY_CHARS } from "../segments/contracts.js";
import type { IoCounters } from "../segments/counters.js";
import { diskSegmentStoreIo } from "../segments/io.js";
import { SegmentStore } from "../segments/store.js";
import { CATALOG_SCHEMA, CATALOG_STORE, emptyCatalogMeta, SAMPLE_SIZE, type CatalogMeta } from "./contracts.js";

/** Whether `value` is a non-negative safe integer. */
function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** Whether `value` is an object with exactly `keys`. */
function exactly(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const present = Object.keys(value);
  return present.length === keys.length && keys.every((key) => present.includes(key));
}

/** Whether `value` is a bounded sample of paths. */
function isSample(value: unknown): boolean {
  return Array.isArray(value) && value.length <= SAMPLE_SIZE && value.every((item) => typeof item === "string" && item.length <= MAX_KEY_CHARS);
}

/** Whether `value` maps entity types to their directories (non-empty names). */
function isDirectoryMap(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.entries(value).every(([type, dir]) => type.length > 0 && typeof dir === "string" && dir.length > 0);
}

/** Whether `value` is a typed catalog's facts (closed shape). */
function isTypedMeta(value: unknown): boolean {
  if (!exactly(value, ["profileDigest", "catalogId", "pages", "problems", "directories"])) return false;
  const identity = typeof value.profileDigest === "string" && value.profileDigest.length > 0 && typeof value.catalogId === "string" && /^[0-9a-f]{32}$/.test(value.catalogId);
  return identity && isCount(value.pages) && isCount(value.problems) && isDirectoryMap(value.directories);
}

/** The validated catalog facts of an opened store (closed shapes; anything else is corruption). */
export function catalogMetaOf(store: SegmentStore): CatalogMeta {
  if (!store.exists) return emptyCatalogMeta();
  const meta = store.meta;
  const keys = ["schema", "phase", "counts", "uncatalogued", ...("typed" in meta ? ["typed"] : [])];
  const valid = exactly(meta, keys) && meta.schema === CATALOG_SCHEMA && (!("typed" in meta) || isTypedMeta(meta.typed))
    && (meta.phase === "building" || meta.phase === "ready" || meta.phase === "reconciling")
    && exactly(meta.counts, ["concepts", "queries", "sources"]) && isCount(meta.counts.concepts) && isCount(meta.counts.queries) && isCount(meta.counts.sources)
    && exactly(meta.uncatalogued, ["count", "sample"]) && isCount(meta.uncatalogued.count) && isSample(meta.uncatalogued.sample);
  if (!valid) corrupt("catalog manifest facts are malformed");
  return meta as unknown as CatalogMeta;
}

/** Open the catalog of the project at `root`. */
export function openCatalog(root: string, counters?: IoCounters): Promise<SegmentStore> {
  return SegmentStore.open(diskSegmentStoreIo(root, CATALOG_STORE), counters === undefined ? {} : { counters });
}
