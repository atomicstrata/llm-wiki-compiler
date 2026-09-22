/**
 * @file src/preparations/manifest-store.ts
 * @description Confined, canonical, create-only persistence for immutable
 * preparation manifests (design section 8.1). Reads keep absence, invalid bytes,
 * and an unavailable filesystem leg distinct so staging can fail closed; the
 * store never edits an existing manifest. Bytes are read through the shared
 * hardened durable-leaf reader (no-follow, single reserved companion) and
 * verified byte-for-byte canonical before any field is trusted.
 */

import { TextDecoder } from "node:util";
import { canonicalBytes } from "../profile/templates/signing/canonical.js";
import { AtomicWriteCollisionError, atomicWriteNoReplaceDurable } from "../utils/atomic-write.js";
import { readDurableOperationLeafBuffer } from "../operation-bundles/durable-leaf.js";
import { MAX_PREPARATION_MANIFEST_BYTES } from "./constants.js";
import type { PreparationId } from "./ids.js";
import { parsePreparationManifest, type PreparationManifestV1 } from "./manifest-parse.js";
import { preparationPaths } from "./paths.js";

const STRICT_UTF8 = new TextDecoder("utf-8", { fatal: true });

/** Complete read classification for one immutable manifest leaf. */
export type PreparationManifestRead =
  | { status: "ok"; manifest: PreparationManifestV1 }
  | { status: "absent" }
  | { status: "invalid"; detail: string }
  | { status: "unavailable"; detail: string };

/** Stable outcome for a new immutable manifest and an exact replay. */
export type ManifestCreateResult = "created" | "same";

/** Parse strict UTF-8 and require the exact RFC 8785 byte representation. */
function parseCanonicalManifest(bytes: Buffer): PreparationManifestV1 {
  const text = STRICT_UTF8.decode(bytes);
  const manifest = parsePreparationManifest(text);
  if (!canonicalBytes(manifest).equals(bytes)) {
    throw new Error("preparation manifest is not canonical");
  }
  return manifest;
}

/** Ensure an immutable record is stored below its own embedded identity. */
function assertManifestBinding(
  manifest: PreparationManifestV1,
  workspaceId: string,
  preparationId: PreparationId,
): void {
  if (manifest.workspaceId !== workspaceId || manifest.preparationId !== preparationId) {
    throw new Error("preparation manifest identity binding mismatch");
  }
}

/** Read one canonical immutable manifest without following aliases or links. */
export async function readPreparationManifest(
  root: string,
  workspaceId: string,
  preparationId: PreparationId,
): Promise<PreparationManifestRead> {
  let paths: ReturnType<typeof preparationPaths>;
  try {
    paths = preparationPaths(root, workspaceId);
  } catch {
    return { status: "unavailable", detail: "identity" };
  }
  const leaf = await readDurableOperationLeafBuffer(
    root, paths.manifestFile(preparationId), paths.preparationRoot(preparationId),
    MAX_PREPARATION_MANIFEST_BYTES,
  );
  if (leaf.kind === "absent") return { status: "absent" };
  if (leaf.kind === "unavailable") return { status: "unavailable", detail: "manifest-leaf" };
  try {
    const manifest = parseCanonicalManifest(leaf.body);
    assertManifestBinding(manifest, workspaceId, preparationId);
    return { status: "ok", manifest };
  } catch (error) {
    return { status: "invalid", detail: error instanceof Error ? error.message : "manifest-invalid" };
  }
}

/**
 * Re-raise a loader rejection on the WRITE path as an untyped fault.
 *
 * The loader types its rejections so the PRE-PUBLICATION re-parse in `stage.ts`
 * can report a refusal. This call site is the other one, and the same type would
 * be a lie here: staging materializes the initial evidence durably BEFORE it
 * writes the manifest, so a rejection at this point would convert to `refused` —
 * "nothing happened" — with evidence already on disk.
 *
 * Nothing a caller supplies can reach it. The manifest arriving here was built
 * by the host and already accepted by this same loader during staging, so a
 * rejection now is by construction a host defect, which is what a fault is for.
 * Only the CLASS is stripped; the message and the original throw are kept.
 */
function asWriteFault<T>(load: () => T): T {
  try {
    return load();
  } catch (error) {
    throw new Error(
      error instanceof Error ? error.message : "preparation manifest is invalid", { cause: error });
  }
}

/** Serialize through the closed parser before any caller value can be written. */
function prepareManifest(manifest: PreparationManifestV1): { manifest: PreparationManifestV1; bytes: Buffer } {
  const candidate = canonicalBytes(manifest);
  if (candidate.byteLength > MAX_PREPARATION_MANIFEST_BYTES) {
    throw new Error("preparation manifest exceeds the manifest cap");
  }
  const parsed = asWriteFault(() => parseCanonicalManifest(candidate));
  assertManifestBinding(parsed, manifest.workspaceId, manifest.preparationId);
  return { manifest: parsed, bytes: canonicalBytes(parsed) };
}

/** Durably create a canonical manifest or prove an exact immutable replay. */
export async function writePreparationManifestCreateOnly(
  root: string,
  manifest: PreparationManifestV1,
): Promise<ManifestCreateResult> {
  const prepared = prepareManifest(manifest);
  const paths = preparationPaths(root, prepared.manifest.workspaceId);
  try {
    await atomicWriteNoReplaceDurable(
      paths.manifestFile(prepared.manifest.preparationId), prepared.bytes,
      { confineRoot: root, exactParent: true, mode: 0o600 },
    );
    return "created";
  } catch (error) {
    if (!(error instanceof AtomicWriteCollisionError)) throw error;
  }
  const collision = await readPreparationManifest(root, prepared.manifest.workspaceId, prepared.manifest.preparationId);
  if (collision.status === "ok" && canonicalBytes(collision.manifest).equals(prepared.bytes)) return "same";
  throw new Error(`preparation manifest conflict: ${collision.status}`);
}
