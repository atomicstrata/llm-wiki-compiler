/**
 * @file src/utils/scanned-leaf-bytes.ts
 * @description The bytes an inventory walk already read from a leaf, held for
 * the authenticated reads later in the SAME PASS.
 *
 * WHY. An inventory scan walks the store, opening every leaf to take its size
 * and identity, and then reads the manifests and runs it found through the
 * durable-leaf reader, which opens each one AGAIN and re-proves the same
 * confinement. For a leaf the scan goes on to read, the walk now reads the
 * bytes while its confined handle is open, under the leaf kind's own cap, and
 * leaves them here when the read returned exactly the size the open saw. The
 * durable reader consumes them only after asking the post-read checks (parent
 * realpath, canonical identity) and proving the leaf is STILL the version the
 * open saw (`durable-leaf.ts`); on any difference it reads the disk as before.
 *
 * WHAT IS HELD. A held leaf carries the identity, version and confinement its
 * handle proved: the lexical leaf and owned directory it was asked under, the
 * root, the canonical parent and leaf, `dev`/`ino`/`nlink`/`size` and the
 * modification and change times. Nothing here opens, reads or checks a file,
 * and no handle is held: the bytes were copied out and the handle closed.
 *
 * BOUNDED. Each held leaf is already within its kind's cap. The total held is
 * capped by {@link MAX_HELD_SCAN_BYTES}; past it the walk keeps no more bytes
 * and the readers read the disk, exactly as without this module.
 *
 * SCOPE. One holder belongs to one pass (`pass-reads.ts` of each store) and
 * dies with it. It is not a cache of the store: a held leaf is only ever an
 * input to a reader that re-proves it current.
 */

import path from "node:path";

/** Total bytes one pass may hold. A walk over a larger store holds what fits and leaves the rest to the readers. */
const MAX_HELD_SCAN_BYTES = 32 * 1024 * 1024;

/** One leaf's bytes with the identity, version and confinement its confined handle proved after reading them. */
export interface HeldLeaf {
  root: string;
  leaf: string;
  ownedDirectory: string;
  expectedReal: string;
  canonicalLeaf: string;
  dev: number;
  ino: number;
  nlink: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  body: Buffer;
}

/** The pass's holder of walk-read leaf bytes. */
export interface ScannedLeafBytes {
  /** Whether `bytes` more still fit under {@link MAX_HELD_SCAN_BYTES}. Asked BEFORE the walk reads a leaf. */
  hasRoomFor(bytes: number): boolean;
  /** Hold one leaf, replacing an earlier hold of the same leaf. Refused silently when it does not fit. */
  hold(leaf: HeldLeaf): void;
  /**
   * The held leaf at exactly this root, leaf path and owned directory, if its
   * size is within `maxBytes`. The caller must still prove it current.
   */
  heldFor(root: string, leaf: string, ownedDirectory: string, maxBytes: number): HeldLeaf | undefined;
}

/** A new, empty holder for one pass. */
export function scannedLeafBytes(): ScannedLeafBytes {
  const held = new Map<string, HeldLeaf>();
  let total = 0;
  return {
    hasRoomFor: (bytes) => total + bytes <= MAX_HELD_SCAN_BYTES,
    hold: (leaf) => {
      const key = path.resolve(leaf.leaf), prior = held.get(key)?.body.byteLength ?? 0;
      if (total - prior + leaf.body.byteLength > MAX_HELD_SCAN_BYTES) return;
      held.set(key, leaf);
      total += leaf.body.byteLength - prior;
    },
    heldFor: (root, leaf, ownedDirectory, maxBytes) => {
      const found = held.get(path.resolve(leaf));
      if (found === undefined || found.size > maxBytes) return undefined;
      return found.root === path.resolve(root) && found.ownedDirectory === path.resolve(ownedDirectory) ? found : undefined;
    },
  };
}
