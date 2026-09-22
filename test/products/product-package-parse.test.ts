/**
 * @file test/products/product-package-parse.test.ts
 * @description The product-package loader recomputes packageDigest and
 * runtimeAuthorityDigest from a valid canonical manifest, keeps the manifest
 * canonical across a round trip, and proves the productVersion-vs-runtime-authority
 * distinction: a version-label reissue keeps runtimeAuthorityDigest while a
 * runtime-member change alters it.
 */

import { describe, expect, it } from "vitest";
import {
  loadProductPackageManifest, recomputePackageDigest, recomputeRuntimeAuthorityDigest,
} from "../../src/products/packages/verify.js";
import { buildProductPackage, serializeManifest } from "./product-package-fixture.js";

describe("product package loader", () => {
  it("binds an optional process definition into runtime authority", () => {
    const built = buildProductPackage({ processDefinitionBody: '{"processId":"demo/v1"}' });
    const parsed = loadProductPackageManifest(built.manifestText);
    expect(parsed.processDefinition?.kind).toBe("process-definition");
    expect(parsed.runtimeAuthorityDigest).toBe(built.manifest.runtimeAuthorityDigest);
    expect(parsed.runtimeAuthorityDigest).not.toBe(buildProductPackage().manifest.runtimeAuthorityDigest);
  });
  it("accepts a valid canonical package and recomputes both digests", () => {
    const { manifest, manifestText } = buildProductPackage();
    const loaded = loadProductPackageManifest(manifestText);
    expect(recomputePackageDigest(loaded)).toBe(manifest.packageDigest);
    expect(recomputeRuntimeAuthorityDigest(loaded)).toBe(manifest.runtimeAuthorityDigest);
  });

  it("keeps the manifest canonical across a load round trip", () => {
    const { manifestText } = buildProductPackage();
    expect(serializeManifest(loadProductPackageManifest(manifestText))).toBe(manifestText);
  });

  it("keeps runtimeAuthorityDigest across a productVersion-only reissue", () => {
    const first = loadProductPackageManifest(buildProductPackage({ productVersion: "1.0.0" }).manifestText);
    const reissue = loadProductPackageManifest(buildProductPackage({ productVersion: "1.0.1" }).manifestText);
    expect(reissue.runtimeAuthorityDigest).toBe(first.runtimeAuthorityDigest);
    expect(reissue.packageDigest).not.toBe(first.packageDigest);
  });

  it("alters runtimeAuthorityDigest when a runtime member changes", () => {
    const first = loadProductPackageManifest(buildProductPackage({ knowledgeProfileBody: '{"profile":"a"}' }).manifestText);
    const changed = loadProductPackageManifest(buildProductPackage({ knowledgeProfileBody: '{"profile":"b"}' }).manifestText);
    expect(changed.runtimeAuthorityDigest).not.toBe(first.runtimeAuthorityDigest);
    expect(changed.packageDigest).not.toBe(first.packageDigest);
  });
});
