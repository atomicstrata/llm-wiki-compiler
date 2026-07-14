/**
 * @file src/profile/templates/publish/filesystem.ts
 * @description Public read-only filesystem facade for offline publisher
 * snapshots. Specialized modules retain path, tree, key, and byte boundaries.
 */
import path from "node:path";
import { openConfinedLeaf } from "../../../utils/confined-read.js";
import { decodeUtf8, readBoundedFromHandle } from "./bounded-read.js";
import { assertRootBound, type DistributionPaths } from "./distribution-paths.js";
import { packagePath } from "./distribution-tree.js";

const MAX_INDEX_BYTES = 4 * 1024 * 1024;
const MAX_PACKAGE_BYTES = 2 * 1024 * 1024;

export {
  closeDistributionPaths,
  resolveDistributionPaths,
  type DistributionPaths,
} from "./distribution-paths.js";
export {
  assertExactDistributionTree,
  openExactDistributionTreeGuard,
  type DistributionTreeGuard,
} from "./distribution-tree.js";
export {
  decodeCanonicalBase64Key,
  decodeTapPublicKey,
  openTapPublicKey,
  type SelectedTapPublicKey,
} from "./tap-key-file.js";

/** Read the fixed index leaf through a root-anchored, handle-bound open. */
export async function readDistributionIndex(paths: DistributionPaths): Promise<string> {
  return decodeUtf8(await readDistributionIndexBytes(paths), "index");
}

/** Read the fixed index leaf as the exact selected bytes. */
export async function readDistributionIndexBytes(paths: DistributionPaths): Promise<Buffer> {
  await assertRootBound(paths);
  const index = path.join(paths.root, "index.json");
  const result = await readConfinedBytes(paths, index, paths.root, MAX_INDEX_BYTES, "index");
  await assertRootBound(paths);
  return result;
}

/** Read one digest-derived package as the exact selected bytes. */
export async function readDistributionPackageBytes(
  paths: DistributionPaths,
  digest: string,
): Promise<Buffer> {
  await assertRootBound(paths);
  const result = await readConfinedBytes(
    paths,
    packagePath(paths, digest),
    paths.packageDirectory,
    MAX_PACKAGE_BYTES,
    "package",
  );
  await assertRootBound(paths);
  return result;
}

async function readConfinedBytes(
  paths: DistributionPaths,
  file: string,
  expectedDirectory: string,
  maxBytes: number,
  label: string,
): Promise<Buffer> {
  if (paths.testSeams.beforeLeafOpenForTest) {
    await paths.testSeams.beforeLeafOpenForTest(file, label);
  }
  const opened = await openConfinedLeaf(paths.root, file, expectedDirectory, {
    afterOpenForTest: afterLeafOpen(paths, file, label),
  });
  if (opened.kind !== "confirmed") {
    throw new Error(`${label} is missing, symlinked, or not a regular file`);
  }
  try {
    if (opened.size > maxBytes) throw new Error(`${label} exceeds its bounded size limit`);
    return await readBoundedFromHandle(opened.handle, maxBytes, label);
  } finally {
    await opened.handle.close().catch(() => {});
  }
}

function afterLeafOpen(
  paths: DistributionPaths,
  file: string,
  label: string,
): (() => Promise<void>) | undefined {
  if (!paths.testSeams.afterLeafOpenForTest) return undefined;
  return () => paths.testSeams.afterLeafOpenForTest!(file, label);
}
