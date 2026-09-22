/**
 * @file test/capability-providers/input-exposure.test.ts
 * @description Ordered concrete input-exposure snapshots and confirmation
 * invalidation tests for Provider V2 CP-INV-26.
 */
import { describe, expect, it } from "vitest";
import {
  providerExposureDigest, providerExposureDisplay, snapshotProviderExposure,
} from "../../src/capability-providers/authority/exposure.js";
import { parseInputId, parseSha256Digest } from "../../src/capability-providers/ids.js";
import type { ProviderInputRefV1 } from "../../src/capability-providers/authority/types.js";

describe("provider concrete input exposure", () => {
  it("changes confirmation for add, replace, remove, and reorder", () => {
    const first = input("source-one", "a", 10);
    const second = input("source-two", "b", 20);
    const base = providerExposureDigest([first, second]);
    expect(providerExposureDigest([first, second, input("source-three", "c", 30)])).not.toBe(base);
    expect(providerExposureDigest([first, input("source-two", "d", 20)])).not.toBe(base);
    expect(providerExposureDigest([first])).not.toBe(base);
    expect(providerExposureDigest([second, first])).not.toBe(base);
  });

  it("snapshots caller data and enumerates every concrete input ID for display", () => {
    const callerOwned = [input("source-one", "a", 10), input("source-two", "b", 20)];
    const snapshot = snapshotProviderExposure(callerOwned);
    callerOwned.reverse();
    expect(snapshot.inputs.map((item) => item.inputId)).toEqual(["source-one", "source-two"]);
    expect(providerExposureDisplay(snapshot)).toEqual([
      expect.objectContaining({ inputId: "source-one", byteCount: 10 }),
      expect.objectContaining({ inputId: "source-two", byteCount: 20 }),
    ]);
  });

  it("rejects duplicate IDs, paths as materialized tokens, and unknown fields", () => {
    const valid = input("source-one", "a", 10);
    expect(() => snapshotProviderExposure([valid, valid])).toThrow(/duplicate/i);
    expect(() => snapshotProviderExposure([{ ...valid, materializedToken: "../source" }]))
      .toThrow(/exposure.*invalid/i);
    expect(() => snapshotProviderExposure([{ ...valid, extra: true } as ProviderInputRefV1]))
      .toThrow(/exposure.*invalid/i);
  });

  it("rejects ill-formed Unicode before digesting or display", () => {
    expect(() => providerExposureDigest([{ ...input("source-one", "a", 10),
      provenanceLabel: "bad\ud800label",
    }])).toThrow(/exposure.*invalid/i);
  });
});

function input(inputId: string, digestCharacter: string, byteCount: number): ProviderInputRefV1 {
  return {
    inputId: parseInputId(inputId), kind: "retained-source", provenanceLabel: `source ${inputId}`,
    mediaType: "text/markdown", digest: parseSha256Digest(`sha256:${digestCharacter.repeat(64)}`),
    byteCount, materializedToken: `input-${inputId}`,
  };
}
