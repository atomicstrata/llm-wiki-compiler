/**
 * @file src/operation-bundles/catalog-store.ts
 * @description Founding authority for the workspace catalog. Logical append is
 * implemented as a complete confined read, closed-record validation, canonical
 * in-memory append, and strictly durable whole-file replacement. This module
 * never uses O_APPEND and never treats an unreadable catalog as empty.
 */

import { TextDecoder } from "node:util";
import { isSafeFilenameComponent } from "../profile/identity.js";
import { canonicalBytes, canonicalDigest } from "../profile/templates/signing/canonical.js";
import { parseBoundedUniqueJson } from "../profile/templates/signing/json.js";
import { atomicWrite, type AtomicWriteOptions } from "../utils/atomic-write.js";
import { readConfinedLeafBuffer } from "../utils/confined-read.js";
import {
  MAX_CATALOG_FILE_BYTES,
  MAX_CATALOG_RECORD_BYTES,
  MAX_CATALOG_RECORDS_PER_WORKSPACE,
} from "./constants.js";
import {
  assertCatalogRecordId, assertMutationId, catalogRecordId,
  type CatalogRecordId, type MutationId,
} from "./ids.js";
import { digest, exact, record, textValue, timestamp } from "./manifest-values.js";
import { operationPaths } from "./paths.js";
import type { OperationDataValue, OperationDigest } from "./types.js";

const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

/** One closed canonical catalog history record. */
export interface CatalogRecord {
  schemaVersion: 1;
  physicalRecordId: CatalogRecordId;
  logicalRecordId: string;
  mutationId: MutationId;
  payloadDigest: OperationDigest;
  payload: OperationDataValue;
  supersedesRecordId?: CatalogRecordId;
  createdAt: string;
}

/** Host input whose derived fields are reconstructed by the catalog store. */
export interface CatalogRecordInput {
  logicalRecordId: string;
  mutationId: MutationId;
  payload: unknown;
  supersedesRecordId?: CatalogRecordId;
  createdAt: string;
}

export type CatalogStoreRead =
  | { status: "absent" }
  | { status: "ok"; records: readonly CatalogRecord[] }
  | { status: "invalid"; detail: string }
  | { status: "unavailable"; detail: string };

export type CatalogAppendResult = "created" | "same";

/** Exact pre-publication catalog state no longer matches the locked plan. */
export class CatalogConcurrentChangeError extends Error {
  constructor() {
    super("catalog changed concurrently before publication");
    this.name = "CatalogConcurrentChangeError";
  }
}

/** Test-only strict durability seam inherited from the shared atomic writer. */
export type CatalogWriteOptions = Pick<AtomicWriteOptions,
  "afterParentCheckForTest" | "beforeDirectorySyncForTest">;

/** Rebuild arbitrary bounded JSON data through the canonical parser. */
function rebuildPayload(value: unknown): OperationDataValue {
  const bytes = canonicalBytes(value);
  if (bytes.byteLength > MAX_CATALOG_RECORD_BYTES) throw new Error("catalog payload exceeds its record cap");
  return parseBoundedUniqueJson(bytes.toString("utf8"), MAX_CATALOG_RECORD_BYTES) as OperationDataValue;
}

/** Require the store-local logical identity grammar. */
function logicalRecordId(value: unknown): string {
  const parsed = textValue(value, "catalog logicalRecordId");
  if (!isSafeFilenameComponent(parsed)) throw new Error("catalog logicalRecordId is invalid");
  return parsed;
}

/** Parse one exact-shape record and recompute every derived claim. */
function parseCatalogRecord(value: unknown): CatalogRecord {
  const item = record(value, "catalog record");
  exact(item, [
    "schemaVersion", "physicalRecordId", "logicalRecordId", "mutationId",
    "payloadDigest", "payload", "createdAt",
  ], ["supersedesRecordId"]);
  if (item.schemaVersion !== 1) throw new Error("catalog schemaVersion is unsupported");
  const mutationId = assertMutationId(item.mutationId);
  const payload = rebuildPayload(item.payload), payloadDigest = digest(item.payloadDigest, "catalog payloadDigest");
  if (payloadDigest !== canonicalDigest(payload)) throw new Error("catalog payload digest mismatch");
  const id = assertCatalogRecordId(item.physicalRecordId);
  if (id !== catalogRecordId(mutationId)) throw new Error("catalog physicalRecordId is not deterministic");
  const prior = item.supersedesRecordId === undefined
    ? undefined : assertCatalogRecordId(item.supersedesRecordId);
  return {
    schemaVersion: 1, physicalRecordId: id, logicalRecordId: logicalRecordId(item.logicalRecordId),
    mutationId, payloadDigest, payload,
    ...(prior === undefined ? {} : { supersedesRecordId: prior }),
    createdAt: timestamp(item.createdAt),
  };
}

/** Canonicalize, cap, and reparse a record before it can reach a write. */
function normalizeCatalogRecord(value: CatalogRecord): { record: CatalogRecord; bytes: Buffer } {
  const bytes = canonicalBytes(value);
  if (bytes.byteLength > MAX_CATALOG_RECORD_BYTES) throw new Error("catalog record exceeds its record cap");
  const parsed = parseCatalogRecord(parseBoundedUniqueJson(bytes.toString("utf8"), MAX_CATALOG_RECORD_BYTES));
  return { record: parsed, bytes: canonicalBytes(parsed) };
}

/** Construct one closed record while deriving its digest and physical identity. */
export function createCatalogRecord(input: CatalogRecordInput): CatalogRecord {
  assertMutationId(input.mutationId);
  const payload = rebuildPayload(input.payload);
  return normalizeCatalogRecord({
    schemaVersion: 1,
    physicalRecordId: catalogRecordId(input.mutationId),
    logicalRecordId: logicalRecordId(input.logicalRecordId),
    mutationId: input.mutationId,
    payloadDigest: canonicalDigest(payload) as OperationDigest,
    payload,
    ...(input.supersedesRecordId === undefined ? {} : { supersedesRecordId: input.supersedesRecordId }),
    createdAt: input.createdAt,
  }).record;
}

/** Parse canonical one-record-per-line bytes without accepting a torn tail. */
function parseCatalogBytes(body: Buffer): CatalogRecord[] {
  const lineEnds = scanCatalogLineEnds(body);
  if (body.length === 0 || lineEnds.at(-1) !== body.length - 1) {
    throw new Error("catalog has a torn or empty tail");
  }
  const records: CatalogRecord[] = [];
  let start = 0;
  for (const end of lineEnds) {
    records.push(parseCatalogLine(body.subarray(start, end)));
    start = end + 1;
  }
  validateCatalogGraph(records);
  return records;
}

/** Scan byte terminators incrementally and stop at the first over-cap line. */
function scanCatalogLineEnds(body: Buffer): number[] {
  const lineEnds: number[] = [];
  for (let index = 0; index < body.length; index += 1) {
    if (body[index] !== 0x0a) continue;
    if (lineEnds.length >= MAX_CATALOG_RECORDS_PER_WORKSPACE) {
      throw new Error("catalog record count exceeds its cap");
    }
    lineEnds.push(index);
  }
  return lineEnds;
}

/** Require one line to already be the canonical bytes for its parsed record. */
function parseCatalogLine(line: Buffer): CatalogRecord {
  if (line.byteLength > MAX_CATALOG_RECORD_BYTES) {
    throw new Error("catalog record exceeds its record cap");
  }
  const parsed = parseCatalogRecord(parseBoundedUniqueJson(
    UTF8_DECODER.decode(line), MAX_CATALOG_RECORD_BYTES,
  ));
  if (!canonicalBytes(parsed).equals(line)) {
    throw new Error("catalog record is not canonical JSON");
  }
  return parsed;
}

/** Reject duplicate physical and mutation identities. */
function assertCatalogIdentityUnique(
  item: CatalogRecord,
  byId: ReadonlyMap<CatalogRecordId, CatalogRecord>,
  mutations: ReadonlySet<MutationId>,
): void {
  if (byId.has(item.physicalRecordId)) throw new Error("catalog has duplicate physical identity");
  if (mutations.has(item.mutationId)) throw new Error("catalog has duplicate mutation identity");
}

/** Validate one append-ordered root or supersession edge. */
function validateCatalogLineage(
  item: CatalogRecord,
  byId: ReadonlyMap<CatalogRecordId, CatalogRecord>,
  roots: Set<string>,
  successors: Set<CatalogRecordId>,
): void {
  if (item.supersedesRecordId === undefined) {
    if (roots.has(item.logicalRecordId)) throw new Error("catalog logical identity has a root fork");
    roots.add(item.logicalRecordId);
    return;
  }
  const predecessor = byId.get(item.supersedesRecordId);
  if (predecessor === undefined) {
    throw new Error("catalog predecessor is missing, forms a cycle, or is out of order");
  }
  if (predecessor.logicalRecordId !== item.logicalRecordId) throw new Error("catalog supersession changes logical identity");
  if (successors.has(predecessor.physicalRecordId)) throw new Error("catalog supersession fork detected");
  successors.add(predecessor.physicalRecordId);
}

/** Validate uniqueness and append-ordered supersession in one linear pass. */
function validateCatalogGraph(records: readonly CatalogRecord[]): void {
  const byId = new Map<CatalogRecordId, CatalogRecord>();
  const mutations = new Set<MutationId>(), successors = new Set<CatalogRecordId>();
  const roots = new Set<string>();
  for (const item of records) {
    assertCatalogIdentityUnique(item, byId, mutations);
    validateCatalogLineage(item, byId, roots, successors);
    byId.set(item.physicalRecordId, item);
    mutations.add(item.mutationId);
  }
}

/** Read, confine, parse, and validate the complete catalog without side effects. */
export async function readCatalogStore(root: string, workspaceId: string): Promise<CatalogStoreRead> {
  let read: Awaited<ReturnType<typeof readConfinedLeafBuffer>>;
  try {
    const paths = operationPaths(root, workspaceId);
    read = await readConfinedLeafBuffer(root, paths.catalogFile, paths.workspaceRoot, MAX_CATALOG_FILE_BYTES, {
      requireSingleLink: true,
    });
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
  root: string,
  workspaceId: string,
  body: Buffer,
  expectedBody: Buffer | undefined,
  options: CatalogWriteOptions,
): Promise<void> {
  const paths = operationPaths(root, workspaceId);
  const { afterParentCheckForTest, ...writeOptions } = options;
  await atomicWrite(paths.catalogFile, body, {
    confineRoot: root, exactParent: true, durable: true, strictDurability: true, mode: 0o600,
    ...writeOptions,
    afterParentCheckForTest: async () => {
      await afterParentCheckForTest?.();
      await assertCatalogUnchanged(root, workspaceId, expectedBody);
    },
  });
}

/** Re-read canonical state at the atomic writer's last public pre-write seam. */
async function assertCatalogUnchanged(
  root: string,
  workspaceId: string,
  expectedBody: Buffer | undefined,
): Promise<void> {
  const current = await readCatalogStore(root, workspaceId);
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
  const prepared = normalizeCatalogRecord(candidate), read = await readCatalogStore(root, workspaceId);
  if (read.status === "unavailable" || read.status === "invalid") {
    throw new Error(`catalog is ${read.status}: ${read.detail}`);
  }
  const records = read.status === "ok" ? [...read.records] : [];
  const expectedBody = read.status === "ok" ? serializeCatalog(records) : undefined;
  const existing = findCatalogRecordByMutation(records, prepared.record.mutationId);
  if (existing !== undefined) {
    if (!canonicalBytes(existing).equals(prepared.bytes)) throw new Error("catalog mutation replay conflict");
    await writeCatalog(root, workspaceId, expectedBody!, expectedBody, options);
    return "same";
  }
  if (records.length >= MAX_CATALOG_RECORDS_PER_WORKSPACE) throw new Error("catalog record count exceeds its cap");
  const next = [...records, prepared.record];
  validateCatalogGraph(next);
  await writeCatalog(root, workspaceId, serializeCatalog(next), expectedBody, options);
  return "created";
}
