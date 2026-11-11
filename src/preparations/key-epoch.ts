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
 *
 * ONE KEY READ, OVER THE READER'S OWN LEAF. What makes bytes a key is decided in
 * one body, `readPreparationKeyFrom`: the cap it asks for, the canonical base64
 * of exactly 32 bytes, the epoch derived from those bytes, and the three
 * statuses. It takes `PreparationKeyLeafReads` and no project root or path. The
 * root-named readers, and the creation and recovery reads below, keep their
 * signatures and reach that body over the private local-disk leaf, built on
 * each call. What the local disk adds stays on the disk side and is unchanged:
 * the confined no-follow open, owner and mode, the link count against the one
 * reserved alias, and the capped handle-bound read. The lifecycle observation's
 * `readOpenedPreparationKey` still takes an open file handle and is NOT bound
 * here; it shares only the codec. Nothing here selects a backend.
 *
 * ONE CREATE-OR-REFUSE BODY. {@link prepareKeyForEmptyEpochLockedWith} decides
 * the empty-epoch creation over {@link PreparationKeyCreateSteps}, none of which
 * takes a project root: the exact empty inventory, the unavailable / ok / absent
 * policy for the current key, reuse of a synced crash-ready key, and (in the
 * publication it hands back) the collision re-read. Minting fresh bytes and the
 * durable no-replace write stay MECHANISM. The root form keeps its signature and
 * builds the local steps per call.
 */

import { durableTempPath, durableWritingPath } from "../utils/atomic-write-no-replace-durable.js";
import { openConfinedLeaf, readWithinCapOrElse, type CappedLeafRead, type ConfirmedLeafOpen } from "../utils/confined-read.js";
import { healthyKeyLinks, healthyKeyMetadata, publishKeyLeafNoReplace, recoveredEpochKey } from "../utils/key-leaf-health.js";
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

/**
 * What the key read asks of the store. Owned by the key reader; the read takes
 * no project root and no path.
 */
export interface PreparationKeyLeafReads {
  /**
   * The key leaf's text within `maxBytes`, from a leaf the store vouches for.
   * `absent` is a store with no key leaf. `unavailable` is a leaf that exists
   * and may not be trusted or read: on the local disk that is confinement, the
   * no-follow open, owner and mode, the link count and the byte cap. May
   * reject; the body catches nothing.
   */
  readKeyLeaf(maxBytes: number): Promise<CappedLeafRead>;
}

/**
 * The local-disk key leaf for one exact file. Private, and built per call: the
 * closure opens and checks the leaf when it is asked, never earlier.
 */
function diskPreparationKeyLeafReads(root: string, file: string, reservedAlias?: string): PreparationKeyLeafReads {
  return { readKeyLeaf: (maxBytes) => readHealthyKeyLeafText(root, file, reservedAlias, maxBytes) };
}

/**
 * The local-disk leaf of the project's CURRENT key: the key file, with its
 * durable temp path as the one reserved alias. WHICH FILE THAT IS IS STATED
 * ONCE, HERE. Building it does no path work and no I/O: the path is derived
 * when the leaf is asked for, never earlier. Exported for the store's leaf
 * composition (`store-leaf-reads.ts`) only; in no package index.
 */
export function diskCurrentPreparationKeyLeafReads(root: string): PreparationKeyLeafReads {
  return { readKeyLeaf: (maxBytes) => {
    const file = preparationKeyFile(root);
    return diskPreparationKeyLeafReads(root, file, durableTempPath(file)).readKeyLeaf(maxBytes);
  } };
}

/** Read the preparation key without creating directories or collapsing faults. */
export async function readPreparationKey(root: string): Promise<PreparationKeyRead> {
  return readPreparationKeyFrom(diskCurrentPreparationKeyLeafReads(root));
}

/**
 * {@link readPreparationKey} over the reader's own leaf: the one body. It asks
 * for the leaf under the key cap, then decodes the canonical 32-byte key and
 * derives its epoch HERE. A leaf that does not decode is `unavailable`, the
 * same answer as a leaf the store refused. It confines nothing and checks no
 * owner, mode or link: an in-memory leaf is trusted exactly as far as whoever
 * supplied it.
 */
export async function readPreparationKeyFrom(leaves: PreparationKeyLeafReads): Promise<PreparationKeyRead> {
  const leaf = await leaves.readKeyLeaf(MAX_PREPARATION_KEY_FILE_BYTES);
  if (leaf.kind === "absent") return { status: "absent" };
  if (leaf.kind === "unavailable") return { status: "unavailable" };
  const key = decodePreparationKey(leaf.body);
  return key === null ? { status: "unavailable" } : { status: "ok", key, keyEpochId: preparationKeyEpochId(key) };
}

/** What a reader that needs only the key's epoch learns: its status and epoch, NEVER the key bytes. */
export type PreparationKeyEpochRead =
  | { status: "absent" }
  | { status: "unavailable" }
  | { status: "ok"; keyEpochId: Sha256Digest };

/**
 * Read the preparation key and hand on its epoch WITHOUT the key bytes, for a
 * consumer that only binds or classifies by epoch. One {@link readPreparationKey}
 * call per call, nothing cached and nothing caught: the same statuses and the
 * same rejection come back.
 */
export async function readPreparationKeyEpoch(root: string): Promise<PreparationKeyEpochRead> {
  return epochWithoutKeyBytes(await readPreparationKey(root));
}

/** {@link readPreparationKeyEpoch} over the reader's own leaf: one {@link readPreparationKeyFrom} call, the same projection. */
export async function readPreparationKeyEpochFrom(leaves: PreparationKeyLeafReads): Promise<PreparationKeyEpochRead> {
  return epochWithoutKeyBytes(await readPreparationKeyFrom(leaves));
}

/** A key read's status and epoch, with the key bytes left behind. */
function epochWithoutKeyBytes(key: PreparationKeyRead): PreparationKeyEpochRead {
  // A NEW OBJECT, BY NAME. The ok answer carries the key bytes; a spread or the
  // whole result would hand them to a caller that asked only for the epoch. The
  // two non-ok answers hold no bytes and are returned as they are.
  return key.status === "ok" ? { status: "ok", keyEpochId: key.keyEpochId } : key;
}

/** Read one exact key-shaped leaf through the same confined key contract. */
async function readPreparationKeyLeaf(root: string, file: string, reservedAlias?: string): Promise<PreparationKeyRead> {
  return readPreparationKeyFrom(diskPreparationKeyLeafReads(root, file, reservedAlias));
}

/**
 * One confined key leaf's text, or why not: the local disk's half of the key
 * read. The no-follow confined open, then owner and mode, then the link count
 * against the one reserved alias, then the capped handle-bound read. BOTH
 * health checks run before either is acted on, so the link check still runs on
 * a leaf whose owner or mode is already wrong. The handle is closed on every
 * path. It decodes nothing and knows no key size.
 */
async function readHealthyKeyLeafText(
  root: string, file: string, reservedAlias: string | undefined, maxBytes: number,
): Promise<CappedLeafRead> {
  const opened = await openConfinedLeaf(root, file, path.dirname(file));
  if (opened.kind !== "confirmed") return opened;
  const metadataHealthy = healthyKeyMetadata(opened.mode, opened.uid);
  const linksHealthy = await healthyKeyLinks(opened, reservedAlias);
  if (metadataHealthy && linksHealthy) return readWithinCapOrElse(opened, maxBytes, () => ({ kind: "unavailable" as const }));
  await opened.handle.close().catch(() => {});
  return { kind: "unavailable" };
}

/**
 * Decode one already-confined key handle through the existing canonical codec.
 * The handle is always closed, and no caller-supplied pathname is consulted.
 */
export async function readOpenedPreparationKey(
  opened: ConfirmedLeafOpen,
): Promise<Buffer | null> {
  const read = await readWithinCapOrElse(opened, MAX_PREPARATION_KEY_FILE_BYTES, () => ({ kind: "unavailable" as const }));
  return read.kind === "ok" ? decodePreparationKey(read.body) : null;
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

/** What empty-epoch key creation asks of the store. No member takes a project root. */
export interface PreparationKeyCreateSteps {
  /** The current key, read as any reader reads it (also the collision re-read). */
  readCurrentKey(): Promise<PreparationKeyRead>;
  /** A synced ready-only crash key an interrupted publication left, read through the same key contract. */
  readCrashReadyKey(): Promise<PreparationKeyRead>;
  /** MECHANISM: durably publish `key` without replacing one; `collision` when one is there. Any other fault THROWS. */
  publishKey(key: Buffer): Promise<"created" | "collision">;
}

/**
 * LOCAL DISK. The current and crash-ready key leaves and the no-replace write for
 * `root`, each reached when asked. `heldCurrentKey`, when given, is the caller's
 * own read of the current key in the same hold of the lock: it answers the read
 * BEFORE publication, which nothing between it and the caller's read wrote. The
 * collision re-read comes after the publication attempt, so it reaches the disk.
 */
function diskPreparationKeyCreateSteps(root: string, heldCurrentKey?: () => Promise<PreparationKeyRead>): PreparationKeyCreateSteps {
  let beforePublication = heldCurrentKey;
  return {
    readCurrentKey: () => {
      const read = beforePublication ?? (() => readPreparationKey(root));
      beforePublication = undefined;
      return read();
    },
    readCrashReadyKey: () => {
      const file = preparationKeyFile(root);
      return readPreparationKeyLeaf(root, durableTempPath(file), durableWritingPath(file));
    },
    publishKey: (key) => publishKeyLeafNoReplace(root, preparationKeyFile(root), key),
  };
}

/** The reads over the key reader's own body, with the caller's publication mechanism. Building it does no I/O. */
export function preparationKeyCreateStepsOver(
  leaves: { current: PreparationKeyLeafReads; crashReady: PreparationKeyLeafReads }, publishKey: PreparationKeyCreateSteps["publishKey"],
): PreparationKeyCreateSteps {
  return { readCurrentKey: () => readPreparationKeyFrom(leaves.current), readCrashReadyKey: () => readPreparationKeyFrom(leaves.crashReady), publishKey };
}

/** Reconcile any crash-left aliases before reporting an existing healthy key. */
async function refuseExistingKeyEpoch(steps: PreparationKeyCreateSteps, key: Buffer): Promise<never> {
  await steps.publishKey(key);
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
  steps: PreparationKeyCreateSteps, key: Buffer, options: PreparationKeyCreateOptions,
): Promise<void> {
  await options.beforePublishForTest?.();
  if (await steps.publishKey(key) === "collision") {
    const collision = await steps.readCurrentKey();
    throw new Error(`preparation key creation collision: ${collision.status}`);
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
  heldCurrentKey?: () => Promise<PreparationKeyRead>,
): Promise<PreparedPreparationKey> {
  return prepareKeyForEmptyEpochLockedWith(diskPreparationKeyCreateSteps(root, heldCurrentKey), inventory, options);
}

/** {@link prepareKeyForEmptyEpochLocked} over {@link PreparationKeyCreateSteps}: THE ONE BODY, publication included. */
export async function prepareKeyForEmptyEpochLockedWith(
  steps: PreparationKeyCreateSteps,
  inventory: PreparationEpochInventory,
  options: PreparationKeyCreateOptions = {},
): Promise<PreparedPreparationKey> {
  assertEmptyEpochInventory(inventory);
  const current = await steps.readCurrentKey();
  if (current.status === "unavailable") throw new Error("preparation key is unavailable");
  if (current.status === "ok") return refuseExistingKeyEpoch(steps, current.key);
  const key = recoveredEpochKey(await steps.readCrashReadyKey(), PREPARATION_KEY_BYTES, "preparation");
  return {
    keyEpochId: preparationKeyEpochId(key), publish: () => publishPreparedKey(steps, key, options),
  };
}
