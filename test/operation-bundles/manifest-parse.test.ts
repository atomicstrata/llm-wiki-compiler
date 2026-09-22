/**
 * @file test/operation-bundles/manifest-parse.test.ts
 * @description Exercises the bounded, duplicate-key-free operation manifest
 * parser, its AO-04 evidence fields, and RFC 8785 digest binding.
 */

import { describe, expect, it } from "vitest";
import { MAX_MANIFEST_BYTES } from "../../src/operation-bundles/constants.js";
import { mutationId, type BundleId } from "../../src/operation-bundles/ids.js";
import {
  operationManifestDigest,
  parseOperationManifest,
} from "../../src/operation-bundles/manifest-parse.js";
import { canonicalDigest } from "../../src/profile/templates/signing/canonical.js";

const BUNDLE_ID = "bnd_01J00000000000000000000000" as BundleId;
const RUN_ID = "opr_01J00000000000000000000000";
const RAW_DIGEST = "a".repeat(64);
const DIGEST = `sha256:${RAW_DIGEST}`;

/** Complete immutable fixture copied before each mutation-oriented test. */
const VALID_MANIFEST: Record<string, unknown> = {
    schemaVersion: 1,
    bundleId: BUNDLE_ID,
    runId: RUN_ID,
    workspaceId: "research",
    createdAt: "2026-07-17T00:00:00.000Z",
    createdBy: "operator",
    knowledgeAuthority: { id: "knowledge", digest: DIGEST },
    operationsAuthority: {
      packId: "research-operations",
      packDigest: DIGEST,
      actionId: "compile",
      actionDescriptorDigest: DIGEST,
    },
    grantDigest: DIGEST,
    safetyFloorDigest: DIGEST,
    inputs: [{
      id: "source-1", provenance: "fixture", digest: DIGEST, byteCount: 4,
      selected: true, rationaleDigest: DIGEST,
    }],
    preparationEvidence: [{
      type: "adapter-result", provenance: "fixture", digest: DIGEST,
      byteCount: 4, payloadRef: RAW_DIGEST,
    }],
    bounds: [{ name: "payload-bytes", unit: "bytes", maximum: 1024 }],
    completeness: {
      attempted: 1, completed: 1, skipped: 0, failed: 0,
      requiredMissing: 0, optionalMissing: 0, rationaleDigest: DIGEST,
    },
    reconciliations: [{
      id: "reconciliation-1", findingDigest: DIGEST,
      resolution: "create-distinct", rationaleDigest: DIGEST,
    }],
    mutations: [{
      index: 0,
      mutationId: mutationId(BUNDLE_ID, 0),
      kind: "page",
      operation: "create",
      target: { kind: "entity", entityType: "concept", slug: "bounded-parser" },
      payloadRef: RAW_DIGEST,
      precondition: { kind: "absent" },
      postcondition: { digest: DIGEST, byteCount: 4 },
      dependsOn: [],
      reconciliationRefs: ["reconciliation-1"],
    }],
    planningWarnings: [],
};

/** Build one complete, independently mutable version-one manifest. */
function manifest(): Record<string, unknown> {
  return structuredClone(VALID_MANIFEST);
}

describe("operation manifest parser", () => {
  it("parses every required manifest and AO-04 field", () => {
    const parsed = parseOperationManifest(JSON.stringify(manifest()));

    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.inputs[0]).toMatchObject({ selected: true, byteCount: 4 });
    expect(parsed.preparationEvidence[0]?.payloadRef).toBe(RAW_DIGEST);
    expect(parsed.completeness).toMatchObject({ attempted: 1, completed: 1 });
    expect(parsed.mutations[0]?.reconciliationRefs).toEqual(["reconciliation-1"]);
  });

  it("delegates manifest identity to the shared canonical digest", () => {
    const parsed = parseOperationManifest(JSON.stringify(manifest()));

    expect(operationManifestDigest(parsed)).toBe(canonicalDigest(parsed));
    expect(operationManifestDigest(parsed)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("rejects duplicate JSON keys before ordinary parsing", () => {
    expect(() => parseOperationManifest('{"schemaVersion":1,"schemaVersion":1}'))
      .toThrow(/duplicate JSON key/);
  });

  it("rejects unknown top-level and nested fields", () => {
    const top = { ...manifest(), executable: "run()" };
    const nested = manifest();
    (nested.knowledgeAuthority as Record<string, unknown>).extra = true;

    expect(() => parseOperationManifest(JSON.stringify(top))).toThrow(/unknown/);
    expect(() => parseOperationManifest(JSON.stringify(nested))).toThrow(/unknown/);
  });

  it.each(["transcript", "function", "executable"])(
    "rejects embedded preparation evidence field %s",
    (field) => {
      const value = manifest();
      const evidence = (value.preparationEvidence as Array<Record<string, unknown>>)[0]!;
      evidence[field] = "provider-controlled execution";

      expect(() => parseOperationManifest(JSON.stringify(value))).toThrow(/unknown/);
    },
  );

  it("binds retained evidence payload identity to its declared digest", () => {
    const value = manifest();
    const evidence = (value.preparationEvidence as Array<Record<string, unknown>>)[0]!;
    evidence.payloadRef = "b".repeat(64);

    expect(() => parseOperationManifest(JSON.stringify(value))).toThrow(/evidence.*payload/i);
  });

  it("enforces bounded lists and internally consistent completeness counts", () => {
    const tooMany = manifest();
    tooMany.inputs = Array.from({ length: 257 }, (_, index) => ({
      id: `source-${index}`, provenance: "fixture", digest: DIGEST,
      byteCount: 1, selected: false,
    }));
    const inconsistent = manifest();
    (inconsistent.completeness as Record<string, unknown>).completed = 2;

    expect(() => parseOperationManifest(JSON.stringify(tooMany))).toThrow(/inputs/);
    expect(() => parseOperationManifest(JSON.stringify(inconsistent))).toThrow(/completeness/);
  });

  it("rejects a manifest over the four-MiB byte cap", () => {
    const oversized = { ...manifest(), createdBy: "x".repeat(MAX_MANIFEST_BYTES) };

    expect(() => parseOperationManifest(JSON.stringify(oversized))).toThrow(/byte cap/);
  });

  it("rejects malformed authority, digest, count, and timestamp values", () => {
    const cases = [
      ["authority", (value: Record<string, unknown>) => {
        (value.knowledgeAuthority as Record<string, unknown>).digest = "sha256:ABC";
      }],
      ["count", (value: Record<string, unknown>) => {
        (value.completeness as Record<string, unknown>).failed = -1;
      }],
      ["timestamp", (value: Record<string, unknown>) => { value.createdAt = "yesterday"; }],
    ] as const;

    for (const [_name, mutate] of cases) {
      const value = manifest();
      mutate(value);
      expect(() => parseOperationManifest(JSON.stringify(value))).toThrow();
    }
  });
});
