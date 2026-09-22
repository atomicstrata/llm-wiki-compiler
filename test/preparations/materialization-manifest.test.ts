/**
 * @file test/preparations/materialization-manifest.test.ts
 * @description Manifest round-trip and classification (runner design v3 §3.5):
 * serialization is deterministic, the parser is the same capture the writer
 * used, and zero/one/multiple manifests classify without ever picking one.
 */

import { describe, expect, it } from "vitest";
import {
  MATERIALIZATION_MANIFEST_KIND, MaterializationCaptureError,
  captureMaterializationResult, classifyMaterializationManifests,
  parseMaterializationManifest, serializeMaterializationManifest,
  type PreparationHandoffMaterializationV1,
} from "../../src/preparations/materialization.js";
import type { EvidenceRefV1 } from "../../src/preparations/types.js";

/** One complete manifest, body passed through the boundary capture first. */
function manifest(): PreparationHandoffMaterializationV1 {
  return {
    schemaVersion: 1,
    kind: MATERIALIZATION_MANIFEST_KIND,
    runId: "run-1",
    handlerContractDigest: `sha256:${"e".repeat(64)}` as PreparationHandoffMaterializationV1["handlerContractDigest"],
    grantDigest: `sha256:${"f".repeat(64)}` as PreparationHandoffMaterializationV1["grantDigest"],
    actor: { id: "operator-1", surface: "cli", grants: ["operation-bundle.approve"] },
    body: captureMaterializationResult({
      targets: [], proposals: [], reconciliations: [], selections: [],
      completeness: { scopeId: "s", requiredDeficitCount: 0 },
      authorityInputs: [], authorityBounds: [],
      operationRun: { declaredCompensatorIndexes: [], controlTransitionAllowance: 1 },
      payloadRefs: [],
    }),
  };
}

/** An evidence ref of one kind; every other field is irrelevant to the filter. */
function ref(kind: string): EvidenceRefV1 {
  return {
    kind, mediaType: "application/json", provenanceLabel: "core",
    digest: "a".repeat(64) as EvidenceRefV1["digest"], byteCount: 1,
    sensitivity: "internal" as EvidenceRefV1["sensitivity"], retention: "audit",
    producer: { kind: "host", contractDigest: "b".repeat(64) as never },
    untrusted: true,
  };
}

describe("materialization manifest", () => {
  it("round-trips byte-identically through serialize and parse", () => {
    const original = manifest();
    const bytes = serializeMaterializationManifest(original);
    const parsed = parseMaterializationManifest(bytes);

    expect(serializeMaterializationManifest(parsed).equals(bytes)).toBe(true);
    expect(parsed.actor).toEqual(original.actor);
  });

  it("serializes deterministically regardless of key insertion order", () => {
    const original = manifest();
    // Rebuild with reversed top-level insertion order; values are identical.
    const reordered = Object.fromEntries(
      Object.keys(original).reverse().map((key) => [key, original[key as keyof typeof original]]),
    ) as unknown as PreparationHandoffMaterializationV1;

    const bytes = serializeMaterializationManifest(original);
    expect(serializeMaterializationManifest(reordered).equals(bytes)).toBe(true);
  });

  it("refuses a manifest with a wrong kind, extra key, or non-JSON bytes", () => {
    const wrongKind = { ...manifest(), kind: "other-document" };
    expect(() => parseMaterializationManifest(
      serializeMaterializationManifest(wrongKind as never))).toThrow(MaterializationCaptureError);

    const extra = { ...manifest(), extra: 1 };
    expect(() => parseMaterializationManifest(
      serializeMaterializationManifest(extra as never))).toThrow(MaterializationCaptureError);

    expect(() => parseMaterializationManifest(Buffer.from("not json"))).toThrow(MaterializationCaptureError);
  });

  it("classifies zero, one, and multiple manifests without picking", () => {
    const other = ref("provider-draft");
    const one = ref(MATERIALIZATION_MANIFEST_KIND);

    expect(classifyMaterializationManifests([other])).toEqual({ status: "none" });
    expect(classifyMaterializationManifests([other, one])).toEqual({ status: "one", ref: one });
    expect(classifyMaterializationManifests([one, ref(MATERIALIZATION_MANIFEST_KIND)]))
      .toEqual({ status: "multiple", count: 2 });
  });
});
