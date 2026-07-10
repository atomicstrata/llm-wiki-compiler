import { describe, it, expect } from "vitest";
import { validateFieldsAgainstDefs } from "../../src/profile/field-contract.js";
import { validateProfile } from "../../src/profile/validate.js";
import type { FieldDef } from "../../src/profile/types.js";

const HEX = "a".repeat(64);
const goodRef = `experiment-result/probe@sha256:${HEX}`;
const refField: Record<string, FieldDef> = { result: { type: "artifactRef", required: true } };
const refArrayField: Record<string, FieldDef> = { results: { type: "artifactRef[]" } };

/** One declared artifact type, shared by the load-time-guard fixtures below. */
const ONE_ARTIFACT = { "experiment-result": { fileName: "result.json", contentKind: "json" as const, maxBytes: 1024 } };

/**
 * A minimal two-entity profile with one relation attribute of type
 * `artifactRef`, scoped by the given `artifactTypes` — shared by the
 * relation-attribute load-time-guard fixtures below.
 */
function relationProfileWithArtifactTypes(artifactTypes: string[]) {
  return { schemaVersion: 1 as const, profileId: "p",
    entities: { note: { directory: "wiki/notes" }, other: { directory: "wiki/other" } },
    relations: { refs: { from: ["note"], to: ["other"], direction: "directed" as const,
      attributes: { evidenceRef: { type: "artifactRef" as const, artifactTypes } } } },
    artifacts: ONE_ARTIFACT };
}

describe("artifactRef Layer A (structural field contract)", () => {
  it("accepts a structurally valid ref value", () => {
    expect(validateFieldsAgainstDefs({ result: goodRef }, refField, ["result"])).toEqual([]);
  });
  it("flags a malformed ref value", () => {
    expect(validateFieldsAgainstDefs({ result: "not-a-ref" }, refField, ["result"]).length).toBe(1);
  });
  it("accepts an array of valid refs and flags an array containing a malformed one", () => {
    expect(validateFieldsAgainstDefs({ results: [goodRef, goodRef] }, refArrayField, [])).toEqual([]);
    expect(validateFieldsAgainstDefs({ results: [goodRef, "junk"] }, refArrayField, []).length).toBe(1);
    expect(validateFieldsAgainstDefs({ results: goodRef }, refArrayField, []).length).toBe(1); // non-array
  });
});

describe("load-time guards", () => {
  it("rejects artifactTypes on a non-artifactRef field", () => {
    const p = { schemaVersion: 1 as const, profileId: "p",
      entities: { note: { directory: "wiki/notes", fields: { x: { type: "string", artifactTypes: ["y"] } } } } };
    expect(() => validateProfile(p)).toThrow(/is not an artifactRef field/);
  });
  it("rejects artifactRef-typed fields INSIDE artifact metadata (nested refs undesigned in v0)", () => {
    for (const t of ["artifactRef", "artifactRef[]"] as const) {
      const p = { schemaVersion: 1 as const, profileId: "p", entities: { note: { directory: "wiki/notes" } },
        artifacts: { "experiment-result": { fileName: "result.json", contentKind: "json", maxBytes: 1024, metadata: { parent: { type: t } } } } };
      expect(() => validateProfile(p)).toThrow(/not supported in v0/);
    }
  });
  it("rejects an entity field artifactTypes scope naming an undeclared artifact type", () => {
    const p = { schemaVersion: 1 as const, profileId: "p",
      entities: { note: { directory: "wiki/notes", fields: { result: { type: "artifactRef" as const, artifactTypes: ["undeclared"] } } } },
      artifacts: ONE_ARTIFACT };
    expect(() => validateProfile(p)).toThrow(/undeclared artifact type/);
  });
  it("rejects a relation attribute artifactTypes scope naming an undeclared artifact type", () => {
    const p = relationProfileWithArtifactTypes(["undeclared"]);
    expect(() => validateProfile(p)).toThrow(/undeclared artifact type/);
  });
  it("rejects an empty artifactTypes on an artifactRef field", () => {
    const p = { schemaVersion: 1 as const, profileId: "p",
      entities: { note: { directory: "wiki/notes", fields: { result: { type: "artifactRef" as const, artifactTypes: [] } } } } };
    expect(() => validateProfile(p)).toThrow(/empty artifactTypes/);
  });
  it("rejects an empty artifactTypes on a relation attribute", () => {
    const p = relationProfileWithArtifactTypes([]);
    expect(() => validateProfile(p)).toThrow(/empty artifactTypes/);
  });
  it("rejects artifactTypes on a non-artifactRef artifact-metadata sub-field (R4.1)", () => {
    const p = { schemaVersion: 1 as const, profileId: "p", entities: { note: { directory: "wiki/notes" } },
      artifacts: { "experiment-result": { fileName: "result.json", contentKind: "json" as const, maxBytes: 1024,
        metadata: { parent: { type: "string" as const, artifactTypes: ["experiment-result"] } } } } };
    expect(() => validateProfile(p)).toThrow(/is not an artifactRef field/);
  });
  it("accepts an artifactRef field scoped to a type the profile actually declares", () => {
    const p = { schemaVersion: 1 as const, profileId: "p",
      entities: { note: { directory: "wiki/notes", fields: { result: { type: "artifactRef" as const, artifactTypes: ["experiment-result"] } } } },
      artifacts: ONE_ARTIFACT };
    expect(() => validateProfile(p)).not.toThrow();
  });
});
