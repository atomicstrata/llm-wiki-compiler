/**
 * @file src/indexed/backup-format.ts
 * @description The INDEXED-AUTHORITY BACKUP format: what a backup holds, how
 * it is parsed (strictly), which auxiliary files each store kind may carry,
 * and the prerequisite identities a restore must find unchanged.
 *
 * SCOPE, stated wherever a backup is made or restored: the backup holds ONLY
 * the indexed authority set. That is every store's manifest and the segments
 * it references, the event head anchor, and the incumbent files a store's
 * manifest binds as its legacy backup. It is not a wiki backup: Markdown pages
 * and sources, project config, workspace custody files, receipts and journals
 * are not included and are not checked.
 *
 * ALLOWLIST. Auxiliary paths are never taken from a manifest at face value:
 * each recognised store kind names its own (events: the event log file and
 * its head anchor; relations: the relation file; vectors: one of the two
 * embedding files; a workspace operation catalog: that workspace's catalog
 * file), and the manifest's legacy path must equal it. An unrecognised store
 * refuses the backup.
 *
 * LAYOUT. `<dir>/tree/` is PROJECT-SHAPED: `.llmwiki/indexed/<store>/` holds
 * each manifest and its segments, each present auxiliary file sits at its own
 * relative path, and each backed-up workspace has its directory, so the full
 * verifier can run on the captured cut itself (at backup and before any
 * restore effect). `<dir>/backup.json` is written LAST: a directory without
 * it is an incomplete backup and is never restorable.
 *
 * CAPS. At most {@link MAX_BACKUP_STORES} stores, {@link MAX_BACKUP_SEGMENTS}
 * segments and {@link MAX_BACKUP_TOTAL_BYTES} bytes of segments; each file
 * within its own cap (a segment, the manifest, its kind's auxiliary cap).
 */

import { createHash } from "node:crypto";
import { CSTATE_STORE, MAX_STATE_FILE_BYTES } from "../cstate/contracts.js";
import { legacyCatalogPath, OPERATION_CATALOG_STORE_PREFIX, operationCatalogStore } from "../history/operation-catalog.js";
import { MAX_CATALOG_FILE_BYTES } from "../operation-bundles/constants.js";
import { loadNonDefaultProfile } from "../profile/block.js";
import { MAX_SEGMENT_BYTES, STORE_NAME_PATTERN, type SegmentManifest } from "../segments/contracts.js";
import { SEGMENT_NAME_PATTERN } from "../segments/manifest.js";
import { MAX_BINARY_STORE_BYTES } from "../utils/embeddings-binary.js";
import {
  EMBEDDINGS_BINARY_FILE, EMBEDDINGS_FILE, EVENTS_FILE, EVENTS_HEAD_FILE, MAX_EMBEDDING_STORE_BYTES, MAX_EVENT_HEAD_BYTES, MAX_EVENT_STORE_BYTES,
  MAX_RELATION_STORE_BYTES, RELATIONS_FILE, STATE_FILE,
} from "../utils/constants.js";

const BACKUP_FORMAT = "llmwiki-indexed-authority-backup";
/** The index leaf, written last. */
export const BACKUP_INDEX = "backup.json";
const HEX64 = /^[0-9a-f]{64}$/;
/** Most stores, segments and segment bytes one backup may list. */
const MAX_BACKUP_STORES = 10_000;
const MAX_BACKUP_SEGMENTS = 1_000_000;
const MAX_BACKUP_TOTAL_BYTES = 256 * 1024 * 1024 * 1024;
/** The stores every indexed authority set must hold. */
export const REQUIRED_STORES: readonly string[] = ["catalog", "events", "relations", "vectors"];

/** One store in a backup. */
export interface BackupStoreV1 {
  readonly store: string;
  readonly manifestSha256: string;
  readonly segments: readonly { readonly name: string; readonly bytes: number; readonly sha256: string }[];
}

/** One auxiliary file in a backup: its bytes, or its recorded absence. */
export type BackupAuxV1 =
  | { readonly relPath: string; readonly state: "present"; readonly bytes: number; readonly sha256: string }
  | { readonly relPath: string; readonly state: "absent" };

/** The identities a restore must find unchanged (it never rebinds them). */
export interface BackupPrerequisitesV1 {
  readonly rootDigest: string;
  readonly scaleRecordSha256: string;
  /** The effective profile's digest, or `default`. */
  readonly profileDigest: string;
  /** Workspaces whose operation catalogs are backed up: each must exist as a directory. */
  readonly workspaces: readonly string[];
}

/** The backup index. */
export interface IndexedBackupV1 {
  readonly format: typeof BACKUP_FORMAT;
  readonly version: 1;
  readonly createdAt: string;
  readonly prerequisites: BackupPrerequisitesV1;
  readonly stores: readonly BackupStoreV1[];
  readonly auxiliary: readonly BackupAuxV1[];
}

/** One auxiliary path a store kind carries, with its read cap. */
export interface AllowedAux { readonly relPath: string; readonly cap: number }

/** SHA-256 hex of `value`. */
export function sha256Of(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

/** The legacy relPath a manifest binds, or undefined. */
function legacyPathOf(manifest: SegmentManifest): unknown {
  return (manifest.meta.legacy as { relPath?: unknown } | undefined)?.relPath;
}

/** Each single store kind's legacy file, and the auxiliary paths it carries. */
const SINGLE_STORE_AUX: readonly { readonly store: string; readonly legacy: string; readonly aux: readonly AllowedAux[] }[] = [
  { store: "events", legacy: EVENTS_FILE, aux: [{ relPath: EVENTS_FILE, cap: MAX_EVENT_STORE_BYTES }, { relPath: EVENTS_HEAD_FILE, cap: MAX_EVENT_HEAD_BYTES }] },
  { store: "relations", legacy: RELATIONS_FILE, aux: [{ relPath: RELATIONS_FILE, cap: MAX_RELATION_STORE_BYTES }] },
  { store: "vectors", legacy: EMBEDDINGS_FILE, aux: [{ relPath: EMBEDDINGS_FILE, cap: MAX_EMBEDDING_STORE_BYTES }] },
  { store: "vectors", legacy: EMBEDDINGS_BINARY_FILE, aux: [{ relPath: EMBEDDINGS_BINARY_FILE, cap: MAX_BINARY_STORE_BYTES }] },
  { store: CSTATE_STORE, legacy: STATE_FILE, aux: [{ relPath: STATE_FILE, cap: MAX_STATE_FILE_BYTES }] },
];

/** The fixed auxiliary paths of the single stores (and the segmented compile state's `state.json`), by kind. */
function singleStoreAux(store: string, legacy: unknown): AllowedAux[] | null {
  if (store === "catalog") return [];
  const kind = SINGLE_STORE_AUX.find((entry) => entry.store === store && entry.legacy === legacy);
  return kind === undefined ? null : [...kind.aux];
}

/**
 * The auxiliary paths `store` (with `manifest`) may carry in the project at
 * `root`, and its workspace for an operation catalog; throws for an
 * unrecognised store or a legacy path that is not the kind's own.
 */
export function allowedAuxiliary(root: string, store: string, manifest: SegmentManifest): { aux: AllowedAux[]; workspace?: string } {
  const legacy = legacyPathOf(manifest);
  const single = singleStoreAux(store, legacy);
  if (single !== null) return { aux: single };
  const workspace = (manifest.meta as { workspaceId?: unknown }).workspaceId;
  if (store.startsWith(OPERATION_CATALOG_STORE_PREFIX) && typeof workspace === "string" && operationCatalogStore(workspace) === store) {
    const relPath = legacyCatalogPath(root, workspace);
    if (legacy === relPath && relPath.startsWith(".llmwiki/workspaces/")) return { aux: [{ relPath, cap: MAX_CATALOG_FILE_BYTES }], workspace };
  }
  throw new Error(`store ${store} is not a recognised indexed store kind (or binds an unexpected legacy path); it cannot be backed up`);
}

/** The prerequisite identities of the project at canonical `root`, given its scale-record bytes and workspaces. */
export async function prerequisitesOf(root: string, scaleRecord: Buffer, workspaces: readonly string[]): Promise<BackupPrerequisitesV1> {
  const profile = await loadNonDefaultProfile(root);
  return { rootDigest: sha256Of(root), scaleRecordSha256: sha256Of(scaleRecord), profileDigest: profile === undefined ? "default" : profile.digest, workspaces: [...workspaces].sort() };
}

/** A parse failure: the backup is not one this build can restore. */
function invalid(why: string): never {
  throw new Error(`the backup index is invalid: ${why}`);
}

/** Whether `value` has exactly `keys`. */
function exactKeys(value: unknown, keys: string): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) && Object.keys(value).sort().join() === keys;
}

/** Whether `value` is a lowercase SHA-256 hex digest. */
const isHex64 = (value: unknown): boolean => typeof value === "string" && HEX64.test(value);
/** Whether `value` is a string matching `pattern`. */
const matches = (value: unknown, pattern: RegExp): boolean => typeof value === "string" && pattern.test(value);
/** Whether `value` is a safe integer from `min` to `max`. */
const intWithin = (value: unknown, min: number, max: number): boolean => typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;

/** Whether `segment` is a strictly valid segment entry. */
function isSegmentEntry(segment: unknown): boolean {
  return exactKeys(segment, "bytes,name,sha256") && matches(segment.name, SEGMENT_NAME_PATTERN) && intWithin(segment.bytes, 1, MAX_SEGMENT_BYTES) && isHex64(segment.sha256);
}

/** One strictly valid store entry. */
function parseStore(value: unknown): BackupStoreV1 {
  if (!exactKeys(value, "manifestSha256,segments,store") || !matches(value.store, STORE_NAME_PATTERN)) invalid("a store entry is malformed");
  const segments = Array.isArray(value.segments) && value.segments.length <= MAX_BACKUP_SEGMENTS;
  if (!isHex64(value.manifestSha256) || !segments) invalid(`store ${value.store as string} is malformed`);
  if (!(value.segments as unknown[]).every(isSegmentEntry)) invalid(`store ${value.store as string} lists a malformed segment`);
  return value as unknown as BackupStoreV1;
}

/** A relative POSIX path with no empty, `.` or `..` segment (it is joined under the tree and the project). */
function isSafeRelPath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512 && !value.startsWith("/") && value.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

/** Whether `value` is a strictly valid absent auxiliary entry. */
const isAbsentAux = (value: unknown): boolean => exactKeys(value, "relPath,state") && value.state === "absent" && isSafeRelPath(value.relPath);

/** Whether `value` is a strictly valid present auxiliary entry. */
function isPresentAux(value: unknown): boolean {
  return exactKeys(value, "bytes,relPath,sha256,state") && value.state === "present" && isSafeRelPath(value.relPath) && intWithin(value.bytes, 0, MAX_BINARY_STORE_BYTES) && isHex64(value.sha256);
}

/** One strictly valid auxiliary entry. */
function parseAux(value: unknown): BackupAuxV1 {
  if (!isAbsentAux(value) && !isPresentAux(value)) invalid("an auxiliary entry is malformed");
  return value as unknown as BackupAuxV1;
}

/** The prerequisites, strictly. */
function parsePrerequisites(value: unknown): BackupPrerequisitesV1 {
  const ok = exactKeys(value, "profileDigest,rootDigest,scaleRecordSha256,workspaces") && typeof value.rootDigest === "string" && HEX64.test(value.rootDigest)
    && typeof value.scaleRecordSha256 === "string" && HEX64.test(value.scaleRecordSha256) && typeof value.profileDigest === "string"
    && Array.isArray(value.workspaces) && value.workspaces.every((id) => typeof id === "string" && id.length > 0 && !id.includes("/") && !id.startsWith("."));
  if (!ok) invalid("the prerequisites are malformed");
  return value as unknown as BackupPrerequisitesV1;
}

/** Parse a backup index strictly; any deviation refuses. */
export function parseBackupIndex(bytes: Buffer): IndexedBackupV1 {
  let value: unknown;
  try { value = JSON.parse(bytes.toString("utf8")); } catch { invalid("it is not JSON"); }
  if (!exactKeys(value, "auxiliary,createdAt,format,prerequisites,stores,version") || value.format !== BACKUP_FORMAT || value.version !== 1) invalid("it is not a version 1 indexed-authority backup");
  if (!Array.isArray(value.stores) || value.stores.length > MAX_BACKUP_STORES || !Array.isArray(value.auxiliary)) invalid("its store or auxiliary list is malformed");
  const stores = value.stores.map(parseStore);
  if (new Set(stores.map((s) => s.store)).size !== stores.length) invalid("a store is listed twice");
  const segments = stores.reduce((sum, s) => sum + s.segments.length, 0);
  const segmentBytes = stores.reduce((sum, s) => sum + s.segments.reduce((total, segment) => total + segment.bytes, 0), 0);
  if (segments > MAX_BACKUP_SEGMENTS || segmentBytes > MAX_BACKUP_TOTAL_BYTES) invalid("it lists more segments or bytes than a backup may hold");
  const auxiliary = value.auxiliary.map(parseAux);
  if (new Set(auxiliary.map((a) => a.relPath)).size !== auxiliary.length) invalid("an auxiliary path is listed twice");
  return { format: BACKUP_FORMAT, version: 1, createdAt: String(value.createdAt), prerequisites: parsePrerequisites(value.prerequisites), stores, auxiliary };
}

/** Serialize a backup index (canonical key order). */
export function serializeBackupIndex(backup: Omit<IndexedBackupV1, "format" | "version">): Buffer {
  return Buffer.from(`${JSON.stringify({ format: BACKUP_FORMAT, version: 1, ...backup })}\n`);
}
