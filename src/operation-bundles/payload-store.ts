/**
 * @file src/operation-bundles/payload-store.ts
 * @description Bundle-owned immutable payload blobs. The caller supplies the
 * manifest-bound digest, while this store resolves only its payload namespace.
 */

import type { BundleId } from "./ids.js";
import { MAX_PAYLOAD_BYTES } from "./constants.js";
import { writeContentAddressedBlob, type CreateOnlyBlobResult } from "./blob-store.js";
import { operationPaths } from "./paths.js";

/** Exact bundle namespace and content-address identity for one payload blob. */
export interface PayloadLocation {
  workspaceId: string;
  bundleId: BundleId;
  digest: string;
}

/** Durably create one manifest-bound payload or prove its exact replay. */
export async function writePayloadCreateOnly(
  root: string,
  location: PayloadLocation,
  bytes: Buffer,
): Promise<CreateOnlyBlobResult> {
  const paths = operationPaths(root, location.workspaceId);
  return writeContentAddressedBlob({
    root, bytes, digest: location.digest, maxBytes: MAX_PAYLOAD_BYTES,
    file: paths.payloadFile(location.bundleId, location.digest),
    ownedRoot: paths.payloadsRoot(location.bundleId),
  });
}
