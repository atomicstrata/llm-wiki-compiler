/**
 * @file src/operation-bundles/key-epoch.ts
 * @description Distinct absent, unavailable, and healthy operation-key reads
 * plus the only empty-epoch key creation seam. Reads are confined, capped, and
 * no-follow; creation is lock-required by contract, durable, and mode 0600.
 */

import { randomBytes } from "node:crypto";
import { lstat } from "node:fs/promises";
import path from "node:path";
import { AtomicWriteCollisionError, atomicWriteNoReplaceDurable } from "../utils/atomic-write.js";
import { durableTempPath, durableWritingPath } from "../utils/atomic-write-no-replace-durable.js";
import { openConfinedLeaf, readWithinCapOrElse } from "../utils/confined-read.js";
import { operationKeyEpochId } from "./run-integrity.js";
import type { OperationDigest } from "./types.js";

const OPERATION_KEY_BYTES = 32;
const MAX_OPERATION_KEY_FILE_BYTES = 1_024;
const BASE64_KEY = /^[A-Za-z0-9+/]{43}=$/;

/** Count, byte total, and scan health for one active-epoch object class. */
export interface OperationEpochInventoryEntry { count: number; bytes: number; health: "ok" | "unavailable" }

export interface OperationEpochInventory {
  bundles: OperationEpochInventoryEntry;
  runs: OperationEpochInventoryEntry;
  payloads: OperationEpochInventoryEntry;
  evidence: OperationEpochInventoryEntry;
  cancelRequests: OperationEpochInventoryEntry;
  orphans: OperationEpochInventoryEntry;
}

/** Deterministic race seam used only by create-collision tests. */
export interface OperationKeyCreateOptions { beforePublishForTest?: () => Promise<void> }

export type OperationKeyRead =
  | { status: "absent" }
  | { status: "unavailable" }
  | { status: "ok"; key: Buffer; keyEpochId: OperationDigest };

/** Return the one project-global operation-key leaf. */
function operationKeyFile(root: string): string {
  return path.join(root, ".llmwiki", "operation-bundles.runkey");
}

/** Decode only the canonical base64 serialization of exactly 32 bytes. */
function decodeOperationKey(body: string): Buffer | null {
  if (!BASE64_KEY.test(body)) return null;
  const key = Buffer.from(body, "base64");
  if (key.length !== OPERATION_KEY_BYTES || key.toString("base64") !== body) return null;
  return key;
}

/** Read the operation key without creating directories or collapsing faults. */
export async function readOperationKey(root: string): Promise<OperationKeyRead> {
  const file = operationKeyFile(root);
  return readOperationKeyLeaf(root, file, durableTempPath(file));
}

/** Read one exact key-shaped leaf through the same confined key contract. */
async function readOperationKeyLeaf(root: string, file: string, reservedAlias?: string): Promise<OperationKeyRead> {
  const opened = await openConfinedLeaf(root, file, path.dirname(file));
  if (opened.kind === "absent") return { status: "absent" };
  if (opened.kind === "unavailable") return { status: "unavailable" };
  if (!healthyKeyMetadata(opened.mode, opened.uid) || !(await healthyKeyLinks(opened, reservedAlias))) {
    await opened.handle.close().catch(() => {});
    return { status: "unavailable" };
  }
  const read = await readWithinCapOrElse(opened, MAX_OPERATION_KEY_FILE_BYTES, () => ({ kind: "unavailable" as const }));
  if (read.kind !== "ok") return { status: "unavailable" };
  const key = decodeOperationKey(read.body);
  return key === null ? { status: "unavailable" } : { status: "ok", key, keyEpochId: operationKeyEpochId(key) };
}

/** Accept one stable link, or exactly one named protocol-owned companion alias. */
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
async function keyForEmptyEpochPublication(root: string): Promise<Buffer> {
  const file = operationKeyFile(root);
  const ready = await readOperationKeyLeaf(root, durableTempPath(file), durableWritingPath(file));
  if (ready.status === "unavailable") throw new Error("operation key recovery is unavailable");
  return ready.status === "ok" ? ready.key : randomBytes(OPERATION_KEY_BYTES);
}

/** Enforce mode 0600 and current ownership on POSIX hosts that expose uid. */
function healthyKeyMetadata(mode: number, uid: number): boolean {
  if (process.platform !== "win32" && (mode & 0o777) !== 0o600) return false;
  return typeof process.getuid !== "function" || uid === process.getuid();
}

/** Require the exact six-part active inventory and prove every byte count is zero. */
function assertEmptyEpochInventory(inventory: OperationEpochInventory): void {
  const expected = ["bundles", "runs", "payloads", "evidence", "cancelRequests", "orphans"];
  const keys = Object.keys(inventory);
  if (keys.length !== expected.length || keys.some((key) => !expected.includes(key))) {
    throw new Error("operation key creation requires an exact empty epoch inventory");
  }
  for (const key of expected) {
    if (!emptyHealthyEntry(inventory[key as keyof OperationEpochInventory])) {
      throw new Error("operation key creation requires an empty epoch inventory");
    }
  }
}

/** Validate the exact entry shape before interpreting zero byte totals. */
function emptyHealthyEntry(value: unknown): boolean {
  if (!inventoryEntryShape(value)) return false;
  return zeroHealthyEntry(value);
}

/** Recognize only the three exact inventory-entry fields. */
function inventoryEntryShape(value: unknown): value is Partial<OperationEpochInventoryEntry> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length === 3 && ["count", "bytes", "health"].every((key) => keys.includes(key));
}

/** Require healthy scanning plus exact zero count and byte totals. */
function zeroHealthyEntry(entry: Partial<OperationEpochInventoryEntry>): boolean {
  if (entry.health !== "ok" || !Number.isSafeInteger(entry.count) || !Number.isSafeInteger(entry.bytes)) return false;
  return entry.count === 0 && entry.bytes === 0;
}

/** Reconcile any crash-left aliases before reporting an existing healthy key. */
async function refuseExistingKeyEpoch(root: string, key: Buffer): Promise<never> {
  try {
    await atomicWriteNoReplaceDurable(operationKeyFile(root), key.toString("base64"), {
      confineRoot: root, exactParent: true, mode: 0o600,
    });
  } catch (error) {
    if (error instanceof AtomicWriteCollisionError) throw new Error("operation key epoch already exists");
    throw error;
  }
  throw new Error("operation key epoch already exists");
}

/** Mint the first key only after the caller's under-lock inventory proves emptiness. */
export async function createOperationKeyForEmptyEpochLocked(
  root: string,
  inventory: OperationEpochInventory,
  options: OperationKeyCreateOptions = {},
): Promise<{ key: Buffer; keyEpochId: OperationDigest }> {
  assertEmptyEpochInventory(inventory);
  const file = operationKeyFile(root);
  const current = await readOperationKeyLeaf(root, file, durableTempPath(file));
  if (current.status === "unavailable") throw new Error("operation key is unavailable");
  if (current.status === "ok") return refuseExistingKeyEpoch(root, current.key);
  const key = await keyForEmptyEpochPublication(root);
  await options.beforePublishForTest?.();
  try {
    await atomicWriteNoReplaceDurable(operationKeyFile(root), key.toString("base64"), {
      confineRoot: root, exactParent: true, mode: 0o600,
    });
  } catch (error) {
    if (error instanceof AtomicWriteCollisionError) {
      const collision = await readOperationKey(root);
      throw new Error(`operation key creation collision: ${collision.status}`);
    }
    throw error;
  }
  return { key, keyEpochId: operationKeyEpochId(key) };
}
