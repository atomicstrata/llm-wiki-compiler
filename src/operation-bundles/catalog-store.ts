/**
 * @file src/operation-bundles/catalog-store.ts
 * @description Founding authority for the workspace catalog. Logical append is
 * implemented as a complete confined read, closed-record validation, canonical
 * in-memory append, and strictly durable whole-file replacement. This module
 * never uses O_APPEND and never treats an unreadable catalog as empty.
 *
 * ONE READ BODY AND ONE APPEND BODY over {@link CatalogLeaves}: the whole catalog
 * leaf, and a whole-file replacement whose revalidation callback runs at the
 * writer's last pre-rename seam. The bodies own parsing, validation, replay,
 * caps, canonical serialization and the unchanged-before-publication check; the
 * local-disk factory keeps the confined single-link read and the strictly durable
 * exact-parent 0600 replacement.
 */

import type { SegmentedOperationCatalog } from "../history/operation-catalog-read.js";
import { canonicalBytes } from "../profile/templates/signing/canonical.js";
import { atomicWrite, type AtomicWriteOptions } from "../utils/atomic-write.js";
import { readConfinedLeafBuffer, type CappedLeafReadBuffer } from "../utils/confined-read.js";
import { MAX_CATALOG_FILE_BYTES, MAX_CATALOG_RECORDS_PER_WORKSPACE } from "./constants.js";
import { assertMutationId, type MutationId } from "./ids.js";
import { operationPaths } from "./paths.js";

import {
  CatalogConcurrentChangeError, normalizeCatalogRecord, parseCatalogBytes, validateCatalogGraph,
  type CatalogAppendResult, type CatalogRecord, type CatalogStoreRead,
} from "./catalog-record.js";

export {
  CatalogConcurrentChangeError, createCatalogRecord, type CatalogAppendResult, type CatalogRecord, type CatalogStoreRead,
} from "./catalog-record.js";

/** Test-only strict durability seam inherited from the shared atomic writer. */
export type CatalogWriteOptions = Pick<AtomicWriteOptions,
  "afterParentCheckForTest" | "beforeDirectorySyncForTest">;

/** What the catalog bodies ask of the store. No member takes a project root. */
export interface CatalogLeaves {
  /** The whole catalog leaf within `maxBytes`; may throw or reject for an unusable path. */
  readCatalogLeaf(workspaceId: string, maxBytes: number): Promise<CappedLeafReadBuffer>;
  /** Strictly replace the whole catalog; `revalidate` runs at the writer's last pre-rename seam. */
  replaceCatalog(
    workspaceId: string, body: Buffer, revalidate: () => Promise<void>,
    options: Pick<CatalogWriteOptions, "beforeDirectorySyncForTest">,
  ): Promise<void>;
  /**
   * OPTIONAL: the workspace's segmented catalog when the project is
   * `local-indexed` (both bodies then dispatch to it), or `null` when the
   * incumbent catalog file is the authority. Absent in test doubles.
   */
  segmented?(workspaceId: string): Promise<SegmentedOperationCatalog | null>;
}

/** The local-disk catalog leaves for one root, built per call. In no package index. */
function diskCatalogLeaves(root: string): CatalogLeaves {
  return {
    readCatalogLeaf: (workspaceId, maxBytes) => {
      const paths = operationPaths(root, workspaceId);
      return readConfinedLeafBuffer(root, paths.catalogFile, paths.workspaceRoot, maxBytes, { requireSingleLink: true });
    },
    replaceCatalog: (workspaceId, body, revalidate, options) => atomicWrite(operationPaths(root, workspaceId).catalogFile, body, {
      confineRoot: root, exactParent: true, durable: true, strictDurability: true, mode: 0o600,
      ...options, afterParentCheckForTest: revalidate,
    }),
    // Loaded on demand: the segmented catalog imports this module's validators.
    segmented: (workspaceId) => import("../history/operation-catalog-read.js").then((catalog) => catalog.segmentedOperationCatalogFor(root, workspaceId)),
  };
}

/** Read, confine, parse, and validate the complete catalog without side effects. */
export async function readCatalogStore(root: string, workspaceId: string): Promise<CatalogStoreRead> {
  return readCatalogStoreFrom(diskCatalogLeaves(root), workspaceId);
}

/** {@link readCatalogStore} over the catalog leaves: the one read body. */
async function readCatalogStoreFrom(leaves: CatalogLeaves, workspaceId: string): Promise<CatalogStoreRead> {
  let segmented: SegmentedOperationCatalog | null = null;
  try { segmented = (await leaves.segmented?.(workspaceId)) ?? null; } catch { return { status: "unavailable", detail: "catalog authority could not be determined" }; }
  if (segmented) return segmented.readAll(); // capped compatibility materializer of the indexed catalog
  return readCatalogFileFrom(leaves, workspaceId);
}

/** The incumbent single-file catalog read: the confined leaf, parsed and validated whole. */
async function readCatalogFileFrom(leaves: CatalogLeaves, workspaceId: string): Promise<CatalogStoreRead> {
  let read: CappedLeafReadBuffer;
  try {
    read = await leaves.readCatalogLeaf(workspaceId, MAX_CATALOG_FILE_BYTES);
  } catch {
    return { status: "unavailable", detail: "catalog path is unavailable" };
  }
  if (read.kind === "absent") return { status: "absent" };
  if (read.kind === "unavailable") return { status: "unavailable", detail: "catalog leaf is unavailable" };
  try {
    return { status: "ok", records: parseCatalogBytes(read.body) };
  } catch (error) {
    return { status: "invalid", detail: error instanceof Error ? error.message : "catalog is invalid" };
  }
}

/** Find the unique record for a deterministic append mutation. */
export function findCatalogRecordByMutation(
  records: readonly CatalogRecord[],
  mutationId: MutationId,
): CatalogRecord | undefined {
  assertMutationId(mutationId);
  return records.find((item) => item.mutationId === mutationId);
}

/** Serialize complete canonical history with an exact line terminator. */
function serializeCatalog(records: readonly CatalogRecord[]): Buffer {
  const body = Buffer.concat(records.flatMap((item) => [canonicalBytes(item), Buffer.from("\n")]));
  if (body.byteLength > MAX_CATALOG_FILE_BYTES) throw new Error("catalog file exceeds its file cap");
  return body;
}

/** Strictly replace the whole catalog and its containing directory chain. */
async function writeCatalog(
  leaves: CatalogLeaves,
  workspaceId: string,
  body: Buffer,
  expectedBody: Buffer | undefined,
  options: CatalogWriteOptions,
): Promise<void> {
  const { afterParentCheckForTest, ...writeOptions } = options;
  await leaves.replaceCatalog(workspaceId, body, async () => {
    await afterParentCheckForTest?.();
    await assertCatalogUnchanged(leaves, workspaceId, expectedBody);
  }, writeOptions);
}

/** Re-read canonical state at the atomic writer's last public pre-write seam. */
async function assertCatalogUnchanged(
  leaves: CatalogLeaves,
  workspaceId: string,
  expectedBody: Buffer | undefined,
): Promise<void> {
  const current = await readCatalogStoreFrom(leaves, workspaceId);
  if (expectedBody === undefined && current.status === "absent") return;
  if (expectedBody !== undefined && current.status === "ok"
    && serializeCatalog(current.records).equals(expectedBody)) return;
  throw new CatalogConcurrentChangeError();
}

/** Append exactly one validated record through a durable whole-file rewrite. */
export async function appendCatalogRecordLocked(
  root: string,
  workspaceId: string,
  candidate: CatalogRecord,
  options: CatalogWriteOptions = {},
): Promise<CatalogAppendResult> {
  return appendCatalogRecordWith(diskCatalogLeaves(root), workspaceId, candidate, options);
}

/** {@link appendCatalogRecordLocked} over the catalog leaves: the one append body. */
export async function appendCatalogRecordWith(
  leaves: CatalogLeaves,
  workspaceId: string,
  candidate: CatalogRecord,
  options: CatalogWriteOptions = {},
): Promise<CatalogAppendResult> {
  const segmented = await leaves.segmented?.(workspaceId);
  if (segmented) return segmented.append(candidate); // local-indexed: point-lookup lineage, conditional manifest publication
  const prepared = normalizeCatalogRecord(candidate), read = await readCatalogStoreFrom(leaves, workspaceId);
  if (read.status === "unavailable" || read.status === "invalid") {
    throw new Error(`catalog is ${read.status}: ${read.detail}`);
  }
  const records = read.status === "ok" ? [...read.records] : [];
  const expectedBody = read.status === "ok" ? serializeCatalog(records) : undefined;
  const existing = findCatalogRecordByMutation(records, prepared.record.mutationId);
  if (existing !== undefined) {
    if (!canonicalBytes(existing).equals(prepared.bytes)) throw new Error("catalog mutation replay conflict");
    await writeCatalog(leaves, workspaceId, expectedBody!, expectedBody, options);
    return "same";
  }
  if (records.length >= MAX_CATALOG_RECORDS_PER_WORKSPACE) throw new Error("catalog record count exceeds its cap");
  const next = [...records, prepared.record];
  validateCatalogGraph(next);
  await writeCatalog(leaves, workspaceId, serializeCatalog(next), expectedBody, options);
  return "created";
}
