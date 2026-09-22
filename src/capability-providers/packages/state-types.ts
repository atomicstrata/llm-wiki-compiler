/**
 * @file src/capability-providers/packages/state-types.ts
 * @description Exact authoritative provider-source continuity and immutable
 * installation records. Cache bytes remain reconstructable evidence and never
 * replace either operator-owned state file.
 */
import type { TapSourceState } from "../../profile/templates/taps/state-types.js";
import type {
  ProviderCoordinateV1, ProviderIdV1, SemanticVersionV1, Sha256Digest,
} from "../types.js";

export type ProviderSourceState = TapSourceState;

export interface ProviderSourcesState {
  readonly schemaVersion: 1;
  readonly sources: Readonly<Record<string, ProviderSourceState>>;
}

export type ProviderInstallationSourceV1 = "signed-remote" | "local-development" | "builtin";

export interface ProviderInstallRecordV1 {
  readonly packageDigest: Sha256Digest;
  readonly coordinate: ProviderCoordinateV1;
  readonly providerId: ProviderIdV1;
  readonly providerVersion: SemanticVersionV1;
  readonly manifestDigest: Sha256Digest;
  readonly artifactId: string;
  readonly artifactDigest: Sha256Digest;
  readonly expandedTreeDigest: Sha256Digest;
  readonly sourceType: ProviderInstallationSourceV1;
  readonly installedAt: string;
  readonly tapSequence: number | null;
  readonly publisherKeyId: string | null;
  readonly acceptedIndexDigest: Sha256Digest | null;
}

/** Separate operator approval bound to exact local-development package bytes. */
export interface ProviderLocalApprovalV1 {
  readonly packageDigest: Sha256Digest;
  readonly approvedAt: string;
}

export interface ProviderInstallState {
  readonly schemaVersion: 1;
  readonly installs: Readonly<Record<string, ProviderInstallRecordV1>>;
  readonly localApprovals: Readonly<Record<string, ProviderLocalApprovalV1>>;
}

/** Empty source registry with no implicitly trusted TAP. */
export function emptyProviderSourcesState(): ProviderSourcesState {
  return Object.freeze({ schemaVersion: 1, sources: Object.freeze({}) });
}

/** Empty installation registry with no implicit latest selection. */
export function emptyProviderInstallState(): ProviderInstallState {
  return Object.freeze({
    schemaVersion: 1,
    installs: Object.freeze({}),
    localApprovals: Object.freeze({}),
  });
}
