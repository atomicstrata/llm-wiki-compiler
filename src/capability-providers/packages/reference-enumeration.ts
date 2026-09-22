/**
 * @file src/capability-providers/packages/reference-enumeration.ts
 * @description Typed provider-package reference enumeration. The provider
 * store reports its own durable references while future WOP consumers supply
 * product and preparation references through a callback, never raw-file scans.
 */
import { parseSha256Digest } from "../ids.js";
import { MAX_PROVIDER_LOGICAL_ID_SNAPSHOT_ITEMS } from "../constants.js";
import type { Sha256Digest } from "../types.js";
import { captureDenseArray, captureExactRecord } from "../../utils/runtime-capture.js";
import type { AuthorizedProviderPaths } from "./paths.js";
import { readProviderInstallState } from "./state-store.js";

const REFERENCE_FIELDS = Object.freeze(["owner", "packageDigest", "referenceId"] as const);

export type ProviderPackageReferenceOwnerV1 = "provider-store" | "product" | "preparation" | "evidence";

/** One typed durable reference to exact immutable provider bytes. */
export interface ProviderPackageReferenceV1 {
  readonly owner: ProviderPackageReferenceOwnerV1;
  readonly referenceId: string;
  readonly packageDigest: Sha256Digest;
}

/** Callback owned by later consumers, not by provider-store filesystem parsing. */
export type ExternalProviderReferenceEnumeratorV1 = (
  packageDigest: Sha256Digest,
) => Promise<readonly ProviderPackageReferenceV1[]>;

/**
 * @internal Trusted WOP composition scope for reference-aware mutations.
 * The caller must hold every owning-store mutation lock and await `operation`
 * through provider commit before releasing them. This adapter validates the
 * reference snapshot; it cannot attest caller-private lock ownership or
 * promise consumption. WOP Task 7 owns the real project-lock race proof.
 */
export type WithLockedExternalProviderReferencesV1 = <Result>(
  packageDigest: Sha256Digest,
  operation: (references: readonly ProviderPackageReferenceV1[]) => PromiseLike<Result>,
) => Promise<Result>;

class TrustedProviderOperationFailure {
  constructor(readonly error: unknown) {}
}

/** Read provider-store references without learning product or preparation storage formats. */
export async function enumerateProviderStoreReferences(
  paths: AuthorizedProviderPaths,
  packageDigest: Sha256Digest,
): Promise<readonly ProviderPackageReferenceV1[]> {
  const state = await readProviderInstallState(paths);
  if (!state.installs[packageDigest]) return Object.freeze([]);
  return Object.freeze([Object.freeze({
    owner: "provider-store", referenceId: `installation:${packageDigest.slice(7, 19)}`, packageDigest,
  })]);
}

/** Validate callback references before an uninstall or GC decision trusts them. */
export async function enumerateExternalProviderReferences(
  enumerate: ExternalProviderReferenceEnumeratorV1,
  packageDigest: Sha256Digest,
): Promise<readonly ProviderPackageReferenceV1[]> {
  try { return snapshotExternalProviderReferences(await enumerate(packageDigest), packageDigest); }
  catch { throw referenceError(); }
}

/** Validate external references inside a trusted host-owned locked scope. */
export async function withTrustedExternalProviderReferences<Result>(
  withLockedReferences: WithLockedExternalProviderReferencesV1,
  packageDigest: Sha256Digest,
  operation: (references: readonly ProviderPackageReferenceV1[]) => Promise<Result>,
): Promise<Result> {
  let operationRequested = false;
  try {
    const result = await withLockedReferences(packageDigest, async (references) => {
      if (operationRequested) throw referenceError();
      operationRequested = true;
      const snapshot = snapshotExternalProviderReferences(references, packageDigest);
      try { return await operation(snapshot); }
      catch (error) { throw new TrustedProviderOperationFailure(error); }
    });
    if (!operationRequested) throw referenceError();
    return result;
  } catch (error) {
    if (error instanceof TrustedProviderOperationFailure) throw error.error;
    throw referenceError();
  }
}

/** Capture a dense callback snapshot without retaining callback-owned values. */
function snapshotExternalProviderReferences(
  references: unknown,
  packageDigest: Sha256Digest,
): readonly ProviderPackageReferenceV1[] {
  try {
    return captureDenseArray(references, MAX_PROVIDER_LOGICAL_ID_SNAPSHOT_ITEMS,
      (reference) => parseReference(reference, packageDigest), referenceError);
  } catch { throw referenceError(); }
}

/** Parse only bounded typed reference objects bound to the requested exact digest. */
function parseReference(value: unknown, packageDigest: Sha256Digest): ProviderPackageReferenceV1 {
  const reference = referenceObject(value);
  const owner = referenceOwner(reference.owner);
  const referenceId = referenceIdentifier(reference.referenceId);
  if (parseSha256Digest(reference.packageDigest) !== packageDigest) throw referenceError();
  return Object.freeze({ owner, referenceId, packageDigest });
}

/** Admit only one plain callback record before interpreting its typed fields. */
function referenceObject(value: unknown): Record<string, unknown> {
  try { return captureExactRecord(value, REFERENCE_FIELDS); }
  catch { throw referenceError(); }
}

/** Parse the closed owner vocabulary that later product consumers may report. */
function referenceOwner(value: unknown): Exclude<ProviderPackageReferenceOwnerV1, "provider-store"> {
  if (value !== "product" && value !== "preparation" && value !== "evidence") throw referenceError();
  return value;
}

/** Parse one bounded public reference label without accepting filesystem paths. */
function referenceIdentifier(value: unknown): string {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9._:-]{0,127}$/.test(value)) throw referenceError();
  return value;
}

/** Keep callback faults independent of host paths and foreign raw storage. */
function referenceError(): Error {
  return new Error("provider reference enumeration is unavailable");
}
