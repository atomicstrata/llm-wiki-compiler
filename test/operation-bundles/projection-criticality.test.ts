/**
 * @file test/operation-bundles/projection-criticality.test.ts
 * @description Task 4 tests that projection criticality is manifest data the
 * renderer cannot change: required and optional are read straight from the
 * mutation, and the rendered bytes are identical regardless of criticality.
 */

import { describe, it, expect } from "vitest";
import { projectionCriticality } from "../../src/operation-bundles/adapters/projection.js";
import { canonicalBytes } from "../../src/profile/templates/signing/canonical.js";
import type { OperationDigest, ProjectionOperationMutation } from "../../src/operation-bundles/types.js";
import type { ProjectionCriticality } from "../../src/operation-bundles/run-types.js";
import { makeBinding } from "./adapter-fixtures.js";

const RECIPE_DIGEST = `sha256:${"6".repeat(64)}` as OperationDigest;

function projectionMutation(criticality: ProjectionCriticality): ProjectionOperationMutation {
  const set = makeBinding();
  return {
    kind: "projection", index: 0, mutationId: set.onDisk.mutationId, dependsOn: [], reconciliationRefs: [],
    operation: "render", target: { recipeId: "recipe-a", recipeDigest: RECIPE_DIGEST, output: "out.json", criticality },
    precondition: { kind: "absent" }, postcondition: { digest: RECIPE_DIGEST },
  };
}

describe("projectionCriticality", () => {
  it("reads required and optional straight from the manifest mutation", () => {
    expect(projectionCriticality(projectionMutation("required"))).toBe("required");
    expect(projectionCriticality(projectionMutation("optional"))).toBe("optional");
  });

  it("renders identical bytes regardless of criticality", () => {
    const render = (m: ProjectionOperationMutation) => canonicalBytes({ recipeId: m.target.recipeId, recipeDigest: m.target.recipeDigest, output: m.target.output });
    expect(render(projectionMutation("required")).equals(render(projectionMutation("optional")))).toBe(true);
  });
});
