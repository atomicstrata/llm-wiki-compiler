/**
 * @file src/preparations/lifecycle-snapshot/storage.ts
 * @description Pure Task 9C projection from confined lifecycle file
 * observations to immutable registry totals. Literal paths determine count;
 * device/inode identity alone deduplicates physical bytes, and conflicting
 * observations conservatively poison health rather than choosing authority.
 */

import type {
  LifecycleObservationSet,
  LifecycleRegistryStorageObservation,
} from "../lifecycle-fs/types.js";
import type {
  PreparationLifecycleStorageEntryV1,
  PreparationLifecycleStorageV1,
} from "./types.js";

/** Physical identity used only to avoid charging one inode more than once. */
function physicalIdentity(file: { readonly dev: number; readonly ino: number }): string {
  return `${file.dev}:${file.ino}`;
}

/** Aggregate one registry while detecting an impossible size identity split. */
function storageEntry(
  observed: LifecycleRegistryStorageObservation,
): PreparationLifecycleStorageEntryV1 {
  const paths = new Set<string>();
  const physicalBytes = new Map<string, number>();
  let identityConflict = false;
  for (const file of observed.files) {
    paths.add(file.path);
    const identity = physicalIdentity(file);
    const current = physicalBytes.get(identity);
    if (current !== undefined && current !== file.bytes) identityConflict = true;
    if (current === undefined) physicalBytes.set(identity, file.bytes);
  }
  return {
    count: paths.size,
    bytes: [...physicalBytes.values()].reduce((total, bytes) => total + bytes, 0),
    health: observed.complete && !identityConflict ? "ok" : "unavailable",
    traversalEntries: observed.traversalEntries,
  };
}

/** Project both registry observations without parsing lifecycle metadata. */
export function projectPreparationLifecycleStorage(
  observed: LifecycleObservationSet["storage"],
): PreparationLifecycleStorageV1 {
  return {
    quarantine: storageEntry(observed.quarantine),
    prune: storageEntry(observed.prune),
  };
}
