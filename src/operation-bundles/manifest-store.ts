/**
 * @file src/operation-bundles/manifest-store.ts
 * @description Confined, canonical, create-only persistence for immutable
 * operation-bundle manifests. Reads keep absence, invalid bytes, and an
 * unavailable filesystem leg distinct so staging can fail closed.
 */

import { TextDecoder } from "node:util";
import { canonicalBytes } from "../profile/templates/signing/canonical.js";
import {
  AtomicWriteCollisionError,
  atomicWriteNoReplaceDurable,
} from "../utils/atomic-write.js";
import { MAX_MANIFEST_BYTES } from "./constants.js";
import { readDurableOperationLeafBuffer } from "./durable-leaf.js";
import type { BundleId } from "./ids.js";
import { parseOperationManifest } from "./manifest-parse.js";
import { operationPaths } from "./paths.js";
import type { OperationBundleManifest } from "./types.js";

const STRICT_UTF8 = new TextDecoder("utf-8", { fatal: true });

/** Complete read classification for one immutable manifest leaf. */
export type OperationManifestRead =
  | { status: "ok"; manifest: OperationBundleManifest }
  | { status: "absent" }
  | { status: "invalid"; detail: string }
  | { status: "unavailable"; detail: string };

/** Stable outcome for a new immutable manifest and an exact replay. */
export type ManifestCreateResult = "created" | "same";

/** Return every manifest payload reference and its declared byte observations. */
export function manifestPayloadClaims(manifest: OperationBundleManifest): Map<string, number[]> {
  const claims = new Map<string, number[]>();
  const add = (ref: string, bytes?: number) => {
    const values = claims.get(ref) ?? [];
    if (bytes !== undefined) values.push(bytes);
    claims.set(ref, values);
  };
  for (const mutation of manifest.mutations) {
    if (!("payloadRef" in mutation)) continue;
    const bytes = "byteCount" in mutation.postcondition
      ? mutation.postcondition.byteCount : undefined;
    add(mutation.payloadRef, bytes);
  }
  for (const evidence of manifest.preparationEvidence) {
    if (evidence.payloadRef !== undefined) add(evidence.payloadRef, evidence.byteCount);
  }
  return claims;
}

/** Parse strict UTF-8 and require the exact RFC 8785 byte representation. */
function parseCanonicalManifest(bytes: Buffer): OperationBundleManifest {
  const text = STRICT_UTF8.decode(bytes);
  const manifest = parseOperationManifest(text);
  if (!canonicalBytes(manifest).equals(bytes)) {
    throw new Error("operation manifest is not canonical");
  }
  return manifest;
}

/** Ensure an immutable record is stored below its own embedded identity. */
function assertManifestBinding(
  manifest: OperationBundleManifest,
  workspaceId: string,
  bundleId: BundleId,
): void {
  if (manifest.workspaceId !== workspaceId || manifest.bundleId !== bundleId) {
    throw new Error("operation manifest identity binding mismatch");
  }
}

/** Read one canonical immutable manifest without following aliases or links. */
export async function readOperationManifest(
  root: string,
  workspaceId: string,
  bundleId: BundleId,
): Promise<OperationManifestRead> {
  let paths: ReturnType<typeof operationPaths>;
  try {
    paths = operationPaths(root, workspaceId);
  } catch {
    return { status: "unavailable", detail: "identity" };
  }
  const leaf = await readDurableOperationLeafBuffer(
    root, paths.manifestFile(bundleId), paths.bundleRoot(bundleId),
    MAX_MANIFEST_BYTES,
  );
  if (leaf.kind === "absent") return { status: "absent" };
  if (leaf.kind === "unavailable") {
    return { status: "unavailable", detail: "manifest-leaf" };
  }
  try {
    const manifest = parseCanonicalManifest(leaf.body);
    assertManifestBinding(manifest, workspaceId, bundleId);
    return { status: "ok", manifest };
  } catch (error) {
    const detail = error instanceof Error ? error.message : "manifest-invalid";
    return { status: "invalid", detail };
  }
}

/** Serialize through the closed parser before any caller value can be written. */
function prepareManifest(manifest: OperationBundleManifest): {
  manifest: OperationBundleManifest;
  bytes: Buffer;
} {
  const candidate = canonicalBytes(manifest);
  if (candidate.byteLength > MAX_MANIFEST_BYTES) {
    throw new Error("operation manifest exceeds the manifest cap");
  }
  const parsed = parseCanonicalManifest(candidate);
  assertManifestBinding(parsed, manifest.workspaceId, manifest.bundleId);
  return { manifest: parsed, bytes: canonicalBytes(parsed) };
}

/** Durably create a canonical manifest or prove an exact immutable replay. */
export async function writeOperationManifestCreateOnly(
  root: string,
  manifest: OperationBundleManifest,
): Promise<ManifestCreateResult> {
  const prepared = prepareManifest(manifest);
  const paths = operationPaths(root, prepared.manifest.workspaceId);
  try {
    await atomicWriteNoReplaceDurable(
      paths.manifestFile(prepared.manifest.bundleId), prepared.bytes,
      { confineRoot: root, exactParent: true, mode: 0o600 },
    );
    return "created";
  } catch (error) {
    if (!(error instanceof AtomicWriteCollisionError)) throw error;
  }
  const collision = await readOperationManifest(
    root, prepared.manifest.workspaceId, prepared.manifest.bundleId,
  );
  if (collision.status === "ok" &&
      canonicalBytes(collision.manifest).equals(prepared.bytes)) return "same";
  throw new Error(`operation manifest conflict: ${collision.status}`);
}
