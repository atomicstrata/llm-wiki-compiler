/**
 * @file test/products/product-package-fixture.ts
 * @description Builds a valid, canonical version-one product package for the
 * product-package tests: correct per-member digests, a complete member table,
 * surface-driven interaction resources, and recomputed packageDigest and
 * runtimeAuthorityDigest. `reseal` recomputes both digests after a mutation so a
 * negative test can probe exactly one property while every other stays
 * well-formed, and `serializeManifest`/`writeSourcePackage` render the on-disk layout the
 * installer consumes.
 */

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { canonicalBytes } from "../../src/profile/templates/signing/canonical.js";
import {
  recomputePackageDigest, recomputeRuntimeAuthorityDigest,
} from "../../src/products/packages/verify.js";
import { defaultHostCompatibility } from "../../src/products/compatibility.js";
import type { Sha256Digest } from "../../src/products/ids.js";
import type {
  PackageMemberKind, PackageMemberRefV1, ProductCompatibilityV1, ProductPackageManifestV1,
} from "../../src/products/types.js";

const PLACEHOLDER = `sha256:${"0".repeat(64)}` as Sha256Digest;

/** A built package: its manifest, member bytes keyed by digest hex, and text. */
export interface BuiltProductPackage {
  manifest: ProductPackageManifestV1;
  bytesByHex: Map<string, Buffer>;
  manifestText: string;
}

/** Options that vary the member bodies the fixture-consuming tests exercise. */
export interface BuildOptions {
  productVersion?: string;
  knowledgeProfileBody?: string;
  /** Override the root operations-pack member body (defaults to an inert stub). */
  operationsPackBody?: string;
  /** Override the composition-lock member body (defaults to an inert stub). */
  compositionLockBody?: string;
  /** Optional canonical process-definition member body. */
  processDefinitionBody?: string;
}

/** Return the branded `sha256:`-prefixed digest of some bytes. */
export function digestOf(bytes: Buffer): Sha256Digest {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}` as Sha256Digest;
}

/** Return the 64-hex suffix a member file is stored under. */
function hexOf(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Build one immutable member reference over some bytes. */
function refOf(memberId: string, kind: PackageMemberKind, mediaType: string, bytes: Buffer): PackageMemberRefV1 {
  return { memberId, kind, digest: digestOf(bytes), byteCount: bytes.byteLength, mediaType };
}

const COMPATIBILITY: ProductCompatibilityV1 = defaultHostCompatibility();

/** Order members by id, the canonical member-table order the parser requires. */
function byMemberId(members: PackageMemberRefV1[]): PackageMemberRefV1[] {
  return [...members].sort((a, b) => (a.memberId < b.memberId ? -1 : a.memberId > b.memberId ? 1 : 0));
}

/** Recompute both digests over a manifest whose other fields may have changed. */
export function reseal(manifest: ProductPackageManifestV1): ProductPackageManifestV1 {
  const clone = structuredClone(manifest);
  clone.runtimeAuthorityDigest = recomputeRuntimeAuthorityDigest(clone);
  clone.packageDigest = recomputePackageDigest(clone);
  return clone;
}

/** Render one manifest as the canonical UTF-8 text the store persists. */
export function serializeManifest(manifest: ProductPackageManifestV1): string {
  return canonicalBytes(manifest).toString("utf8");
}

/** Assemble every member reference and its bytes for the demo package. */
function buildMembers(options: BuildOptions): {
  refs: Record<string, PackageMemberRefV1>; bytesByHex: Map<string, Buffer>;
} {
  const bytes = {
    kp: Buffer.from(options.knowledgeProfileBody ?? '{"profile":"kp"}'),
    ops: Buffer.from(options.operationsPackBody ?? '{"pack":"root"}'),
    lock: Buffer.from(options.compositionLockBody ?? '{"lock":true}'),
    ix: Buffer.from('{"surface":"main"}'), ledger: Buffer.from('{"ledger":[]}'),
    ...(options.processDefinitionBody === undefined ? {} : { process: Buffer.from(options.processDefinitionBody) }),
  };
  const refs = {
    kp: refOf("kp-main", "knowledge-profile", "application/json", bytes.kp),
    ops: refOf("ops-root", "operations-pack", "application/json", bytes.ops),
    lock: refOf("lock-root", "composition-lock", "application/json", bytes.lock),
    ix: refOf("ix-main", "interaction-resource", "application/json", bytes.ix),
    ledger: refOf("ledger-main", "parity-ledger", "application/json", bytes.ledger),
    ...(bytes.process === undefined ? {} : {
      process: refOf("process-main", "process-definition", "application/json", bytes.process),
    }),
  };
  const bytesByHex = new Map(Object.values(bytes).map((value) => [hexOf(value), value]));
  return { refs, bytesByHex };
}

/** Build a valid, canonical demo product package with recomputed digests. */
export function buildProductPackage(options: BuildOptions = {}): BuiltProductPackage {
  const { refs, bytesByHex } = buildMembers(options);
  const draft: ProductPackageManifestV1 = {
    schemaVersion: 1, productId: "com.example.demo", productVersion: options.productVersion ?? "1.0.0",
    displayName: "Demo Product", publisher: "Example Publisher",
    packageDigest: PLACEHOLDER, runtimeAuthorityDigest: PLACEHOLDER,
    minLlmwikiVersion: "0.1.0", productSpecDigest: digestOf(Buffer.from("product-spec")),
    members: byMemberId(Object.values(refs)),
    knowledgeProfile: refs.kp, rootOperationsPack: refs.ops, compositionLock: refs.lock,
    providerPins: [], interactionResources: [refs.ix], parityLedger: refs.ledger,
    compatibility: COMPATIBILITY,
    supportedSurfaces: [{ surfaceId: "main", interactionResourceDigest: refs.ix.digest }],
    supportedLocales: ["en"], createdAt: "1970-01-01T00:00:00.000Z",
    ...(refs.process === undefined ? {} : { processDefinition: refs.process }),
  };
  const manifest = reseal(draft);
  return { manifest, bytesByHex, manifestText: serializeManifest(manifest) };
}

/** Write one built package into the on-disk source layout the installer reads. */
export async function writeSourcePackage(dir: string, pkg: BuiltProductPackage): Promise<string> {
  await mkdir(path.join(dir, "members"), { recursive: true });
  await writeFile(path.join(dir, "manifest.json"), canonicalBytes(pkg.manifest));
  for (const [hex, bytes] of pkg.bytesByHex) await writeFile(path.join(dir, "members", hex), bytes);
  return dir;
}
