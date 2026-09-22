/**
 * @file src/preparations/lifecycle-fs/storage-observation.ts
 * @description Physical lifecycle-storage capture independent of semantic unit
 * classification. It counts every confined regular path, applies the exact
 * baseline grammar only to descended directories, reuses captured semantic
 * inventories, and retains all facts required for final revalidation.
 */

import type { Stats } from "node:fs";
import { lstat } from "node:fs/promises";
import path from "node:path";
import { openConfinedLeaf } from "../../utils/confined-read.js";
import { isPortableQuarantineStorageDirectory } from "../paths.js";
import type { LifecycleScanBounds } from "./bounds.js";
import {
  boundedDirectoryNames,
  captureLifecycleDirectory,
} from "./directory-observation.js";
import { lifecycleRelativePath } from "./observation-problems.js";
import type {
  LifecycleDirectoryObservation,
  LifecycleRegistryStorageObservation,
  LifecycleStorageCapture,
  LifecycleUnitObservation,
  PreparationLifecycleNamespaceV1,
  ReusedLifecycleDirectory,
} from "./types.js";

const MAX_STORAGE_DEPTH = 32;

/** Open and retain one regular leaf without interpreting its bytes. */
export async function captureStorageFile(
  namespace: PreparationLifecycleNamespaceV1,
  file: string,
  parent: string,
  storage: LifecycleStorageCapture,
): Promise<void> {
  storage.handledPaths.add(file);
  const opened = await openConfinedLeaf(namespace.root.realPath, file, parent);
  if (opened.kind !== "confirmed") {
    storage.complete = false;
    return;
  }
  storage.files.push({
    path: lifecycleRelativePath(namespace.root.realPath, file),
    lexicalPath: file,
    parentPath: parent,
    bytes: opened.size,
    dev: opened.dev,
    ino: opened.ino,
  });
  await opened.handle.close().catch(() => {});
}

/** Retain one exact directory identity and closed inventory. */
export function retainStorageDirectory(
  storage: LifecycleStorageCapture,
  directory: LifecycleDirectoryObservation,
): void {
  storage.directories.push(directory);
}

/** Capture metadata without applying directory grammar to regular filenames. */
async function storageEntryMetadata(
  child: string,
  storage: LifecycleStorageCapture,
): Promise<Stats | null> {
  const metadata = await lstat(child).catch(() => null);
  if (metadata === null || metadata.isSymbolicLink()) {
    storage.complete = false;
    return null;
  }
  return metadata;
}

/** Capture and list one real child directory within the remaining bounds. */
async function storageChildDirectory(
  child: string,
  metadata: Stats,
  bounds: LifecycleScanBounds,
  storage: LifecycleStorageCapture,
  depth: number,
): Promise<LifecycleDirectoryObservation | null> {
  if (!metadata.isDirectory() || depth > MAX_STORAGE_DEPTH ||
      !isPortableQuarantineStorageDirectory(path.basename(child))) {
    storage.complete = false;
    return null;
  }
  const captured = await captureLifecycleDirectory(child);
  const names = captured === null ? "unavailable" : await boundedDirectoryNames(
    child, bounds, storage,
  );
  if (captured === null || !Array.isArray(names)) {
    storage.complete = false;
    return null;
  }
  return { ...captured, names };
}

/** Observe one descendant without following symlinks or special files. */
async function walkStorageEntry(
  namespace: PreparationLifecycleNamespaceV1,
  child: string,
  parent: string,
  bounds: LifecycleScanBounds,
  storage: LifecycleStorageCapture,
  depth: number,
): Promise<void> {
  if (bounds.registryEntries > bounds.maxRegistryEntries) {
    storage.complete = false;
    return;
  }
  const metadata = await storageEntryMetadata(child, storage);
  if (metadata === null) return;
  if (metadata.isFile()) return captureStorageFile(namespace, child, parent, storage);
  const directory = await storageChildDirectory(child, metadata, bounds, storage, depth);
  if (directory !== null) {
    await walkStorageDirectory(namespace, directory, bounds, storage, depth);
  }
}

/** Walk one child or consume its already-captured recognized observation. */
async function walkStorageChild(
  namespace: PreparationLifecycleNamespaceV1,
  directory: LifecycleDirectoryObservation,
  child: string,
  bounds: LifecycleScanBounds,
  storage: LifecycleStorageCapture,
  depth: number,
  reused?: ReusedLifecycleDirectory,
): Promise<void> {
  if (storage.handledPaths.has(child)) return;
  if (reused === undefined || child !== reused.path) {
    await walkStorageEntry(namespace, child, directory.path, bounds, storage, depth + 1);
    return;
  }
  if (reused.observation === undefined || "status" in reused.observation) {
    // UNCONTROLLED BUT LOAD-BEARING. `bytes` was present in the unit-root listing
    // yet has no usable observation, so it changed between the listing and the
    // stat. If a racer then recreates it with content, unit-root revalidation still
    // matches on identical names and the subtree is never counted. No test pins
    // this — there is no seam between the unit-root listing and this observation —
    // so do not remove it on a dead-code pass. Pinning it requires adding a seam.
    storage.complete = false;
    return;
  }
  await walkStorageDirectory(namespace, reused.observation, bounds, storage, depth + 1);
}

/** Walk one captured inventory, reusing its recognized child observation. */
async function walkStorageDirectory(
  namespace: PreparationLifecycleNamespaceV1,
  directory: LifecycleDirectoryObservation,
  bounds: LifecycleScanBounds,
  storage: LifecycleStorageCapture,
  depth: number,
  reused?: ReusedLifecycleDirectory,
): Promise<void> {
  retainStorageDirectory(storage, directory);
  if (depth > MAX_STORAGE_DEPTH ||
      bounds.registryEntries > bounds.maxRegistryEntries) {
    storage.complete = false;
    return;
  }
  for (const name of directory.names) {
    const child = path.join(directory.path, name);
    await walkStorageChild(namespace, directory, child, bounds, storage, depth, reused);
    if (bounds.registryEntries > bounds.maxRegistryEntries) return;
  }
}

/** Capture and recursively walk one physically portable non-unit directory. */
export async function captureForeignDirectoryStorage(
  namespace: PreparationLifecycleNamespaceV1,
  directory: string,
  bounds: LifecycleScanBounds,
  storage: LifecycleStorageCapture,
): Promise<void> {
  const captured = await captureLifecycleDirectory(directory);
  const names = captured === null ? "unavailable" : await boundedDirectoryNames(
    directory, bounds, storage,
  );
  if (captured === null || !Array.isArray(names)) {
    storage.complete = false;
    return;
  }
  await walkStorageDirectory(namespace, { ...captured, names }, bounds, storage, 1);
}

/** Account one prospective semantic unit from its captured inventories. */
export async function captureUnitStorage(
  namespace: PreparationLifecycleNamespaceV1,
  unit: LifecycleUnitObservation,
  bounds: LifecycleScanBounds,
  storage: LifecycleStorageCapture,
): Promise<void> {
  if (unit.directory === undefined) {
    storage.complete = false;
    return;
  }
  const reused = unit.registry === "quarantine"
    ? {
      path: path.join(unit.unitRoot, "bytes"),
      observation: unit.bytes,
    }
    : undefined;
  await walkStorageDirectory(namespace, unit.directory, bounds, storage, 1, reused);
}

/** Freeze-shape projection of mutable capture facts after one registry walk. */
export function storageObservation(
  storage: LifecycleStorageCapture,
): LifecycleRegistryStorageObservation {
  return {
    files: storage.files,
    directories: storage.directories,
    traversalEntries: storage.traversalEntries,
    complete: storage.complete,
  };
}
