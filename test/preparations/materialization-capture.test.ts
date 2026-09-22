/**
 * @file test/preparations/materialization-capture.test.ts
 * @description Trust-boundary cases for `captureMaterializationResult` (runner
 * design v3 §5): pack code returns the entire result, so the capture must
 * defeat getters, post-return mutation, unknown keys at every owned level, and
 * the smuggled `actor` — synchronously, returning no pack-owned reference.
 */

import { describe, expect, it } from "vitest";
import {
  MaterializationCaptureError, captureMaterializationResult,
} from "../../src/preparations/materialization.js";

/** A minimal well-formed result; each case perturbs exactly one property. */
function validResult(): Record<string, unknown> {
  return {
    targets: [{ logicalIdentity: "docs/a", draft: { kind: "lifecycle-transition" } }],
    proposals: [{ proposalId: "p-1" }],
    reconciliations: [],
    selections: [],
    completeness: { scopeId: "s", requiredDeficitCount: 0 },
    authorityInputs: [{ id: "in-1", provenance: "staged", digest: `sha256:${"a".repeat(64)}`,
      byteCount: 3, selected: true, rationaleDigest: `sha256:${"9".repeat(64)}` }],
    authorityBounds: [{ name: "wall-time", unit: "milliseconds", maximum: 1000 }],
    operationRun: { declaredCompensatorIndexes: [0], controlTransitionAllowance: 2 },
    payloadRefs: [{ role: "proposal-payload", digest: "b".repeat(64), byteCount: 9, mediaType: "application/json" }],
  };
}

describe("captureMaterializationResult", () => {
  it("captures a well-formed result and returns no pack-owned reference", () => {
    const input = validResult();
    const captured = captureMaterializationResult(input);

    expect(captured.targets).not.toBe(input.targets);
    expect(captured.operationRun).not.toBe(input.operationRun);
    expect(captured.payloadRefs[0].digest).toBe("b".repeat(64));
  });

  it("refuses a smuggled actor key on operationRun as a typed refusal, not a drop", () => {
    const input = validResult();
    input.operationRun = { declaredCompensatorIndexes: [], controlTransitionAllowance: 1, actor: { id: "evil" } };

    expect(() => captureMaterializationResult(input)).toThrow(MaterializationCaptureError);
  });

  it("refuses a getter anywhere in the result", () => {
    const input = validResult();
    Object.defineProperty(input, "targets", { get: () => [], enumerable: true, configurable: true });

    expect(() => captureMaterializationResult(input)).toThrow(MaterializationCaptureError);
  });

  it("is immune to post-return mutation of retained pack references", () => {
    const input = validResult();
    const retainedBounds = input.authorityBounds as Record<string, unknown>[];
    const captured = captureMaterializationResult(input);

    retainedBounds[0].maximum = 999_999;
    (input.operationRun as Record<string, unknown>).controlTransitionAllowance = 99;

    expect((captured.authorityBounds[0] as { maximum: number }).maximum).toBe(1000);
    expect((captured.operationRun as { controlTransitionAllowance: number }).controlTransitionAllowance).toBe(2);
  });

  it("refuses an unknown key at the result level, naming the path", () => {
    const input = { ...validResult(), surprise: 1 };

    expect(() => captureMaterializationResult(input)).toThrow(/result\.surprise/);
  });

  it("refuses an unknown key inside an array element", () => {
    const input = validResult();
    input.payloadRefs = [{ role: "identity-set", digest: "c".repeat(64), byteCount: 1, mediaType: "text/plain", extra: true }];

    expect(() => captureMaterializationResult(input)).toThrow(/payloadRefs\[0\]/);
  });

  it("refuses an unknown key even when its value is undefined", () => {
    // Adversarial finding: the exact-key filter dropped undefined-valued keys
    // before checking, so the key survived as an invisible member.
    const input = validResult();
    input.operationRun = { declaredCompensatorIndexes: [], controlTransitionAllowance: 1, actor: undefined };

    expect(() => captureMaterializationResult(input)).toThrow(/operationRun\.actor/);
  });

  it("refuses a bigint in a compiler-authority interior as a typed refusal", () => {
    // Adversarial finding: bigint survived identity capture and detonated as
    // an untyped TypeError at serialization time.
    const input = validResult();
    input.proposals = [10n];

    expect(() => captureMaterializationResult(input)).toThrow(MaterializationCaptureError);
  });

  it("enforces the selected input's rationale obligation and digest forms", () => {
    // Regular-review finding: these rules exist in the manifest parser for the
    // identical shape and were missing here.
    const unaudited = validResult();
    unaudited.authorityInputs = [{ id: "in-1", provenance: "staged",
      digest: `sha256:${"a".repeat(64)}`, byteCount: 3, selected: true }];
    expect(() => captureMaterializationResult(unaudited)).toThrow(/rationaleDigest/);

    const bareDigest = validResult();
    bareDigest.authorityInputs = [{ id: "in-1", provenance: "staged",
      digest: "a".repeat(64), byteCount: 3, selected: false }];
    expect(() => captureMaterializationResult(bareDigest)).toThrow(/authorityInputs\[0\]\.digest/);

    const numericId = validResult();
    numericId.authorityInputs = [{ id: 7, provenance: "staged",
      digest: `sha256:${"a".repeat(64)}`, byteCount: 3, selected: false }];
    expect(() => captureMaterializationResult(numericId)).toThrow(/authorityInputs\[0\]\.id/);
  });

  it("refuses a non-string target identity and bound name", () => {
    const badTarget = validResult();
    badTarget.targets = [{ logicalIdentity: 5, draft: {} }];
    expect(() => captureMaterializationResult(badTarget)).toThrow(/targets\[0\]\.logicalIdentity/);

    const badBound = validResult();
    badBound.authorityBounds = [{ name: 3, unit: "count", maximum: 1 }];
    expect(() => captureMaterializationResult(badBound)).toThrow(/authorityBounds\[0\]\.name/);
  });

  it("refuses a missing required member and a bad payload role", () => {
    const missing = validResult();
    delete missing.completeness;
    expect(() => captureMaterializationResult(missing)).toThrow(/completeness/);

    const badRole = validResult();
    badRole.payloadRefs = [{ role: "arbitrary", digest: "d".repeat(64), byteCount: 1, mediaType: "text/plain" }];
    expect(() => captureMaterializationResult(badRole)).toThrow(/payloadRefs\[0\]\.role/);
  });
});
