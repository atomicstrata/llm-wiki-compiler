/**
 * @file src/preparations/key-epoch.ts
 * @description Distinct absent, unavailable, and healthy preparation-key reads
 * plus the only empty-epoch key creation seam (design section 12.1). Reads are
 * confined, capped, no-follow, and never create, repair, or replace state.
 * Creation mints exactly one 32-byte key under the project lock, only after the
 * caller's under-lock inventory proves the complete preparation namespace empty,
 * durably and mode 0600. It is a TWO-STEP seam: minting the key in memory is
 * separated from writing it, so a caller that must preflight against the real
 * epoch id can still refuse without having touched the project. The preparation
 * and Milestone A key epochs are separate.
 */

import { randomBytes } from "node:crypto";
import { lstat } from "node:fs/promises";
import { AtomicWriteCollisionError, atomicWriteNoReplaceDurable } from "../utils/atomic-write.js";
import { durableTempPath, durableWritingPath } from "../utils/atomic-write-no-replace-durable.js";
import { openConfinedLeaf, readWithinCapOrElse } from "../utils/confined-read.js";
import path from "node:path";
import { MAX_PREPARATION_KEY_FILE_BYTES } from "./constants.js";
import { preparationKeyEpochId } from "./run-integrity.js";
import { preparationKeyFile } from "./paths.js";
import type { Sha256Digest } from "./types.js";

const PREPARATION_KEY_BYTES = 32;
const BASE64_KEY = /^[A-Za-z0-9+/]{43}=$/;

/** Count, byte total, and scan health for one active-epoch object class. */
export interface PreparationEpochInventoryEntry { count: number; bytes: number; health: "ok" | "unavailable" }

/** The exact preparation active-epoch object classes (design section 8.4). */
export interface PreparationEpochInventory {
  manifests: PreparationEpochInventoryEntry;
  runs: PreparationEpochInventoryEntry;
  evidence: PreparationEpochInventoryEntry;
  cancelRequests: PreparationEpochInventoryEntry;
  orphans: PreparationEpochInventoryEntry;
}

/** Deterministic race seam used only by create-collision tests. */
export interface PreparationKeyCreateOptions { beforePublishForTest?: () => Promise<void> }

export type PreparationKeyRead =
  | { status: "absent" }
  | { status: "unavailable" }
  | { status: "ok"; key: Buffer; keyEpochId: Sha256Digest };

/** Decode only the canonical base64 serialization of exactly 32 bytes. */
export function decodePreparationKey(body: string): Buffer | null {
  if (!BASE64_KEY.test(body)) return null;
  const key = Buffer.from(body, "base64");
  if (key.length !== PREPARATION_KEY_BYTES || key.toString("base64") !== body) return null;
  return key;
}

/** Read the preparation key without creating directories or collapsing faults. */
export async function readPreparationKey(root: string): Promise<PreparationKeyRead> {
  const file = preparationKeyFile(root);
  return readPreparationKeyLeaf(root, file, durableTempPath(file));
}

/** Read one exact key-shaped leaf through the same confined key contract. */
async function readPreparationKeyLeaf(root: string, file: string, reservedAlias?: string): Promise<PreparationKeyRead> {
  const opened = await openConfinedLeaf(root, file, path.dirname(file));
  switch (opened.kind) {
    case "absent": return { status: "absent" };
    case "unavailable": return { status: "unavailable" };
    case "confirmed": break;
  }
  const metadataHealthy = healthyKeyMetadata(opened.mode, opened.uid);
  const linksHealthy = await healthyKeyLinks(opened, reservedAlias);
  if (metadataHealthy && linksHealthy) return readHealthyPreparationKey(opened);
  await opened.handle.close().catch(() => {});
  return { status: "unavailable" };
}

/** Decode and identify one opened key whose metadata is already trusted. */
async function readHealthyPreparationKey(
  opened: Extract<Awaited<ReturnType<typeof openConfinedLeaf>>, { kind: "confirmed" }>,
): Promise<PreparationKeyRead> {
  const key = await readOpenedPreparationKey(opened);
  return key === null ? { status: "unavailable" } : { status: "ok", key, keyEpochId: preparationKeyEpochId(key) };
}

/**
 * Decode one already-confined key handle through the existing canonical codec.
 * The handle is always closed, and no caller-supplied pathname is consulted.
 */
export async function readOpenedPreparationKey(
  opened: Extract<Awaited<ReturnType<typeof openConfinedLeaf>>, { kind: "confirmed" }>,
): Promise<Buffer | null> {
  const read = await readWithinCapOrElse(opened, MAX_PREPARATION_KEY_FILE_BYTES, () => ({ kind: "unavailable" as const }));
  return read.kind === "ok" ? decodePreparationKey(read.body) : null;
}

/** Accept one stable link, or exactly one named protocol-owned companion alias. */
// fallow-ignore-next-line code-duplication
async function healthyKeyLinks(
  opened: Extract<Awaited<ReturnType<typeof openConfinedLeaf>>, { kind: "confirmed" }>,
  reservedAlias: string | undefined,
): Promise<boolean> {
  if (opened.nlink === 1) return true;
  if (opened.nlink !== 2 || reservedAlias === undefined) return false;
  const alias = await lstat(reservedAlias).catch(() => null);
  return alias !== null && alias.isFile() && !alias.isSymbolicLink()
    && alias.dev === opened.dev && alias.ino === opened.ino;
}

/** Reuse a synced ready-only crash key; incomplete scratch bytes are disposable. */
// fallow-ignore-next-line code-duplication
async function keyForEmptyEpochPublication(root: string): Promise<Buffer> {
  const file = preparationKeyFile(root);
  const ready = await readPreparationKeyLeaf(root, durableTempPath(file), durableWritingPath(file));
  if (ready.status === "unavailable") throw new Error("preparation key recovery is unavailable");
  return ready.status === "ok" ? ready.key : randomBytes(PREPARATION_KEY_BYTES);
}

/** Enforce mode 0600 and current ownership on POSIX hosts that expose uid. */
// fallow-ignore-next-line code-duplication
function healthyKeyMetadata(mode: number, uid: number): boolean {
  if (process.platform !== "win32" && (mode & 0o777) !== 0o600) return false;
  return typeof process.getuid !== "function" || uid === process.getuid();
}

/** Require the exact five-part active inventory and prove every byte count is zero. */
function assertEmptyEpochInventory(inventory: PreparationEpochInventory): void {
  const expected = ["manifests", "runs", "evidence", "cancelRequests", "orphans"];
  const keys = Object.keys(inventory);
  if (keys.length !== expected.length || keys.some((key) => !expected.includes(key))) {
    throw new Error("preparation key creation requires an exact empty epoch inventory");
  }
  for (const key of expected) {
    if (!emptyHealthyEntry(inventory[key as keyof PreparationEpochInventory])) {
      throw new Error("preparation key creation requires an empty epoch inventory");
    }
  }
}

/** Recognize only the three exact inventory-entry fields. */
function inventoryEntryShape(value: unknown): value is Partial<PreparationEpochInventoryEntry> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return Object.keys(value).sort().join("\0") === "bytes\0count\0health";
}

/** Require healthy scanning plus exact zero count and byte totals. */
function zeroHealthyEntry(entry: Partial<PreparationEpochInventoryEntry>): boolean {
  if (entry.health !== "ok" || !Number.isSafeInteger(entry.count) || !Number.isSafeInteger(entry.bytes)) return false;
  return entry.count === 0 && entry.bytes === 0;
}

/** Validate the exact entry shape before interpreting zero byte totals. */
function emptyHealthyEntry(value: unknown): boolean {
  return inventoryEntryShape(value) && zeroHealthyEntry(value);
}

/** Reconcile any crash-left aliases before reporting an existing healthy key. */
async function refuseExistingKeyEpoch(root: string, key: Buffer): Promise<never> {
  try {
    await atomicWriteNoReplaceDurable(preparationKeyFile(root), key.toString("base64"), {
      confineRoot: root, exactParent: true, mode: 0o600,
    });
  } catch (error) {
    if (error instanceof AtomicWriteCollisionError) throw new Error("preparation key epoch already exists");
    throw error;
  }
  throw new Error("preparation key epoch already exists");
}

/**
 * A first key epoch minted in memory, plus the durable write it still owes.
 *
 * The raw key material is deliberately NOT a field. The publication closure
 * retains everything it needs, so no caller has to hold secret bytes to finish
 * preflighting, and the epoch id is the only identity any of them consult.
 */
export interface PreparedPreparationKey {
  keyEpochId: Sha256Digest;
  publish(): Promise<void>;
}

/** Durably create the minted key, failing closed on any concurrent creation. */
async function publishPreparedKey(
  root: string, key: Buffer, options: PreparationKeyCreateOptions,
): Promise<void> {
  await options.beforePublishForTest?.();
  try {
    await atomicWriteNoReplaceDurable(preparationKeyFile(root), key.toString("base64"), {
      confineRoot: root, exactParent: true, mode: 0o600,
    });
  } catch (error) {
    if (error instanceof AtomicWriteCollisionError) {
      const collision = await readPreparationKey(root);
      throw new Error(`preparation key creation collision: ${collision.status}`);
    }
    throw error;
  }
}

/**
 * Mint the first key IN MEMORY once the caller's under-lock inventory proves the
 * namespace empty, and hand back the durable publication as a separate step.
 *
 * Splitting them lets a caller finish preflighting against the real epoch id
 * without having written anything, so a refusal raised between the two leaves the
 * project exactly as it found it. On the path that returns, nothing is created,
 * repaired, or replaced: the emptiness proof and the crash-key recovery read are
 * both read-only. The existing-key refusal is the one exception and does NOT
 * return — it reconciles a crash-left protocol-owned alias before throwing, and
 * is reachable only on a project that already has a key, which by definition has
 * nothing left to preserve.
 *
 * The window this opens between reading the current leaf and writing is not a
 * weakening. Creation is already under the project lock, and the authoritative
 * guard was never that read — it is `atomicWriteNoReplaceDurable`, which cannot
 * replace an existing leaf and turns any concurrent creation into a collision.
 */
export async function prepareKeyForEmptyEpochLocked(
  root: string,
  inventory: PreparationEpochInventory,
  options: PreparationKeyCreateOptions = {},
): Promise<PreparedPreparationKey> {
  assertEmptyEpochInventory(inventory);
  const file = preparationKeyFile(root);
  const current = await readPreparationKeyLeaf(root, file, durableTempPath(file));
  if (current.status === "unavailable") throw new Error("preparation key is unavailable");
  if (current.status === "ok") return refuseExistingKeyEpoch(root, current.key);
  const key = await keyForEmptyEpochPublication(root);
  return {
    keyEpochId: preparationKeyEpochId(key), publish: () => publishPreparedKey(root, key, options),
  };
}
