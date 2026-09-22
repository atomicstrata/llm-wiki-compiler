/**
 * @file src/preparations/lifecycle-fs/directory-observation.ts
 * @description Shared bounded directory listing and stable real-directory
 * identity capture for lifecycle observation and later revalidation.
 */

import { lstat, opendir, realpath } from "node:fs/promises";
import type { BigIntStats } from "node:fs";
import type { LifecycleScanBounds } from "./bounds.js";
import type {
  LifecycleDirectoryObservation,
  LifecycleDirectoryVersionObservation,
  LifecycleStorageCapture,
} from "./types.js";

/** Project mutation-relevant bigint facts from one directory stat. */
function directoryVersion(stats: BigIntStats): LifecycleDirectoryVersionObservation {
  return {
    dev: stats.dev,
    ino: stats.ino,
    mode: stats.mode,
    nlink: stats.nlink,
    size: stats.size,
    mtimeNs: stats.mtimeNs,
    ctimeNs: stats.ctimeNs,
  };
}

/** Whether two directory-version observations are byte-for-byte equivalent. */
export function lifecycleDirectoryVersionsMatch(
  left: LifecycleDirectoryVersionObservation,
  right: LifecycleDirectoryVersionObservation,
): boolean {
  return left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs;
}

/** Capture one stable canonical directory version without enumerating it. */
export async function captureLifecycleDirectoryVersion(
  directory: string,
): Promise<LifecycleDirectoryVersionObservation | null> {
  try {
    const before = await lstat(directory, { bigint: true });
    const resolved = await realpath(directory);
    const after = await lstat(directory, { bigint: true });
    const beforeVersion = directoryVersion(before);
    const afterVersion = directoryVersion(after);
    if (!before.isDirectory() || before.isSymbolicLink() ||
        !after.isDirectory() || after.isSymbolicLink() ||
        resolved !== directory ||
        !lifecycleDirectoryVersionsMatch(beforeVersion, afterVersion)) return null;
    return afterVersion;
  } catch {
    return null;
  }
}

/** List one present directory incrementally and refuse rather than clamp. */
export async function boundedDirectoryNames(
  directory: string,
  bounds: LifecycleScanBounds,
  storage?: LifecycleStorageCapture,
): Promise<readonly string[] | "unavailable" | "exhausted"> {
  if (bounds.registryEntries > bounds.maxRegistryEntries) {
    if (storage !== undefined) storage.exhausted = true;
    return "exhausted";
  }
  const handle = await opendir(directory).catch(() => null);
  if (handle === null) return "unavailable";
  const names: string[] = [];
  try {
    for await (const entry of handle) {
      bounds.registryEntries += 1;
      if (storage !== undefined) storage.traversalEntries += 1;
      if (bounds.registryEntries > bounds.maxRegistryEntries) {
        if (storage !== undefined) storage.exhausted = true;
        return "exhausted";
      }
      names.push(entry.name);
    }
  } catch {
    return "unavailable";
  }
  return names.sort();
}

/** Require one directory to remain at its exact real path and inode. */
export async function captureLifecycleDirectory(
  directory: string,
): Promise<LifecycleDirectoryObservation | null> {
  try {
    const before = await lstat(directory);
    const resolved = await realpath(directory);
    const after = await lstat(directory);
    if (!before.isDirectory() || before.isSymbolicLink() || resolved !== directory ||
        before.dev !== after.dev || before.ino !== after.ino) return null;
    return { path: directory, dev: after.dev, ino: after.ino, names: [] };
  } catch {
    return null;
  }
}
