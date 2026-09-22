/**
 * @file test/operation-bundles/authority.test.ts
 * @description Task 1 pure-contract tests for operation authority snapshots. The
 * folded comparison digest must react to every named component, ignore key
 * ordering, fail closed on a malformed component, and the default production
 * provider must refuse to snapshot without a declarative operations authority.
 */

import { describe, expect, it } from "vitest";
import {
  authoritySnapshotDigest,
  OPERATION_AUTHORITY_COMPONENTS,
  refusingAuthorityProvider,
  type AuthoritySnapshotRequest,
  type OperationAuthoritySnapshot,
} from "../../src/operation-bundles/authority.js";
import type { OperationDigest } from "../../src/operation-bundles/types.js";

/** Build a syntactically valid sha256 digest from one repeated hex character. */
const digestOf = (hex: string): OperationDigest => `sha256:${hex.repeat(64).slice(0, 64)}` as OperationDigest;

/** A fully populated, distinct-per-component snapshot fixture. */
function sampleSnapshot(): OperationAuthoritySnapshot {
  return {
    profileDigest: digestOf("a"), operationsAuthorityDigest: digestOf("b"),
    actionDescriptorDigest: digestOf("c"), grantDigest: digestOf("d"),
    safetyFloorDigest: digestOf("e"), manifestDigest: digestOf("f"),
    payloadSetDigest: digestOf("0"), boundsDigest: digestOf("1"),
    adapterCapabilityDigest: digestOf("2"), keyEpochId: digestOf("3"),
    storeHealthDigest: digestOf("4"), preconditionDigest: digestOf("5"),
  };
}

describe("authoritySnapshotDigest", () => {
  it("changes the digest when any one component changes", () => {
    const base = authoritySnapshotDigest(sampleSnapshot());
    for (const component of OPERATION_AUTHORITY_COMPONENTS) {
      const mutated = { ...sampleSnapshot(), [component]: digestOf("9") };
      expect(authoritySnapshotDigest(mutated)).not.toBe(base);
    }
  });

  it("ignores component key ordering", () => {
    const forward = sampleSnapshot();
    const reversed = Object.fromEntries(Object.entries(forward).reverse()) as OperationAuthoritySnapshot;
    expect(authoritySnapshotDigest(reversed)).toBe(authoritySnapshotDigest(forward));
  });

  it("fails closed on a non-digest component", () => {
    const bad = { ...sampleSnapshot(), grantDigest: "not-a-digest" } as unknown as OperationAuthoritySnapshot;
    expect(() => authoritySnapshotDigest(bad)).toThrow();
  });

  it("fails closed on a missing component", () => {
    const missing = { ...sampleSnapshot() } as Partial<OperationAuthoritySnapshot>;
    delete missing.manifestDigest;
    expect(() => authoritySnapshotDigest(missing as OperationAuthoritySnapshot)).toThrow();
  });
});

describe("refusingAuthorityProvider", () => {
  it("refuses to snapshot without a declarative operations authority", async () => {
    const request = {} as unknown as AuthoritySnapshotRequest;
    const result = await refusingAuthorityProvider.computeSnapshot(request);
    expect(result.status).toBe("unavailable");
  });
});
