/**
 * @file src/utils/inventory-disk-walk.ts
 * @description The LOCAL-DISK walk reads both inventory stores (operation and
 * preparation) hand to their one scan body: visit one store-relative directory,
 * and observe one store-relative leaf.
 *
 * ONE STORE DIRECTORY, ONE ROOT. Built per call and PURE to build (two lexical
 * path resolutions, no I/O): each closure joins the store-relative path back
 * under the resolved store directory and calls the shared confined primitive
 * with the resolved project root. Each store's own factory names its directory
 * and keeps its own walk-reads contract; nothing here selects a backend.
 *
 * ONE READ-AHEAD PER WALK. The visits and the leaf observations share one
 * `leafReadAhead()` (`inventory-leaf-read-ahead.ts`): a visit opens a run of
 * file entries and proves their directory once, and each observation claims
 * its leaf's handle. Building it does no I/O.
 *
 * WHY A SEPARATE MODULE. The two primitives are called through the exports of
 * `inventory-scan.ts`, never from inside it, so a module spy on
 * `visitInventoryDirectory` or `observeInventoryLeaf` still sees every root-form
 * scan reach them. In no package index.
 */

import path from "node:path";
import { observeInventoryLeaf, visitInventoryDirectory, type InventoryLeafObserver } from "./inventory-scan.js";
import { leafReadAhead } from "./inventory-leaf-read-ahead.js";
import type { ScannedLeafBytes } from "./scanned-leaf-bytes.js";

/** The walk reads one store directory answers, in the primitives' own terms. */
interface DiskInventoryWalkReads {
  visitDirectory(directory: string, visitor: Parameters<typeof visitInventoryDirectory>[2]): ReturnType<typeof visitInventoryDirectory>;
  observeLeaf: InventoryLeafObserver;
}

/**
 * The local-disk walk reads of the store at `storeDirectory` under `root`.
 *
 * @param root - The project root.
 * @param storeDirectory - The store's directory, relative to `root`.
 * @param scanned - The pass's holder for leaf bytes the walk reads; without
 * one, a leaf is only observed and `retainUpToBytes` is ignored.
 */
export function diskInventoryWalkReads(root: string, storeDirectory: string, scanned?: ScannedLeafBytes): DiskInventoryWalkReads {
  const resolvedRoot = path.resolve(root), storeRoot = path.resolve(path.join(root, storeDirectory));
  const ahead = leafReadAhead();
  return {
    visitDirectory: (directory, visitor) =>
      visitInventoryDirectory(resolvedRoot, path.join(storeRoot, directory), visitor, ahead),
    observeLeaf: (file, parent, retainUpToBytes) =>
      observeInventoryLeaf(resolvedRoot, path.join(storeRoot, file), path.join(storeRoot, parent),
        scanned === undefined || retainUpToBytes === undefined ? undefined : { into: scanned, maxBytes: retainUpToBytes }, ahead),
  };
}
