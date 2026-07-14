/**
 * @file src/profile/templates/publish/tree-read.ts
 * @description Read one distribution tree FROM DISK through the Slice A confined
 * filesystem primitives: exact-tree enumeration (no extra, missing, symlinked, or
 * special entries), bounded no-follow reads, and digest-derived package paths.
 *
 * Both callers that must reason about a real tree route through here:
 *  - the staged tree, verified before it is ever swapped into place;
 *  - an existing `--out` tree, before publishing is allowed to DELETE it.
 *
 * Neither may hand-roll its own directory walk. An index is public and copyable, so
 * "the index looks right" proves nothing about the directory holding it — only an exact
 * tree check does.
 */
import {
  assertExactDistributionTree,
  closeDistributionPaths,
  readDistributionIndexBytes,
  readDistributionPackageBytes,
  resolveDistributionPaths,
} from "./filesystem.js";
import { decodeUtf8 } from "./bounded-read.js";
import { parseSignedPackage, parseSignedTapIndex } from "../signing/protocol.js";
import type { DistributionPaths } from "./filesystem.js";
import type { SignedTapIndex } from "../signing/types.js";

/**
 * Read the package the index names by `digest` and BIND its content to that name: the
 * envelope's own payloadDigest must equal the digest its filename was derived from.
 * Without this, a file named for digest B could hold a valid envelope for digest A (a
 * duplicate standing in for a missing package) and the filename check alone would pass.
 */
async function readEnvelopeAt(paths: DistributionPaths, digest: string): Promise<string> {
  const text = decodeUtf8(await readDistributionPackageBytes(paths, digest), "package");
  if (parseSignedPackage(text).payloadDigest !== digest) {
    throw new Error("a package file does not match the digest its path is derived from");
  }
  return text;
}

/** One distribution read back from disk, proven to be an exact tree. */
export interface DistributionOnDisk {
  index: SignedTapIndex;
  indexJson: string;
  envelopes: string[];
}

/**
 * Read and structurally verify a distribution directory. The index's OWN package digests
 * drive the expected filenames, so an extra file, a missing package, a duplicate envelope,
 * or a symlink all fail — not merely a wrong count.
 */
export async function readDistributionOnDisk(directory: string): Promise<DistributionOnDisk> {
  const paths = await resolveDistributionPaths(directory);
  try {
    const indexJson = decodeUtf8(await readDistributionIndexBytes(paths), "index");
    const index = parseSignedTapIndex(indexJson);
    const digests = index.packages.map((entry) => entry.payloadDigest);
    await assertExactDistributionTree(paths, digests);
    const envelopes = await Promise.all(digests.map((digest) => readEnvelopeAt(paths, digest)));
    return { index, indexJson, envelopes };
  } finally {
    await closeDistributionPaths(paths);
  }
}
