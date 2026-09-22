/**
 * @file test/operations-packs/readiness-cross-reference.test.ts
 * @description A provider requirement may only require a readiness dimension
 * the workspace contract actually declares.
 *
 * WHY IT FAILS CLOSED. The readiness review enumerates the WORKSPACE's declared
 * dimensions. A provider requirement naming one the contract omits therefore
 * never appears in the report at all — an operator reads a clean review while a
 * REQUIRED capability is unaccounted for, which is worse than reading that it
 * is missing. Refusing at composition turns a silent hole in the report into a
 * packaging error the author sees before publishing.
 *
 * The mirror of the existing `requiredProviderCapabilityRoles` check, and for
 * the same reason: a contract may not reference what nothing declares.
 */

import { describe, expect, it } from "vitest";
import { assertCrossReferences } from "../../src/operations-packs/composition-refs.js";
import { buildPack } from "./pack-fixture.js";
import type { WorkspaceOperationsPackV2 } from "../../src/operations-packs/types.js";

/** The fixture pack with its declared readiness dimensions replaced. */
function withDeclaredDimensions(dimensions: Array<{ dimensionId: string }>): WorkspaceOperationsPackV2 {
  const pack = buildPack();
  return {
    ...pack,
    workspaceContract: { ...pack.workspaceContract, productReadinessDimensions: dimensions },
  };
}

describe("required readiness dimensions must be declared", () => {
  it("accepts the fixture as shipped, where the required dimension IS declared", () => {
    expect(() => assertCrossReferences(buildPack())).not.toThrow();
  });

  it("REFUSES a provider requirement naming a dimension the contract never declares", () => {
    expect(() => assertCrossReferences(withDeclaredDimensions([])))
      .toThrow(/requires readiness dimension model-ready/);
  });

  it("REFUSES when the contract declares a DIFFERENT dimension than the one required", () => {
    // Near-miss rather than absence: the report would list `other-thing` and
    // silently omit the capability the provider actually requires.
    expect(() => assertCrossReferences(withDeclaredDimensions([{ dimensionId: "other-thing" }])))
      .toThrow(/requires readiness dimension model-ready/);
  });
});
