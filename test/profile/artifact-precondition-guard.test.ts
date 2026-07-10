/**
 * @file test/profile/artifact-precondition-guard.test.ts
 * @description Post-reconciliation: `transitionArtifactRequirements` is now a
 * first-class, enforceable declaration, so the 7.1 recognize-but-REJECT guard is
 * REMOVED (atomically with the write-time enforcer composition). The loader ACCEPTS a
 * well-formed required-artifact precondition block and still refuses a structurally
 * malformed one (missing `field`/`artifactType`). Semantic enforceability (M1) and DAG
 * ordering (M3) are proven in `./artifact-requirements-load.test.ts`; write-time denial
 * in the artifact enforce suites.
 */
import { describe, it, expect } from "vitest";
import { validateProfile, ProfileValidationError } from "../../src/profile/validate.js";
import type { ProfilePack } from "../../src/profile/types.js";

function wellFormed(): ProfilePack {
  return {
    schemaVersion: 1,
    profileId: "artifact-precond-guard",
    entities: {
      experiments: {
        directory: "wiki/experiments",
        requiredFields: ["title", "stage"],
        fields: {
          title: { type: "string" },
          stage: { type: "enum", enum: ["running", "complete"] },
          result: { type: "artifactRef", artifactTypes: ["experiment-result"] },
        },
        lifecycle: {
          field: "stage", initial: "running", terminal: ["complete"], transitions: { running: ["complete"] },
          transitionArtifactRequirements: { complete: [{ field: "result", artifactType: "experiment-result" }] },
        },
      },
    },
    artifacts: { "experiment-result": { fileName: "result.json", contentKind: "json", maxBytes: 65536 } },
  };
}

describe("transitionArtifactRequirements — loader posture (reconciled from 7.1)", () => {
  it("ACCEPTS a well-formed required-artifact precondition (7.1 rejected this)", () => {
    expect(() => validateProfile(wellFormed())).not.toThrow();
  });

  it("still rejects a structurally malformed requirement (missing artifactType)", () => {
    const p = wellFormed();
    delete (p.entities.experiments.lifecycle!.transitionArtifactRequirements!.complete[0] as Record<string, unknown>).artifactType;
    expect(() => validateProfile(p)).toThrow(ProfileValidationError);
  });
});
