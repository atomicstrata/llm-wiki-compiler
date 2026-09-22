/**
 * @file test/operation-bundles/manifest-grammar.test.ts
 * @description Pins the seven-kind operation grammar, namespace fields,
 * deterministic mutation IDs, and backward-only dependency topology.
 */

import { describe, expect, it } from "vitest";
import { MAX_RECIPE_ID_BYTES } from "../../src/operation-bundles/constants.js";
import { catalogRecordId, mutationId, type BundleId } from "../../src/operation-bundles/ids.js";
import { parseOperationManifest } from "../../src/operation-bundles/manifest-parse.js";
import { WINDOWS_RESERVED_DEVICE_NAMES } from "./windows-reserved-names.js";

const BUNDLE_ID = "bnd_01J00000000000000000000000" as BundleId;
const RAW = "b".repeat(64);
const DIGEST = `sha256:${RAW}`;
const WINDOWS_DEVICE_DIRECTORY_IDS = WINDOWS_RESERVED_DEVICE_NAMES;

/** Build the common mutation envelope around one kind-specific core. */
function mutation(index: number, core: Record<string, unknown>): Record<string, unknown> {
  return {
    index, mutationId: mutationId(BUNDLE_ID, index), dependsOn: [],
    reconciliationRefs: [], ...core,
  };
}

/** Build one indexed projection mutation for cross-target checks. */
function projectionMutation(index: number, output: string): Record<string, unknown> {
  return mutation(index, {
    kind: "projection", operation: "render",
    target: { recipeId: "brief", recipeDigest: DIGEST, output, criticality: "required" },
    precondition: { kind: "absent" }, postcondition: { digest: DIGEST },
  });
}

/** Immutable minimal grammar fixture for every launch kind. */
const VALID_MUTATIONS: Array<Record<string, unknown>> = [
    mutation(0, {
      kind: "source-retain", operation: "create", target: { digest: RAW },
      payloadRef: RAW, precondition: { kind: "absent-or-same", digest: DIGEST, byteCount: 4 },
      postcondition: { digest: DIGEST, byteCount: 4 },
    }),
    mutation(0, {
      kind: "page", operation: "create", target: { kind: "entity", entityType: "concept", slug: "page" },
      payloadRef: RAW, precondition: { kind: "absent" },
      postcondition: { digest: DIGEST, byteCount: 4 },
    }),
    mutation(0, {
      kind: "relation", operation: "create",
      target: { relationType: "supports", from: "concept/a", to: "concept/b" },
      precondition: { kind: "absent" }, postcondition: { digest: DIGEST, recordId: "rel-1" },
    }),
    mutation(0, {
      kind: "lifecycle-transition", operation: "transition",
      target: { entityType: "claim", slug: "claim-1" },
      precondition: { kind: "state", state: "draft", pageDigest: DIGEST },
      postcondition: { state: "reviewed", pageDigest: DIGEST, eventDigest: DIGEST },
    }),
    mutation(0, {
      kind: "artifact", operation: "create",
      target: { artifactType: "report", logicalId: "report-1" }, payloadRef: RAW,
      precondition: { kind: "absent" },
      postcondition: { digest: DIGEST, manifestDigest: DIGEST, auditDigest: DIGEST },
    }),
    mutation(0, {
      kind: "catalog-record", operation: "create",
      target: { logicalRecordId: "source-1" }, payloadRef: RAW,
      precondition: { kind: "absent" },
      postcondition: { digest: DIGEST, recordId: catalogRecordId(mutationId(BUNDLE_ID, 0)) },
    }),
    mutation(0, {
      kind: "projection", operation: "render",
      target: {
        recipeId: "brief", recipeDigest: DIGEST, output: "daily/brief.md", criticality: "required",
      },
      precondition: { kind: "absent" }, postcondition: { digest: DIGEST },
    }),
];

/** Return independently mutable copies of every valid launch mutation. */
function validMutations(): Array<Record<string, unknown>> {
  return structuredClone(VALID_MUTATIONS);
}

/** Wrap mutations in the smallest complete manifest accepted by Task 2. */
function serialized(mutations: Array<Record<string, unknown>>): string {
  return JSON.stringify({
    schemaVersion: 1, bundleId: BUNDLE_ID, runId: "opr_01J00000000000000000000000",
    workspaceId: "research", createdAt: "2026-07-17T00:00:00.000Z", createdBy: "operator",
    knowledgeAuthority: { id: "knowledge", digest: DIGEST },
    operationsAuthority: {
      packId: "ops", packDigest: DIGEST, actionId: "compile", actionDescriptorDigest: DIGEST,
    },
    grantDigest: DIGEST, safetyFloorDigest: DIGEST, inputs: [], preparationEvidence: [],
    bounds: [], completeness: {
      attempted: 0, completed: 0, skipped: 0, failed: 0,
      requiredMissing: 0, optionalMissing: 0, rationaleDigest: DIGEST,
    },
    reconciliations: [], mutations, planningWarnings: [],
  });
}

describe("operation manifest mutation grammar", () => {
  it.each(validMutations().map((item) => [item.kind, item]))(
    "accepts the minimal %s mutation",
    (_kind, value) => expect(parseOperationManifest(serialized([value]))).toBeDefined(),
  );

  it.each(validMutations().map((item) => [item.kind, item]))(
    "rejects unknown fields and illegal dependencies for %s",
    (_kind, value) => {
      expect(() => parseOperationManifest(serialized([{ ...value, executable: "run" }]))).toThrow(/unknown/);
      expect(() => parseOperationManifest(serialized([{ ...value, dependsOn: [0] }]))).toThrow(/dependency/);
    },
  );

  it("accepts a raw default-page target through its existing identity floor", () => {
    const rawPage = {
      ...validMutations()[1]!,
      target: { kind: "raw", directory: "notes", slug: "café-society" },
    };

    expect(parseOperationManifest(serialized([rawPage])).mutations[0]?.target)
      .toEqual({ kind: "raw", directory: "notes", slug: "café-society" });
  });

  it.each([
    ["source-retain", "update"], ["page", "delete"], ["relation", "delete"],
    ["lifecycle-transition", "create"], ["artifact", "update"],
    ["catalog-record", "rewrite"], ["projection", "publish"],
  ])("rejects wrong %s operation %s", (kind, operation) => {
    const value = validMutations().find((item) => item.kind === kind)!;
    expect(() => parseOperationManifest(serialized([{ ...value, operation }]))).toThrow();
  });

  it.each(["source-retain", "page", "artifact", "catalog-record"])(
    "requires a payload for %s",
    (kind) => {
      const value = { ...validMutations().find((item) => item.kind === kind) };
      delete value.payloadRef;
      expect(() => parseOperationManifest(serialized([value]))).toThrow(/payload/);
    },
  );

  it.each(["relation", "lifecycle-transition", "projection"])(
    "forbids arbitrary payload bytes for %s",
    (kind) => {
      const value = validMutations().find((item) => item.kind === kind)!;
      expect(() => parseOperationManifest(serialized([{ ...value, payloadRef: RAW }]))).toThrow(/payload/);
    },
  );

  it("retains bounded relation attributes and citation evidence", () => {
    const relation = { ...validMutations()[2]!,
      attributes: { confidence: 0.75, labels: ["reviewed"] },
      evidence: [{ sourcePath: "sources/paper.md", sourceSpan: "L10-L14" }],
    };

    expect(parseOperationManifest(serialized([relation])).mutations[0]).toMatchObject({
      attributes: relation.attributes, evidence: relation.evidence,
    });
  });

  it("retains bounded declared lifecycle evidence", () => {
    const lifecycle = { ...validMutations()[3]!,
      evidence: { reviewer: "alice", score: 0.9, checks: [true, false] },
    };

    expect(parseOperationManifest(serialized([lifecycle])).mutations[0])
      .toMatchObject({ evidence: lifecycle.evidence });
  });

  it("rejects over-deep declared data", () => {
    let nested: Record<string, unknown> = { value: true };
    for (let index = 0; index < 10; index += 1) nested = { nested };
    const relation = { ...validMutations()[2]!, attributes: nested };

    expect(() => parseOperationManifest(serialized([relation]))).toThrow(/depth/);
  });

  it.each(["git", "filesystem", "network", "page-delete", "artifact-delete"])(
    "rejects deferred kind %s",
    (kind) => {
      const value = { ...validMutations()[0]!, kind, operation: "commit" };
      expect(() => parseOperationManifest(serialized([value]))).toThrow(/kind/);
    },
  );

  it("rejects unsafe projection output and source caller path", () => {
    const projection = { ...validMutations()[6]!, target: {
      recipeId: "brief", recipeDigest: DIGEST, output: "../../wiki/x.md", criticality: "required",
    } };
    const source = { ...validMutations()[0]!, target: { digest: RAW, path: "wiki/x.md" } };

    expect(() => parseOperationManifest(serialized([projection]))).toThrow(/output/);
    expect(() => parseOperationManifest(serialized([source]))).toThrow(/unknown/);
  });

  it.each([".hidden/brief.md", "daily report/brief.md"])(
    "rejects unsafe projection component %s",
    (output) => {
      const projection = { ...validMutations()[6]!, target: {
        recipeId: "brief", recipeDigest: DIGEST, output, criticality: "required",
      } };
      expect(() => parseOperationManifest(serialized([projection]))).toThrow(/output/);
    },
  );

  it.each(["con.md", "nested/prn.json", "aux.bin", "nul", "com1.md", "com9.md", "lpt1.md", "lpt9.md"])(
    "rejects Windows device projection output %s",
    (output) => expect(() => parseOperationManifest(serialized([projectionMutation(0, output)]))).toThrow(/output/),
  );

  it.each([
    "daily/brief.md.llmwiki-projection.json",
    "daily/brief.md.LLMWIKI-PROJECTION.JSON",
    "daily.llmwiki-projection.json/brief.md",
    "daily.LLMWIKI-PROJECTION.JSON/brief.md",
    "Daily/brief.md",
    "daily/Café.md",
    "daily/café.md",
    "daily/café.md",
  ])("rejects portable or reserved projection alias %s", (output) => {
    expect(() => parseOperationManifest(serialized([projectionMutation(0, output)]))).toThrow(/output/);
  });

  it.each([
    ["daily/brief.md", "daily/brief.md"],
    ["daily", "daily/brief.md"],
    ["daily/brief.md", "daily"],
  ])("rejects projection target or ancestor aliases %s and %s", (first, second) => {
    expect(() => parseOperationManifest(serialized([
      projectionMutation(0, first), projectionMutation(1, second),
    ]))).toThrow(/projection.*alias|ancestor/i);
  });

  it("rejects an ancestor even when a lexical neighbor sorts between its child", () => {
    expect(() => parseOperationManifest(serialized([
      projectionMutation(0, "daily"),
      projectionMutation(1, "daily-archive"),
      projectionMutation(2, "daily/brief.md"),
    ]))).toThrow(/projection.*alias|ancestor/i);
  });

  it("rejects a projection recipe id above the owned-path byte cap", () => {
    const projection = { ...validMutations()[6]!, target: {
      recipeId: "a".repeat(MAX_RECIPE_ID_BYTES + 1), recipeDigest: DIGEST,
      output: "brief.md", criticality: "required",
    } };

    expect(() => parseOperationManifest(serialized([projection]))).toThrow(/recipe|bounded/);
  });

  it.each(WINDOWS_DEVICE_DIRECTORY_IDS)("rejects Windows device recipe id %s", (recipeId) => {
    const projection = { ...validMutations()[6]!, target: {
      recipeId, recipeDigest: DIGEST, output: "brief.md", criticality: "required",
    } };

    expect(() => parseOperationManifest(serialized([projection]))).toThrow(/recipe|identity/i);
  });

  it("rejects unsafe artifact and catalog identities", () => {
    const artifact = { ...validMutations()[4]!, target: { artifactType: "../reports", logicalId: "report-1" } };
    const catalog = { ...validMutations()[5]!, target: { logicalRecordId: "../source" } };
    const catalogPost = structuredClone(validMutations()[5]!);
    catalogPost.postcondition = { digest: DIGEST, recordId: "../physical" };

    expect(() => parseOperationManifest(serialized([artifact]))).toThrow(/artifact/);
    expect(() => parseOperationManifest(serialized([catalog]))).toThrow(/catalog/);
    expect(() => parseOperationManifest(serialized([catalogPost]))).toThrow(/catalog record id|recordId/);
  });

  it("binds catalog postconditions to the current mutation identity", () => {
    const catalog = structuredClone(validMutations()[5]!);
    catalog.postcondition = { digest: DIGEST, recordId: `cat_${"0".repeat(64)}` };

    expect(() => parseOperationManifest(serialized([catalog]))).toThrow(/derived|identity/);
  });

  it("requires catalog predecessors to use the physical-record grammar", () => {
    const catalog = structuredClone(validMutations()[5]!);
    catalog.operation = "supersede";
    catalog.target = { logicalRecordId: "source-1", supersedesRecordId: "cat-prior" };
    catalog.precondition = { kind: "record", recordId: "cat-prior", digest: DIGEST };

    expect(() => parseOperationManifest(serialized([catalog]))).toThrow(/catalog|recordId|identity/);
  });

  it("binds append-shaped preconditions and retained-source byte claims", () => {
    const source = structuredClone(validMutations()[0]!);
    (source.postcondition as Record<string, unknown>).byteCount = 5;
    const relation = structuredClone(validMutations()[2]!);
    relation.operation = "supersede";
    relation.target = { ...(relation.target as object), relationId: "rel-prior" };
    relation.precondition = { kind: "record", recordId: "rel-other", digest: DIGEST };
    const catalog = structuredClone(validMutations()[5]!);
    catalog.operation = "supersede";
    catalog.target = { logicalRecordId: "source-1", supersedesRecordId: catalogRecordId(mutationId(BUNDLE_ID, 1)) };
    catalog.precondition = { kind: "record", recordId: catalogRecordId(mutationId(BUNDLE_ID, 2)), digest: DIGEST };

    expect(() => parseOperationManifest(serialized([source]))).toThrow(/byteCount/);
    expect(() => parseOperationManifest(serialized([relation]))).toThrow(/prior/);
    expect(() => parseOperationManifest(serialized([catalog]))).toThrow(/prior/);
  });

  it("rejects malformed typed relation endpoint identities", () => {
    const relation = { ...validMutations()[2]!, target: {
      relationType: "supports", from: "../claim", to: "concept/b",
    } };

    expect(() => parseOperationManifest(serialized([relation]))).toThrow(/endpoint/);
  });

  it("rejects uppercase payload references and a recomputed ID mismatch", () => {
    const uppercase = { ...validMutations()[1]!, payloadRef: RAW.toUpperCase() };
    const wrongId = { ...validMutations()[1]!, mutationId: `opm_${"0".repeat(64)}` };

    expect(() => parseOperationManifest(serialized([uppercase]))).toThrow(/payload/);
    expect(() => parseOperationManifest(serialized([wrongId]))).toThrow(/mutationId/);
  });

  it("rejects gaps, forward dependencies, and duplicate dependencies", () => {
    const first = validMutations()[1]!;
    const gap = { ...validMutations()[2]!, index: 2, mutationId: mutationId(BUNDLE_ID, 2) };
    const forward = { ...first, dependsOn: [1] };
    const duplicate = { ...validMutations()[2]!, index: 1, mutationId: mutationId(BUNDLE_ID, 1), dependsOn: [0, 0] };

    expect(() => parseOperationManifest(serialized([first, gap]))).toThrow(/contiguous/);
    expect(() => parseOperationManifest(serialized([forward]))).toThrow(/dependency/);
    expect(() => parseOperationManifest(serialized([first, duplicate]))).toThrow(/dependency/);
  });

  it("forbids authoritative work from depending on a projection", () => {
    const projection = validMutations()[6]!;
    const page = {
      ...validMutations()[1]!, index: 1, mutationId: mutationId(BUNDLE_ID, 1), dependsOn: [0],
    };

    expect(() => parseOperationManifest(serialized([projection, page])))
      .toThrow(/projection/);
  });

  it("rejects incompatible kind-specific fields and unknown mutation fields", () => {
    const page = { ...validMutations()[1]!, criticality: "required" };
    const lifecycle = { ...validMutations()[3]!, target: { entityType: "claim", slug: "x", output: "x" } };

    expect(() => parseOperationManifest(serialized([page]))).toThrow(/unknown/);
    expect(() => parseOperationManifest(serialized([lifecycle]))).toThrow(/unknown/);
  });
});
