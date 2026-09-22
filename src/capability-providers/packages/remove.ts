/**
 * @file src/capability-providers/packages/remove.ts
 * @description Reference-aware authoritative installation removal and explicit
 * cache-GC planning. Uninstall never deletes cache bytes; deletion remains a
 * separate confirmed operator action after every typed reference is checked.
 */
import { lstat, opendir } from "node:fs/promises";
import { MAX_PROVIDER_LOGICAL_ID_SNAPSHOT_ITEMS } from "../constants.js";
import { parseSha256Digest } from "../ids.js";
import type { Sha256Digest } from "../types.js";
import {
  assertAuthorizedProviderDirectory, assertTestAuthorizedProviderPaths,
  authorizedProviderDirectoryRealPath, bindExistingAuthorizedProviderDirectory,
  type AuthorizedProviderDirectory, type AuthorizedProviderPaths,
} from "./paths.js";
import {
  enumerateExternalProviderReferences, enumerateProviderStoreReferences, withTrustedExternalProviderReferences,
  type ExternalProviderReferenceEnumeratorV1, type WithLockedExternalProviderReferencesV1,
  type ProviderPackageReferenceV1,
} from "./reference-enumeration.js";
import { readProviderInstallState, withProviderStateLock, writeProviderInstallState } from "./state-store.js";

export interface RemoveProviderInstallationRequestV1 {
  readonly paths: AuthorizedProviderPaths;
  readonly packageDigest: Sha256Digest;
  /** @internal Trusted WOP scope; the provider lock is acquired inside it. */
  readonly withLockedExternalReferences: WithLockedExternalProviderReferencesV1;
}

export type RemoveProviderInstallationResultV1 =
  | { readonly kind: "removed"; readonly packageDigest: Sha256Digest }
  | { readonly kind: "retained"; readonly packageDigest: Sha256Digest; readonly references: readonly ProviderPackageReferenceV1[] }
  | { readonly kind: "not-installed"; readonly packageDigest: Sha256Digest };

export interface ProviderCacheGarbageCollectionPlanV1 {
  readonly candidates: readonly Sha256Digest[];
}

export interface PlanProviderCacheGarbageCollectionRequestV1 {
  readonly paths: AuthorizedProviderPaths;
  readonly enumerateExternalReferences: ExternalProviderReferenceEnumeratorV1;
  /** @internal Reduced ceiling admitted only for test-authorized roots. */
  readonly maximumCacheEntriesForTest?: number;
}

/** Remove only an unreferenced authoritative installation record under the provider lock. */
export async function removeProviderInstallation(
  request: RemoveProviderInstallationRequestV1,
): Promise<RemoveProviderInstallationResultV1> {
  const packageDigest = parseSha256Digest(request.packageDigest);
  return withTrustedExternalProviderReferences(request.withLockedExternalReferences, packageDigest, (references) => (
    withProviderStateLock(request.paths, () => removeInstalledRecord(request.paths, packageDigest, references))
  ));
}

/** List cache package digests that a later explicit, confirmed GC may delete. */
export async function planProviderCacheGarbageCollection(
  request: PlanProviderCacheGarbageCollectionRequestV1,
): Promise<ProviderCacheGarbageCollectionPlanV1> {
  const state = await readProviderInstallState(request.paths);
  const candidates = await unreferencedCacheDigests(request, new Set(Object.keys(state.installs)));
  return Object.freeze({ candidates: Object.freeze(candidates) });
}

/** Remove one record only after the external callback proves no consumer retains it. */
async function removeInstalledRecord(
  paths: AuthorizedProviderPaths,
  packageDigest: Sha256Digest,
  references: readonly ProviderPackageReferenceV1[],
): Promise<RemoveProviderInstallationResultV1> {
  const state = await readProviderInstallState(paths);
  if (!state.installs[packageDigest]) return Object.freeze({ kind: "not-installed", packageDigest });
  await enumerateProviderStoreReferences(paths, packageDigest);
  if (references.length > 0) return Object.freeze({ kind: "retained", packageDigest, references });
  await writeProviderInstallState(paths, {
    schemaVersion: 1, installs: without(state.installs, packageDigest), localApprovals: without(state.localApprovals, packageDigest),
  });
  return Object.freeze({ kind: "removed", packageDigest });
}

/** Filter actual digest-addressed cache leaves through exact external references. */
async function unreferencedCacheDigests(
  request: PlanProviderCacheGarbageCollectionRequestV1,
  installed: ReadonlySet<string>,
): Promise<Sha256Digest[]> {
  const leaves = await cacheDigestLeaves(request.paths, await cacheEntryLimit(request));
  const candidates: Sha256Digest[] = [];
  for (const packageDigest of leaves) {
    if (installed.has(packageDigest)) continue;
    const references = await enumerateExternalProviderReferences(request.enumerateExternalReferences, packageDigest);
    if (references.length === 0) candidates.push(packageDigest);
  }
  return candidates.sort();
}

/** Read only digest-shaped cache directory names; absence means no GC candidates. */
async function cacheDigestLeaves(paths: AuthorizedProviderPaths, maximumEntries: number): Promise<Sha256Digest[]> {
  const directory = await bindPackagesRoot(paths);
  if (directory === null) return [];
  const opened = await opendir(await authorizedProviderDirectoryRealPath(paths, directory));
  const leaves: Sha256Digest[] = [];
  let count = 0;
  for await (const entry of opened) {
    if (++count > maximumEntries) throw new Error("provider cache enumeration cap exceeded");
    if (entry.isDirectory() && !entry.isSymbolicLink()) addDigestLeaf(leaves, entry.name);
  }
  await assertAuthorizedProviderDirectory(paths, directory);
  return leaves;
}

/** Bind the exact packages root or classify only genuine absence as empty. */
async function bindPackagesRoot(paths: AuthorizedProviderPaths): Promise<AuthorizedProviderDirectory | null> {
  const entry = await lstat(paths.packagesRoot).catch(absentCache);
  if (entry === null) return null;
  if (!entry.isDirectory() || entry.isSymbolicLink()) throw cacheUnavailable();
  return bindExistingAuthorizedProviderDirectory(paths, paths.packagesRoot).catch(() => { throw cacheUnavailable(); });
}

/** Parse one digest-shaped directory name while ignoring unrelated inert names. */
function addDigestLeaf(leaves: Sha256Digest[], name: string): void {
  try { leaves.push(parseSha256Digest(`sha256:${name}`)); } catch { /* Inert non-package entry. */ }
}

/** Resolve a production ceiling or a bounded test-only reduction. */
async function cacheEntryLimit(request: PlanProviderCacheGarbageCollectionRequestV1): Promise<number> {
  const limit = request.maximumCacheEntriesForTest;
  if (limit === undefined) return MAX_PROVIDER_LOGICAL_ID_SNAPSHOT_ITEMS;
  await assertTestAuthorizedProviderPaths(request.paths);
  if (!Number.isSafeInteger(limit) || limit < 0 || limit > MAX_PROVIDER_LOGICAL_ID_SNAPSHOT_ITEMS) {
    throw new Error("provider cache enumeration cap is invalid");
  }
  return limit;
}

/** Translate only an absent cache directory into an empty explicit GC plan. */
function absentCache(error: unknown): null {
  if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
  throw cacheUnavailable();
}

/** Return one stable cache-store refusal without a raw path or error. */
function cacheUnavailable(): Error { return new Error("provider cache is unavailable"); }

/** Return an immutable map without one exact digest key. */
function without<Value>(values: Readonly<Record<string, Value>>, key: string): Readonly<Record<string, Value>> {
  const next = { ...values };
  delete next[key];
  return Object.freeze(next);
}
