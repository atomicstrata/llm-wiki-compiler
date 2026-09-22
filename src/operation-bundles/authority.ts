/**
 * @file src/operation-bundles/authority.ts
 * @description Bounded operation authority snapshots (V2 §14.1). Core recomputes
 * the exact component digests immediately before every approval, apply, and
 * recovery boundary into one closed data object, then folds them into a single
 * canonical comparison digest. The component object and its digest are kept
 * separate so review can display both bounded component identities and the one
 * value used for drift comparison. The default production provider refuses to
 * snapshot when no declarative operations authority is configured; tests inject
 * a domain-neutral provider through function arguments, never global state.
 */

import { canonicalDigest } from "../profile/templates/signing/canonical.js";
import type { OperationPrincipal } from "./principal.js";
import type { OperationBundleManifest, OperationDigest } from "./types.js";

/** The exact ordered component names recomputed for one authority snapshot. */
export const OPERATION_AUTHORITY_COMPONENTS = Object.freeze([
  "profileDigest", "operationsAuthorityDigest", "actionDescriptorDigest",
  "grantDigest", "safetyFloorDigest", "manifestDigest", "payloadSetDigest",
  "boundsDigest", "adapterCapabilityDigest", "keyEpochId", "storeHealthDigest",
  "preconditionDigest",
] as const);

export type OperationAuthorityComponent = (typeof OPERATION_AUTHORITY_COMPONENTS)[number];

/** The §14.1 component digests recomputed under lock before an authority boundary. */
export type OperationAuthoritySnapshot = { [K in OperationAuthorityComponent]: OperationDigest };

/** The exact identities an authority provider needs to recompute a snapshot. */
export interface AuthoritySnapshotRequest {
  root: string;
  workspaceId: string;
  manifest: OperationBundleManifest;
  manifestDigest: OperationDigest;
  principal: OperationPrincipal;
  adapterCapabilityDigest: OperationDigest;
  keyEpochId: OperationDigest;
}

/** A recomputed snapshot with its folded comparison digest, or a fail-closed refusal. */
export type AuthoritySnapshotResult =
  | { status: "ok"; snapshot: OperationAuthoritySnapshot; digest: OperationDigest }
  | { status: "unavailable"; reason: string };

/** Core-injected declarative authority; never a manifest-supplied callback. */
export interface OperationAuthorityProvider {
  computeSnapshot(request: AuthoritySnapshotRequest): Promise<AuthoritySnapshotResult>;
}

const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

/** Require one component to be a canonical sha256 digest before it enters the tuple. */
function requireComponentDigest(value: unknown, component: OperationAuthorityComponent): OperationDigest {
  if (typeof value !== "string" || !DIGEST_PATTERN.test(value)) {
    throw new Error(`operation authority component ${component} is not a sha256 digest`);
  }
  return value as OperationDigest;
}

/**
 * Fold the exact component object into one canonical comparison digest. A fresh
 * exact object is rebuilt by naming each component, so a missing component fails
 * closed and an extra caller-attached field can never enter the tuple.
 */
export function authoritySnapshotDigest(snapshot: OperationAuthoritySnapshot): OperationDigest {
  const exact = {} as Record<OperationAuthorityComponent, OperationDigest>;
  for (const component of OPERATION_AUTHORITY_COMPONENTS) {
    exact[component] = requireComponentDigest(snapshot[component], component);
  }
  return canonicalDigest(exact) as OperationDigest;
}

/**
 * The default production provider. Milestone A ships no declarative operations
 * authority resolver, so the runtime refuses every bundle mutation until one is
 * wired; tests pass a domain-neutral provider explicitly.
 */
export const refusingAuthorityProvider: OperationAuthorityProvider = {
  async computeSnapshot(): Promise<AuthoritySnapshotResult> {
    return { status: "unavailable", reason: "no declarative operations authority is configured" };
  },
};
