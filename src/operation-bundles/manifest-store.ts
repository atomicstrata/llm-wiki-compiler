/**
 * @file src/operation-bundles/manifest-store.ts
 * @description Confined, canonical, create-only persistence for immutable
 * operation-bundle manifests. Reads keep absence, invalid bytes, and an
 * unavailable filesystem leg distinct so staging can fail closed.
 *
 * ONE READ BODY, OVER THE READER'S OWN LEAVES. `readOperationManifestFrom` takes
 * `OperationManifestLeafReads` (the shape of `PreparationManifestLeafReads`) and
 * no project root; it decides the cap, strict UTF-8, the canonical-bytes rule
 * and the identity binding. `readOperationManifest` keeps its signature and
 * delegates over the local-disk leaves, built on each call, whose path
 * derivation and confined durable-leaf read are the incumbent calls.
 *
 * ONE CREATE-ONLY WRITER BODY. `writeOperationManifestCreateOnlyWith` owns the
 * closed re-parse, the cap, the canonical bytes and the exact-replay rule over
 * {@link OperationManifestWriteSteps}; the collision readback runs ONLY when the
 * create reports a genuine `AtomicWriteCollisionError`. The root form delegates
 * over {@link diskOperationManifestWriteSteps}.
 */

import { TextDecoder } from "node:util";
import { canonicalBytes } from "../profile/templates/signing/canonical.js";
import {
  AtomicWriteCollisionError,
  atomicWriteNoReplaceDurable,
} from "../utils/atomic-write.js";
import type { CappedLeafReadBuffer } from "../utils/confined-read.js";
import { MAX_MANIFEST_BYTES } from "./constants.js";
import { readDurableOperationLeafBuffer } from "./durable-leaf.js";
import type { ScannedLeafBytes } from "../utils/scanned-leaf-bytes.js";
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

/** One workspace's manifest-leaf read: the raw bytes of one bundle's manifest, within `maxBytes`. */
type OperationManifestLeafRead = (bundleId: BundleId, maxBytes: number) => Promise<CappedLeafReadBuffer>;

/**
 * What the manifest read asks of the store; no read takes a project root. TWO
 * STEPS, because the two identity failures differ: `manifestLeavesIn` THROWS for
 * an unsafe workspace id, which the body turns into `unavailable`; the returned
 * read throws or rejects for an unsafe bundle id, which the body does NOT catch.
 */
export interface OperationManifestLeafReads {
  manifestLeavesIn(workspaceId: string): OperationManifestLeafRead;
}

/** The local-disk manifest leaves for one project root, built per call. In no package index. */
export function diskOperationManifestLeafReads(root: string, scanned?: ScannedLeafBytes): OperationManifestLeafReads {
  return {
    manifestLeavesIn: (workspaceId) => {
      const paths = operationPaths(root, workspaceId);
      return (bundleId, maxBytes) => readDurableOperationLeafBuffer(
        root, paths.manifestFile(bundleId), paths.bundleRoot(bundleId), maxBytes, scanned);
    },
  };
}

/** Read one canonical immutable manifest without following aliases or links. */
export async function readOperationManifest(
  root: string,
  workspaceId: string,
  bundleId: BundleId,
  scanned?: ScannedLeafBytes,
): Promise<OperationManifestRead> {
  return readOperationManifestFrom(diskOperationManifestLeafReads(root, scanned), workspaceId, bundleId);
}

/** {@link readOperationManifest} over the reader's own leaves: the one body. */
export async function readOperationManifestFrom(
  leaves: OperationManifestLeafReads,
  workspaceId: string,
  bundleId: BundleId,
): Promise<OperationManifestRead> {
  let readLeaf: OperationManifestLeafRead;
  try {
    readLeaf = leaves.manifestLeavesIn(workspaceId);
  } catch {
    return { status: "unavailable", detail: "identity" };
  }
  const leaf = await readLeaf(bundleId, MAX_MANIFEST_BYTES);
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

/** What the create-only manifest writer asks of the store. No member takes a project root. */
export interface OperationManifestWriteSteps {
  /** Create-only durable publication: `collision` ONLY for a genuine `AtomicWriteCollisionError`; anything else rejects. */
  createManifestLeaf(workspaceId: string, bundleId: BundleId, bytes: Buffer): Promise<"created" | "collision">;
  /** The manifest read used for the collision readback. Local: `readOperationManifest(root, ...)`. */
  readManifest(workspaceId: string, bundleId: BundleId): Promise<OperationManifestRead>;
}

/** The local-disk manifest write steps for one root, built per call. In no package index. */
function diskOperationManifestWriteSteps(root: string): OperationManifestWriteSteps {
  return {
    createManifestLeaf: async (workspaceId, bundleId, bytes) => {
      const paths = operationPaths(root, workspaceId);
      try {
        await atomicWriteNoReplaceDurable(paths.manifestFile(bundleId), bytes, { confineRoot: root, exactParent: true, mode: 0o600 });
        return "created";
      } catch (error) {
        if (!(error instanceof AtomicWriteCollisionError)) throw error;
        return "collision";
      }
    },
    readManifest: (workspaceId, bundleId) => readOperationManifest(root, workspaceId, bundleId),
  };
}

/** Durably create a canonical manifest or prove an exact immutable replay. */
export async function writeOperationManifestCreateOnly(
  root: string,
  manifest: OperationBundleManifest,
): Promise<ManifestCreateResult> {
  return writeOperationManifestCreateOnlyWith(diskOperationManifestWriteSteps(root), manifest);
}

/** {@link writeOperationManifestCreateOnly} over the writer's own steps: the one body. */
export async function writeOperationManifestCreateOnlyWith(
  steps: OperationManifestWriteSteps,
  manifest: OperationBundleManifest,
): Promise<ManifestCreateResult> {
  const prepared = prepareManifest(manifest);
  const created = await steps.createManifestLeaf(prepared.manifest.workspaceId, prepared.manifest.bundleId, prepared.bytes);
  if (created === "created") return "created";
  const collision = await steps.readManifest(prepared.manifest.workspaceId, prepared.manifest.bundleId);
  if (collision.status === "ok" &&
      canonicalBytes(collision.manifest).equals(prepared.bytes)) return "same";
  throw new Error(`operation manifest conflict: ${collision.status}`);
}
