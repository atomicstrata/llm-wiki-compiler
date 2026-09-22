/**
 * @file src/capability-providers/packages/builtin-release.ts
 * @description Opaque host authority for builtin provider releases. Task 3
 * has no production builtin registry, so only isolated tests can mint entries;
 * production callers fail closed instead of relabeling arbitrary bytes.
 */
import { canonicalDigest } from "../../profile/templates/signing/canonical.js";
import type { Sha256Digest } from "../types.js";
import {
  assertAuthorizedProviderPaths, assertTestAuthorizedProviderPaths,
  type AuthorizedProviderPaths,
} from "./paths.js";
import {
  parseCapabilityProviderPackage, selectHostPlatformArtifact,
  type CapabilityProviderPackageV1, type PlatformArtifactV1,
} from "./protocol.js";

declare const hostBuiltinReleaseBrand: unique symbol;

/** Opaque authority minted only by the host-owned builtin release registry. */
export interface HostBuiltinProviderRelease {
  readonly verification: "host-builtin-provider-release";
  readonly [hostBuiltinReleaseBrand]: true;
}

/** Test-only bytes and race seams used to mint an isolated release authority. */
export interface BuiltinProviderReleaseTestRequest {
  readonly payload: unknown;
  readonly archive: Buffer;
  readonly afterPackageParentCheckForTest?: (directory: string) => Promise<void>;
  readonly afterPackageStagingOpenForTest?: (directory: string) => Promise<void>;
  readonly afterStagingCheckBeforeTreeForTest?: (directory: string) => Promise<void>;
}

export interface ResolvedBuiltinProviderRelease extends BuiltinProviderReleaseTestRequest {
  readonly payload: CapabilityProviderPackageV1;
  readonly artifact: PlatformArtifactV1;
  readonly packageDigest: Sha256Digest;
  readonly coordinate: string;
}

interface RegisteredRelease {
  readonly paths: AuthorizedProviderPaths;
  readonly material: ResolvedBuiltinProviderRelease;
}

const registeredReleases = new WeakMap<object, RegisteredRelease>();

/** @internal Mint test authority; production has no raw-byte minting path. */
export async function authorizeBuiltinProviderReleaseForTest(
  paths: AuthorizedProviderPaths,
  request: BuiltinProviderReleaseTestRequest,
): Promise<HostBuiltinProviderRelease> {
  await assertTestAuthorizedProviderPaths(paths);
  const payload = parseCapabilityProviderPackage(request.payload);
  const token = Object.freeze({
    verification: "host-builtin-provider-release",
  }) as HostBuiltinProviderRelease;
  registeredReleases.set(token, {
    paths,
    material: Object.freeze({
      ...request, payload, archive: Buffer.from(request.archive),
      artifact: selectHostPlatformArtifact(payload),
      packageDigest: canonicalDigest(payload) as Sha256Digest,
      coordinate: `builtin/${payload.publisher}/${payload.providerId}@${payload.providerVersion}`,
    }),
  });
  return token;
}

/** Resolve only a genuine authority bound to the same authorized host paths. */
export async function resolveBuiltinProviderRelease(
  paths: AuthorizedProviderPaths,
  release: HostBuiltinProviderRelease,
): Promise<ResolvedBuiltinProviderRelease> {
  await assertAuthorizedProviderPaths(paths);
  const registered = registeredReleases.get(release);
  if (!registered || registered.paths !== paths) throw new Error("host-owned builtin release authority is required");
  return { ...registered.material, archive: Buffer.from(registered.material.archive) };
}
