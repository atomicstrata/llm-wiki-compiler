/**
 * @file src/operation-bundles/ids.ts
 * @description Typed Milestone A identifiers. Bundle and run identifiers are
 * opaque core-minted ULIDs; mutation and compensation identifiers are stable
 * SHA-256 derivations over the exact V2 domain-separated byte strings.
 */

import { createHash } from "node:crypto";
import { ulid } from "../relations/ulid.js";
import { MAX_MUTATIONS_PER_BUNDLE } from "./constants.js";
import {
  exactOperationIdentity,
  OperationIdentityError,
  type OperationIdentityKind,
} from "./problems.js";

export type BundleId = `bnd_${string}`;
export type OperationRunId = `opr_${string}`;
export type MutationId = `opm_${string}`;
export type CompensationId = `opc_${string}`;
export type CatalogRecordId = `cat_${string}`;

const ULID_PATTERN = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const MUTATION_DOMAIN = "llmwiki.operation-mutation.v1";
const COMPENSATION_DOMAIN = "llmwiki.operation-compensation.v1";
const CATALOG_RECORD_DOMAIN = "llmwiki.catalog-record.v1";
const PREFIXED_ULID_CODE_UNITS = 30;
const PREFIXED_DIGEST_CODE_UNITS = 68;

/** Hash one UTF-8 domain-separated identity input as lowercase SHA-256. */
function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Validate a prefixed core-minted ULID. */
function assertUlidId(
  value: unknown,
  prefix: string,
  kind: OperationIdentityKind,
): asserts value is string {
  const identity = exactOperationIdentity(value, kind, PREFIXED_ULID_CODE_UNITS);
  if (!identity.startsWith(prefix) || !ULID_PATTERN.test(identity.slice(prefix.length))) {
    throw new OperationIdentityError(kind);
  }
}

/** Validate a prefixed deterministic SHA-256 identity. */
function assertDigestId(
  value: unknown,
  prefix: string,
  kind: OperationIdentityKind,
): asserts value is string {
  const identity = exactOperationIdentity(value, kind, PREFIXED_DIGEST_CODE_UNITS);
  if (!identity.startsWith(prefix) || !SHA256_PATTERN.test(identity.slice(prefix.length))) {
    throw new OperationIdentityError(kind);
  }
}

/** Assert and brand one bundle id. */
export function assertBundleId(value: unknown): BundleId {
  assertUlidId(value, "bnd_", "bundle-id");
  return value as BundleId;
}

/** Assert and brand one operation-run id. */
export function assertOperationRunId(value: unknown): OperationRunId {
  assertUlidId(value, "opr_", "run-id");
  return value as OperationRunId;
}

/** Assert and brand one deterministic mutation id. */
export function assertMutationId(value: unknown): MutationId {
  assertDigestId(value, "opm_", "mutation-id");
  return value as MutationId;
}

/** Assert and brand one deterministic catalog physical-record id. */
export function assertCatalogRecordId(value: unknown): CatalogRecordId {
  assertDigestId(value, "cat_", "catalog-record-id");
  return value as CatalogRecordId;
}

/** Mint a new bundle id in the reserved review namespace. */
export function mintBundleId(): BundleId {
  return `bnd_${ulid()}`;
}

/** Mint a new operation-run id. */
export function mintOperationRunId(): OperationRunId {
  return `opr_${ulid()}`;
}

/** Derive the stable mutation identity for one zero-based manifest index. */
export function mutationId(bundleId: BundleId, index: number): MutationId {
  assertBundleId(bundleId);
  if (!Number.isSafeInteger(index) || index < 0 || index >= MAX_MUTATIONS_PER_BUNDLE) {
    throw new OperationIdentityError("mutation-index");
  }
  const input = [MUTATION_DOMAIN, bundleId, String(index)].join("\0");
  return `opm_${sha256(input)}`;
}

/** Derive the stable compensation identity for one mutation. */
export function compensationId(mutation: MutationId): CompensationId {
  assertMutationId(mutation);
  return `opc_${sha256([COMPENSATION_DOMAIN, mutation].join("\0"))}`;
}

/** Derive the one physical catalog identity authorized by a mutation. */
export function catalogRecordId(mutation: MutationId): CatalogRecordId {
  assertMutationId(mutation);
  return `cat_${sha256([CATALOG_RECORD_DOMAIN, mutation].join("\0"))}`;
}

/**
 * Brand tripwires — these fail to COMPILE if a template-literal id is widened.
 * See `src/types/brand-assertions.ts` for why they sit in production code.
 */
import type { BrandAssertFalse, BrandAssignable, BrandProbe } from "../types/brand-assertions.js";

type _BundleIdIsBranded = BrandAssertFalse<BrandAssignable<BrandProbe, BundleId>>;
type _OperationRunIdIsBranded = BrandAssertFalse<BrandAssignable<BrandProbe, OperationRunId>>;
type _MutationIdIsBranded = BrandAssertFalse<BrandAssignable<BrandProbe, MutationId>>;
type _CompensationIdIsBranded = BrandAssertFalse<BrandAssignable<BrandProbe, CompensationId>>;
type _CatalogRecordIdIsBranded = BrandAssertFalse<BrandAssignable<BrandProbe, CatalogRecordId>>;
