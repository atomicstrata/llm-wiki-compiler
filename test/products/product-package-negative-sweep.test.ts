/**
 * @file test/products/product-package-negative-sweep.test.ts
 * @description The product-package loader fails closed on every attack the
 * contract names (design sections 7.1, 7.2, 7.5): duplicate keys, unknown
 * fields, unsafe ids, an uppercased digest, forbidden and archive media types,
 * member substitution, an unreferenced non-documentation member, an incomplete
 * table, a surface driving no declared resource, a duplicate logical provider
 * pin, an exceeded byte ceiling, and both digest mismatches. Each probe is
 * well-formed except the single property under test.
 */

import { describe, expect, it } from "vitest";
import { loadProductPackageManifest, recomputePackageDigest } from "../../src/products/packages/verify.js";
import { MAX_KNOWLEDGE_PROFILE_BYTES } from "../../src/products/constants.js";
import {
  ProductBoundsError, ProductIdentityError, ProductPackageError,
} from "../../src/products/problems.js";
import type {
  PackageMemberRefV1, ProductPackageManifestV1, ProviderPinV1,
} from "../../src/products/types.js";
import { buildProductPackage, digestOf, reseal, serializeManifest } from "./product-package-fixture.js";

const base = buildProductPackage();

/** Parse a JSON-object mutation that need not stay digest-consistent. */
function mutated(fn: (obj: Record<string, any>) => void): () => void {
  const obj = JSON.parse(base.manifestText) as Record<string, any>;
  fn(obj);
  return () => loadProductPackageManifest(JSON.stringify(obj));
}

/** Parse a manifest mutation resealed so only one property is malformed. */
function resealed(fn: (manifest: ProductPackageManifestV1) => void): () => void {
  const manifest = structuredClone(base.manifest);
  fn(manifest);
  return () => loadProductPackageManifest(serializeManifest(reseal(manifest)));
}

describe("product package negative sweep", () => {
  it("rejects a duplicate JSON key", () => {
    expect(() => loadProductPackageManifest(`${base.manifestText.slice(0, -1)},"schemaVersion":1}`))
      .toThrow(ProductPackageError);
  });

  it("rejects an unknown field", () => {
    expect(mutated((o) => { o.surpriseField = 1; })).toThrow(ProductPackageError);
  });

  it("rejects a wrong schemaVersion", () => {
    expect(mutated((o) => { o.schemaVersion = 2; })).toThrow(ProductPackageError);
  });

  it("rejects an unsafe product id", () => {
    expect(mutated((o) => { o.productId = "../evil"; })).toThrow(ProductIdentityError);
  });

  it("rejects an uppercased digest", () => {
    expect(mutated((o) => { o.productSpecDigest = `sha256:${"A".repeat(64)}`; })).toThrow(ProductIdentityError);
  });

  it("rejects an executable member media type", () => {
    expect(mutated((o) => { o.members.find((m: any) => m.memberId === "kp-main").mediaType = "application/x-sh"; }))
      .toThrow(ProductIdentityError);
  });

  it("rejects an archive-within-archive member media type", () => {
    expect(mutated((o) => { o.members.find((m: any) => m.memberId === "ops-root").mediaType = "application/zip"; }))
      .toThrow(ProductIdentityError);
  });

  it("rejects a substituted named member", () => {
    expect(resealed((m) => { m.knowledgeProfile.digest = m.compositionLock.digest; })).toThrow(ProductPackageError);
  });

  it("rejects an unreferenced non-documentation member", () => {
    const bytes = Buffer.from("extra-pack");
    expect(resealed((m) => {
      const extra: PackageMemberRefV1 = {
        memberId: "zz-extra", kind: "operations-pack", digest: digestOf(bytes),
        byteCount: bytes.byteLength, mediaType: "application/json",
      };
      m.members = [...m.members, extra].sort((a, b) => (a.memberId < b.memberId ? -1 : 1));
    })).toThrow(ProductPackageError);
  });

  it("rejects an incomplete member table", () => {
    expect(resealed((m) => { m.members = m.members.filter((x) => x.memberId !== "kp-main"); }))
      .toThrow(ProductPackageError);
  });

  it("rejects a surface driving no declared resource", () => {
    expect(resealed((m) => {
      m.supportedSurfaces = [{ surfaceId: "main", interactionResourceDigest: digestOf(Buffer.from("nope")) }];
    })).toThrow(ProductPackageError);
  });

  it("rejects a duplicate logical provider pin", () => {
    expect(resealed((m) => {
      // The COMPLETE pin: the manifest admits no partial identity, so two pins
      // sharing a logical identity must differ only in the package they name.
      // The coordinate EMBEDS the provider id and version, and the shared
      // parser checks they agree — a pin whose coordinate disagreed would be
      // refused before the duplicate check this case is about.
      const pin = {
        schemaVersion: 1 as const, coordinate: "tap/pub/prov@1.0.0", providerId: "prov",
        providerVersion: "1.0.0", manifestDigest: digestOf(Buffer.from("m")),
        capabilityId: "cap.read", capabilityContractVersion: "cap.read-v1",
        capabilitySchemaDigest: digestOf(Buffer.from("s")),
      } as unknown as ProviderPinV1;
      m.providerPins = [
        { ...pin, packageDigest: digestOf(Buffer.from("pa")) },
        { ...pin, packageDigest: digestOf(Buffer.from("pb")) },
      ].sort((a, b) => (a.packageDigest < b.packageDigest ? -1 : 1));
    })).toThrow(ProductPackageError);
  });

  it("rejects a member byte count over its ceiling", () => {
    expect(resealed((m) => {
      const over = MAX_KNOWLEDGE_PROFILE_BYTES + 1;
      m.knowledgeProfile.byteCount = over;
      m.members.find((x) => x.memberId === "kp-main")!.byteCount = over;
    })).toThrow(ProductBoundsError);
  });

  it("rejects a packageDigest that no longer matches", () => {
    expect(mutated((o) => { o.displayName = "Tampered"; })).toThrow(ProductPackageError);
  });

  it("rejects a runtimeAuthorityDigest that no longer matches", () => {
    expect(mutated((o) => { o.runtimeAuthorityDigest = `sha256:${"1".repeat(64)}`; })).toThrow(ProductPackageError);
  });

  // Isolates the runtimeAuthorityDigest guard: packageDigest is resealed over the
  // forged runtime digest, so it stays self-consistent and only the
  // runtimeAuthorityDigest check can fire — a forged digest with a matching
  // packageDigest is exactly what a malicious producer would emit.
  it("rejects a forged runtimeAuthorityDigest whose packageDigest is self-consistent", () => {
    const manifest = structuredClone(base.manifest);
    manifest.runtimeAuthorityDigest = `sha256:${"1".repeat(64)}` as ProductPackageManifestV1["runtimeAuthorityDigest"];
    manifest.packageDigest = recomputePackageDigest(manifest);
    expect(() => loadProductPackageManifest(serializeManifest(manifest))).toThrow(/runtimeAuthorityDigest/);
  });

  it("rejects an unsupported combination that names no dimension", () => {
    expect(resealed((m) => {
      m.compatibility = { ...m.compatibility, unsupportedCombinations: [{ reasonCode: "bare-code" }] };
    })).toThrow(ProductPackageError);
  });
});
