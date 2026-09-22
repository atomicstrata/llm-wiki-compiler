/**
 * @file src/operation-bundles/adapters/shared.ts
 * @description Small helpers shared by the operation store adapters: exact byte
 * digesting, the plain-string binding the store seams accept, confined wiki-page
 * digest observation, and immutable bundle-payload reads. Kept in one place so
 * every adapter observes and digests through one definition.
 */

import { createHash } from "node:crypto";
import path from "node:path";
import { loadNonDefaultProfile } from "../../profile/block.js";
import type { ProfilePack } from "../../profile/types.js";
import type { AdapterApply, OperationObservation } from "../adapter-types.js";
import { readConfinedLeafBuffer } from "../../utils/confined-read.js";
import type { OperationBinding } from "../../utils/operation-binding.js";
import type { OperationAuditBinding } from "../audit-binding.js";
import { MAX_PAYLOAD_BYTES } from "../constants.js";
import { readDurableOperationLeafBuffer } from "../durable-leaf.js";
import type { BundleId } from "../ids.js";
import { operationPaths } from "../paths.js";
import type { OperationDigest, PageOperationMutation } from "../types.js";

/** Load the active non-default profile, treating any load fault as absent. */
export async function loadProfileOrUndefined(root: string): Promise<ProfilePack | undefined> {
  try {
    const loaded = await loadNonDefaultProfile(root);
    return loaded?.profile;
  } catch {
    return undefined;
  }
}

/** Digest exact raw bytes into the protocol's prefixed representation. */
export function digestBytes(bytes: Uint8Array): OperationDigest {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}` as OperationDigest;
}

/**
 * Map a post-apply re-observation to an apply result — the shared tail of adapters
 * (lifecycle, artifact) that write through an existing authority then re-observe:
 * present (applied or audit-repairable) verifies as applied; unavailable propagates;
 * anything else is a postcondition conflict.
 */
export function applyResultFromObservation(observation: OperationObservation, postStateDigest: OperationDigest): AdapterApply {
  if (observation.outcome === "applied" || observation.outcome === "partially-applied") return { status: "applied", postStateDigest };
  if (observation.outcome === "unavailable") return { status: "unavailable", detail: observation.detail ?? "target is unreadable" };
  return { status: "conflict", detail: observation.detail ?? "postcondition not met" };
}

/** The plain-string binding the store seams accept, built field-by-field. */
export function toOperationBinding(binding: OperationAuditBinding): OperationBinding {
  return { bundleId: binding.bundleId, runId: binding.runId, mutationId: binding.mutationId };
}

/** An observed leaf: absent, its exact digest, or unreadable. */
export type LeafDigest =
  | { kind: "absent" }
  | { kind: "ok"; digest: OperationDigest }
  | { kind: "unavailable" };

/** Resolve the confined wiki page leaf and its exact parent for a page mutation. */
function pageLeaf(root: string, mutation: PageOperationMutation): { file: string; parent: string } {
  const target = mutation.target;
  const parent = target.kind === "entity"
    ? path.join(root, "wiki", target.entityType)
    : path.join(root, "wiki", target.directory);
  return { file: path.join(parent, `${target.slug}.md`), parent };
}

/**
 * Read and digest one leaf through the hardened confined reader (no-follow,
 * single-link, capped) — the shared primitive every adapter's byte observation
 * routes through, so a parent-dir-swap-after-realpath TOCTOU cannot slip a
 * different file's bytes past one adapter that a sibling would have rejected.
 */
export async function confinedLeafDigest(root: string, file: string, parent: string): Promise<LeafDigest> {
  let read: Awaited<ReturnType<typeof readConfinedLeafBuffer>>;
  try {
    read = await readConfinedLeafBuffer(root, file, parent, MAX_PAYLOAD_BYTES, { requireSingleLink: true });
  } catch {
    return { kind: "unavailable" };
  }
  if (read.kind === "absent") return { kind: "absent" };
  if (read.kind !== "ok") return { kind: "unavailable" };
  return { kind: "ok", digest: digestBytes(read.body) };
}

/** Read and digest a wiki page leaf without following symlinks. */
export function readPageDigest(root: string, mutation: PageOperationMutation): Promise<LeafDigest> {
  const { file, parent } = pageLeaf(root, mutation);
  return confinedLeafDigest(root, file, parent);
}

/** An immutable bundle payload read: its bytes, absent, or unreadable. */
export type PayloadRead =
  | { kind: "ok"; bytes: Buffer }
  | { kind: "absent" }
  | { kind: "unavailable" };

/** Read the immutable bundle payload bytes bound to a mutation payloadRef. */
export async function readBundlePayload(
  root: string,
  workspaceId: string,
  bundleId: BundleId,
  payloadRef: string,
): Promise<PayloadRead> {
  const paths = operationPaths(root, workspaceId);
  let read: Awaited<ReturnType<typeof readDurableOperationLeafBuffer>>;
  try {
    read = await readDurableOperationLeafBuffer(
      root, paths.payloadFile(bundleId, payloadRef), paths.payloadsRoot(bundleId), MAX_PAYLOAD_BYTES,
    );
  } catch {
    return { kind: "unavailable" };
  }
  if (read.kind === "absent") return { kind: "absent" };
  if (read.kind !== "ok") return { kind: "unavailable" };
  return { kind: "ok", bytes: read.body };
}
