/**
 * @file src/segments/io.ts
 * @description The physical operations a segment store runs over, and their
 * local-disk binding.
 *
 * Every store lives in its own directory under `.llmwiki/indexed/<store>/`.
 * Reads go through the shared confined, no-follow, single-link leaf open, so a
 * linked, hard-linked, special or escaping leaf is refused rather than read.
 * Segments are published create-only with strict durability (temp, fsync,
 * no-replace link, directory fsync). The manifest is replaced atomically and
 * durably, and the store's `revalidate` callback runs at the atomic writer's
 * LAST pre-publication seam (`beforeReplace`: after the temp is written and
 * synced, immediately before it is renamed over the manifest).
 *
 * READER LEASE. Before any manifest read, segment open, segment write or
 * manifest publication, the process registers itself as a reader of the project
 * (`./reader-lease.ts`), so a collector elsewhere sees every snapshot this
 * process may hold, including one returned by the first commit that created
 * the store. A project without `.llmwiki/indexed` registers nothing until a
 * read finds a manifest there or a write creates one.
 *
 * The bodies in `./store.ts` decide everything; this module only performs
 * the operation it is asked for.
 */

import { chmod } from "node:fs/promises";
import path from "node:path";
import { atomicWrite } from "../utils/atomic-write.js";
import { openConfinedLeaf, readConfinedLeafBuffer } from "../utils/confined-read.js";
import { ensureConfinedDirectory } from "../utils/confined-scaffold.js";
import { listConfinedDirBounded } from "../utils/confined-dir.js";
import { ensureReaderLease } from "./reader-lease.js";
import {
  corrupt, IndexedStoreError, INDEXED_DIR, MANIFEST_LEAF, MAX_SEGMENT_MANIFEST_BYTES, MAX_SEGMENT_BYTES, STORE_NAME_PATTERN,
} from "./contracts.js";

/** Indexed leaves are private to the owner, like the operation catalog they may hold. */
const PRIVATE_FILE_MODE = 0o600;
/** A store directory created here is private to the owner where the platform honours modes. */
const PRIVATE_DIR_MODE = 0o700;

/** An open segment file, read by position. */
export interface SegmentHandle {
  readonly size: number;
  /** Exactly `length` bytes at `position`; rejects on a short read. */
  readAt(position: number, length: number): Promise<Buffer>;
  close(): Promise<void>;
}

/** What one manifest read found. Anything unusable rejects with `indexed_store_unavailable`. */
export type ManifestRead = { readonly kind: "absent" } | { readonly kind: "ok"; readonly bytes: Buffer };

/**
 * One bounded listing of a store directory. `incomplete` means the directory
 * exists but could not be listed in full (over the bound, unreadable or not a
 * directory): it is NEVER the same as empty.
 */
export type LeafListing =
  | { readonly kind: "absent" }
  | { readonly kind: "ok"; readonly names: string[] }
  | { readonly kind: "incomplete" };

/** The physical operations of one store. No member decides anything. */
export interface SegmentStoreIo {
  readonly store: string;
  readManifest(): Promise<ManifestRead>;
  /** Open one segment; rejects with `indexed_store_corrupt` when it is missing or not a confined regular file. */
  openSegment(name: string): Promise<SegmentHandle>;
  /** Publish a new segment create-only and durably. Rejects raw on any failure, including a name collision. */
  writeSegment(name: string, bytes: Buffer): Promise<void>;
  /** Replace the manifest; `revalidate` runs after the durable temp, immediately before the rename, and may reject to abort it. */
  publishManifest(bytes: Buffer, revalidate: () => Promise<void>): Promise<void>;
  /** Every leaf name in the store directory, bounded by `max`; over the bound or unreadable is `incomplete`. */
  listLeaves(max: number): Promise<LeafListing>;
}

/** Read exactly `length` bytes at `position`, looping over partial reads; EOF first is corruption. */
async function readExactly(handle: import("node:fs/promises").FileHandle, size: number, position: number, length: number): Promise<Buffer> {
  const valid = Number.isSafeInteger(position) && Number.isSafeInteger(length) && position >= 0 && length >= 0
    && length <= MAX_SEGMENT_BYTES && position + length <= size;
  if (!valid) corrupt("segment read is out of the file's bounds");
  const buffer = Buffer.alloc(length);
  let filled = 0;
  while (filled < length) {
    const { bytesRead } = await handle.read({ buffer, offset: filled, position: position + filled, length: length - filled });
    if (bytesRead === 0) corrupt("segment ended before the expected bytes");
    filled += bytesRead;
  }
  return buffer;
}

/** Wrap an opened file handle as a positioned reader (also the read-only archived stores' reader). */
export function positionedReader(handle: import("node:fs/promises").FileHandle, size: number): SegmentHandle {
  return { size, readAt: (position, length) => readExactly(handle, size, position, length), close: () => handle.close() };
}

/** Create the store directory confined under `root`, private to the owner when newly created. */
async function ensureStoreDir(root: string, relDir: string): Promise<void> {
  if (await ensureConfinedDirectory(root, relDir)) await chmod(path.join(root, relDir), PRIVATE_DIR_MODE).catch(() => {});
}

/**
 * Read `store`'s manifest leaf WITHOUT registering a reader lease: the
 * collector's read (`../indexed/gc-plan.ts`), which opens no segment, and the
 * body of every registered read.
 */
export async function readManifestLeaf(root: string, store: string): Promise<ManifestRead> {
  const relDir = path.posix.join(INDEXED_DIR, store);
  const dir = path.join(root, relDir);
  const read = await readConfinedLeafBuffer(root, path.join(dir, MANIFEST_LEAF), dir, MAX_SEGMENT_MANIFEST_BYTES, { requireSingleLink: true });
  if (read.kind === "absent") return { kind: "absent" };
  if (read.kind === "unavailable") throw new IndexedStoreError("indexed_store_unavailable", `${relDir}/${MANIFEST_LEAF} is a link, not a regular single-link file, oversized or unreadable`);
  return { kind: "ok", bytes: read.body };
}

/** Read `store`'s manifest after registering this process's reader lease (re-registering if the indexed directory appeared meanwhile). */
async function leasedManifestRead(root: string, store: string): Promise<ManifestRead> {
  const leased = await ensureReaderLease(root);
  const read = await readManifestLeaf(root, store);
  if (leased || read.kind === "absent") return read;
  // The indexed directory appeared after the lease check: register, then read again.
  await ensureReaderLease(root, true);
  return readManifestLeaf(root, store);
}

/** LOCAL DISK. The confined directory, reads and durable writes of `store` in the project at `root`. */
export function diskSegmentStoreIo(root: string, store: string): SegmentStoreIo {
  if (!STORE_NAME_PATTERN.test(store)) throw new IndexedStoreError("indexed_store_invalid_write", `invalid store name ${store}`);
  const relDir = path.posix.join(INDEXED_DIR, store);
  const dir = path.join(root, relDir);
  return {
    store,
    readManifest: () => leasedManifestRead(root, store),
    openSegment: async (name) => {
      // A lazy segment read of a retained snapshot re-checks this process's lease too.
      await ensureReaderLease(root, true);
      const opened = await openConfinedLeaf(root, path.join(dir, name), dir, { requireSingleLink: true });
      if (opened.kind !== "confirmed") throw new IndexedStoreError("indexed_store_corrupt", `segment ${relDir}/${name} is missing or not a confined regular file`);
      return positionedReader(opened.handle, opened.size);
    },
    writeSegment: async (name, bytes) => {
      await ensureReaderLease(root, true);
      await ensureStoreDir(root, relDir);
      await atomicWrite(path.join(dir, name), bytes, { confineRoot: root, exactParent: true, createOnly: true, mode: PRIVATE_FILE_MODE });
    },
    publishManifest: async (bytes, revalidate) => {
      await ensureReaderLease(root, true);
      await ensureStoreDir(root, relDir);
      await atomicWrite(path.join(dir, MANIFEST_LEAF), bytes, {
        confineRoot: root, exactParent: true, durable: true, strictDurability: true, mode: PRIVATE_FILE_MODE, beforeReplace: revalidate,
      });
    },
    listLeaves: (max) => listStoreLeaves(root, relDir, max),
  };
}

/** Every leaf name of the store directory `relDir`, bounded by `max` (also the read-only archived stores' listing). */
export async function listStoreLeaves(root: string, relDir: string, max: number): Promise<LeafListing> {
  const listing = await listConfinedDirBounded(root, relDir, max);
  if (listing.kind === "absent") return { kind: "absent" };
  return listing.kind === "ok" ? { kind: "ok", names: listing.entries.map((entry) => entry.name) } : { kind: "incomplete" };
}

/**
 * Whether the store directory may hold any leaf. Only an absent directory or
 * a COMPLETE empty listing proves "nothing there"; a directory that cannot be
 * listed counts as holding leaves (fail closed).
 */
export async function storeMayHoldLeaves(io: SegmentStoreIo): Promise<boolean> {
  const listing = await io.listLeaves(1);
  return listing.kind === "incomplete" || (listing.kind === "ok" && listing.names.length > 0);
}
