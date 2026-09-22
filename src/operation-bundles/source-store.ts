/**
 * @file src/operation-bundles/source-store.ts
 * @description Workspace-owned retained source blobs. Their digest filenames
 * are immutable storage identities rather than user-facing source identities.
 */

import { MAX_RETAINED_SOURCE_BYTES } from "./constants.js";
import { writeContentAddressedBlob, type CreateOnlyBlobResult } from "./blob-store.js";
import { operationPaths } from "./paths.js";

/** Exact workspace namespace and content-address identity for one source blob. */
export interface RetainedSourceLocation {
  workspaceId: string;
  digest: string;
}

/** Durably create one retained source blob or prove its exact replay. */
export async function writeRetainedSourceCreateOnly(
  root: string,
  location: RetainedSourceLocation,
  bytes: Buffer,
): Promise<CreateOnlyBlobResult> {
  const paths = operationPaths(root, location.workspaceId);
  return writeContentAddressedBlob({
    root, bytes, digest: location.digest, maxBytes: MAX_RETAINED_SOURCE_BYTES,
    file: paths.sourceFile(location.digest), ownedRoot: paths.sourcesRoot,
  });
}
