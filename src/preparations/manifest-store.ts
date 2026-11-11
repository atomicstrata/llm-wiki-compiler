/**
 * @file src/preparations/manifest-store.ts
 * @description Confined, canonical, create-only persistence for immutable
 * preparation manifests (design section 8.1). Reads keep absence, invalid bytes,
 * and an unavailable filesystem leg distinct so staging can fail closed; the
 * store never edits an existing manifest. Bytes are read through the shared
 * hardened durable-leaf reader (no-follow, single reserved companion) and
 * verified byte-for-byte canonical before any field is trusted.
 *
 * ONE READ BODY, OVER THE READER'S OWN LEAVES. `readPreparationManifestFrom` is
 * the single body of the read; it takes `PreparationManifestLeafReads` and no
 * project root. `readPreparationManifest` keeps its signature and delegates to
 * it over the private local-disk leaves, built on each call. What is bound is
 * THIS READER'S decisions: which cap it asks for, strict UTF-8, the closed
 * parser, the canonical-bytes rule, the identity binding, and which failure is
 * `invalid` and which `unavailable`. Path derivation, confinement, no-follow,
 * the reserved-companion check and cap ENFORCEMENT stay in the local-disk
 * leaves and the durable-leaf reader under them. Nothing here selects a backend.
 *
 * The create-only write has ONE BODY, {@link writePreparationManifestCreateOnlyWith},
 * over {@link PreparationManifestCreateSteps}: the durable no-replace creation (a
 * MECHANISM that answers whether it created or collided) and the manifest read,
 * neither of which takes a project root. Canonicalization, the cap, the binding
 * check and the collision-equality decision are in the body.
 */

import { TextDecoder } from "node:util";
import { canonicalBytes } from "../profile/templates/signing/canonical.js";
import { AtomicWriteCollisionError, atomicWriteNoReplaceDurable } from "../utils/atomic-write.js";
import { readDurableOperationLeafBuffer } from "../operation-bundles/durable-leaf.js";
import { verifiedBytesMemo } from "../utils/verified-bytes-memo.js";
import type { ScannedLeafBytes } from "../utils/scanned-leaf-bytes.js";
import type { CappedLeafReadBuffer } from "../utils/confined-read.js";
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

/**
 * Parse strict UTF-8 and require the exact RFC 8785 byte representation.
 *
 * A manifest is immutable, so every inventory scan re-read and re-verified
 * bytes it had already proven; a store of N preparations re-ran the closed
 * loader N times per stage. The leaf is still read on every call — only the
 * verdict on identical bytes is reused (see `utils/verified-bytes-memo.ts`).
 */
const parseCanonicalManifest = verifiedBytesMemo(verifyCanonicalManifest);

/** The closed parse, then the canonical-bytes rule: the verification {@link parseCanonicalManifest} remembers. */
function verifyCanonicalManifest(bytes: Buffer): PreparationManifestV1 {
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

/** One workspace's manifest-leaf read: the raw bytes of one preparation's manifest, within `maxBytes`. */
type PreparationManifestLeafRead = (preparationId: PreparationId, maxBytes: number) => Promise<CappedLeafReadBuffer>;

/**
 * What the manifest read asks of the store. Owned by the manifest reader; no
 * read takes a project root. TWO STEPS, because the two identity failures
 * differ and both are part of the contract.
 */
export interface PreparationManifestLeafReads {
  /**
   * Step one: the leaf read for one workspace. THROWS for an unsafe workspace
   * id; the body turns that throw into `unavailable`. Step two, the returned
   * read, throws or rejects for an unsafe preparation id; the body does NOT
   * catch that, so the read rejects.
   */
  manifestLeavesIn(workspaceId: string): PreparationManifestLeafRead;
}

/**
 * The local-disk manifest leaves for one project root, built per call. Path
 * derivation and the durable-leaf read are the incumbent's calls. Exported for
 * the store's leaf composition (`store-leaf-reads.ts`) only; in no package index.
 */
export function diskPreparationManifestLeafReads(root: string, scanned?: ScannedLeafBytes): PreparationManifestLeafReads {
  return {
    manifestLeavesIn: (workspaceId) => {
      const paths = preparationPaths(root, workspaceId);
      return (preparationId, maxBytes) => readDurableOperationLeafBuffer(
        root, paths.manifestFile(preparationId), paths.preparationRoot(preparationId), maxBytes, scanned);
    },
  };
}

/** Read one canonical immutable manifest without following aliases or links. */
export async function readPreparationManifest(
  root: string,
  workspaceId: string,
  preparationId: PreparationId,
  scanned?: ScannedLeafBytes,
): Promise<PreparationManifestRead> {
  return readPreparationManifestFrom(diskPreparationManifestLeafReads(root, scanned), workspaceId, preparationId);
}

/**
 * {@link readPreparationManifest} over the reader's own leaves: the one body.
 * It decides the cap, the parse, the canonical-bytes rule and the identity
 * binding; it confines nothing and trusts the leaf bytes it is handed.
 */
export async function readPreparationManifestFrom(
  leaves: PreparationManifestLeafReads,
  workspaceId: string,
  preparationId: PreparationId,
): Promise<PreparationManifestRead> {
  let readLeaf: PreparationManifestLeafRead;
  try {
    readLeaf = leaves.manifestLeavesIn(workspaceId);
  } catch {
    return { status: "unavailable", detail: "identity" };
  }
  const leaf = await readLeaf(preparationId, MAX_PREPARATION_MANIFEST_BYTES);
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

/** What one create-only manifest write asks for. No member takes a project root. */
export interface PreparationManifestCreateSteps {
  /** MECHANISM: durably create the manifest leaf without replacing one; `collision` when one is already there. Any other fault THROWS. */
  createLeaf(workspaceId: string, preparationId: PreparationId, bytes: Buffer): Promise<"created" | "collision">;
  /** The manifest now at that leaf. */
  readManifest(workspaceId: string, preparationId: PreparationId): Promise<PreparationManifestRead>;
}

/** LOCAL DISK. The incumbent confined no-replace write and manifest read for `root`, each called when asked. */
function diskPreparationManifestCreateSteps(root: string): PreparationManifestCreateSteps {
  return {
    createLeaf: async (workspaceId, preparationId, bytes) => {
      const paths = preparationPaths(root, workspaceId);
      try {
        await atomicWriteNoReplaceDurable(paths.manifestFile(preparationId), bytes, { confineRoot: root, exactParent: true, mode: 0o600 });
        return "created";
      } catch (error) {
        if (!(error instanceof AtomicWriteCollisionError)) throw error;
        return "collision";
      }
    },
    readManifest: (workspaceId, preparationId) => readPreparationManifest(root, workspaceId, preparationId),
  };
}

/** The read over the manifest store's own body, with the caller's create-only mechanism. Building it does no I/O. */
export function preparationManifestCreateStepsOver(
  leaves: PreparationManifestLeafReads, createLeaf: PreparationManifestCreateSteps["createLeaf"],
): PreparationManifestCreateSteps {
  return { createLeaf, readManifest: (workspaceId, preparationId) => readPreparationManifestFrom(leaves, workspaceId, preparationId) };
}

/** Durably create a canonical manifest or prove an exact immutable replay. */
export async function writePreparationManifestCreateOnly(
  root: string,
  manifest: PreparationManifestV1,
): Promise<ManifestCreateResult> {
  return writePreparationManifestCreateOnlyWith(diskPreparationManifestCreateSteps(root), manifest);
}

/** {@link writePreparationManifestCreateOnly} over {@link PreparationManifestCreateSteps}: THE ONE BODY. */
export async function writePreparationManifestCreateOnlyWith(
  steps: PreparationManifestCreateSteps,
  manifest: PreparationManifestV1,
): Promise<ManifestCreateResult> {
  const prepared = prepareManifest(manifest);
  const { workspaceId, preparationId } = prepared.manifest;
  if (await steps.createLeaf(workspaceId, preparationId, prepared.bytes) === "created") return "created";
  const collision = await steps.readManifest(workspaceId, preparationId);
  if (collision.status === "ok" && canonicalBytes(collision.manifest).equals(prepared.bytes)) return "same";
  throw new Error(`preparation manifest conflict: ${collision.status}`);
}
