/**
 * @file src/preparations/lifecycle-fs/revalidate.ts
 * @description Post-classification identity and closed-inventory revalidation
 * for one low-level lifecycle unit observation.
 */

import { lstat, realpath } from "node:fs/promises";
import { openConfinedLeaf } from "../../utils/confined-read.js";
import type { LifecycleScanBounds } from "./bounds.js";
import {
  boundedDirectoryNames,
  captureLifecycleDirectoryVersion,
  lifecycleDirectoryVersionsMatch,
} from "./directory-observation.js";
import type {
  LifecycleDirectoryObservation,
  LifecycleObservationSet,
  LifecycleRegistryStorageObservation,
  LifecycleStorageFileObservation,
  LifecycleUnitObservation,
  PreparationLifecycleNamespaceV1,
} from "./types.js";

/** Whether one observed directory still names the exact captured inode. */
async function directoryStillCurrent(
  observed: LifecycleDirectoryObservation,
): Promise<boolean> {
  try {
    const stats = await lstat(observed.path);
    return stats.isDirectory() && !stats.isSymbolicLink() &&
      stats.dev === observed.dev && stats.ino === observed.ino &&
      (await realpath(observed.path)) === observed.path;
  } catch {
    return false;
  }
}

/** Re-list one directory with a local cap and require its inventory unchanged. */
async function directoryInventoryStillCurrent(
  observed: LifecycleDirectoryObservation,
): Promise<boolean> {
  const bounds: LifecycleScanBounds = {
    maxRegistryEntries: observed.names.length,
    maxReceiptBytes: 0,
    maxObjectBytes: 0,
    maxPostconditionBytes: 0,
    registryEntries: 0,
    postconditionBytes: 0,
  };
  const names = await boundedDirectoryNames(observed.path, bounds);
  return Array.isArray(names) &&
    names.length === observed.names.length &&
    names.every((name, index) => name === observed.names[index]);
}

/** Revalidate a root by version and a nested directory by exact inventory. */
async function storageDirectoryStillCurrent(
  observed: LifecycleDirectoryObservation,
): Promise<boolean> {
  if (observed.version !== undefined) {
    const current = await captureLifecycleDirectoryVersion(observed.path);
    return current !== null &&
      lifecycleDirectoryVersionsMatch(observed.version, current);
  }
  return await directoryStillCurrent(observed) &&
    await directoryInventoryStillCurrent(observed);
}

/** Revalidate the unit identities and closed inventories after classification. */
export async function lifecycleUnitStillCurrent(
  unit: LifecycleUnitObservation,
): Promise<boolean> {
  if (unit.directory === undefined ||
      !(await directoryStillCurrent(unit.directory)) ||
      !(await directoryInventoryStillCurrent(unit.directory))) return false;
  if (unit.bytes === undefined) return true;
  if ("status" in unit.bytes) {
    try {
      await lstat(unit.bytes.path);
      return false;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT";
    }
  }
  return await directoryStillCurrent(unit.bytes) &&
    await directoryInventoryStillCurrent(unit.bytes);
}

/** Reopen one captured regular leaf and require the same confined identity. */
async function storageFileStillCurrent(
  namespace: PreparationLifecycleNamespaceV1,
  observed: LifecycleStorageFileObservation,
): Promise<boolean> {
  const opened = await openConfinedLeaf(
    namespace.root.realPath,
    observed.lexicalPath,
    observed.parentPath,
  );
  if (opened.kind !== "confirmed") return false;
  try {
    return opened.dev === observed.dev &&
      opened.ino === observed.ino &&
      opened.size === observed.bytes;
  } finally {
    await opened.handle.close().catch(() => {});
  }
}

/** Re-prove every retained directory inventory and regular leaf observation. */
async function registryStorageStillCurrent(
  namespace: PreparationLifecycleNamespaceV1,
  observed: LifecycleRegistryStorageObservation,
): Promise<boolean> {
  for (const directory of observed.directories) {
    if (!(await storageDirectoryStillCurrent(directory))) return false;
  }
  for (const file of observed.files) {
    if (!(await storageFileStillCurrent(namespace, file))) return false;
  }
  return true;
}

/** Mark a raced registry unavailable without discarding observed lower bounds. */
async function revalidateRegistryStorage(
  namespace: PreparationLifecycleNamespaceV1,
  observed: LifecycleRegistryStorageObservation,
): Promise<LifecycleRegistryStorageObservation> {
  const current = await registryStorageStillCurrent(namespace, observed);
  return current ? observed : { ...observed, complete: false };
}

/** Revalidate both complete physical captures before snapshot publication. */
export async function revalidateLifecycleStorage(
  namespace: PreparationLifecycleNamespaceV1,
  observed: LifecycleObservationSet["storage"],
): Promise<LifecycleObservationSet["storage"]> {
  return {
    quarantine: await revalidateRegistryStorage(namespace, observed.quarantine),
    prune: await revalidateRegistryStorage(namespace, observed.prune),
  };
}
