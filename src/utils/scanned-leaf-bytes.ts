/** The bytes an inventory walk already read from a leaf, held for the authenticated reads later in the SAME PASS. */

import path from "node:path";

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
  hasRoomFor(bytes: number): boolean;
  hold(leaf: HeldLeaf): void;
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
