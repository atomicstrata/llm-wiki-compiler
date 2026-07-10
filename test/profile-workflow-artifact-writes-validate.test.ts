/**
 * @file test/profile-workflow-artifact-writes-validate.test.ts
 * @description Fail-closed validation of a stage's optional `artifactWrites`: each
 * entry must reference a profile-declared artifact type, and it satisfies the
 * `trust:`-gate-needs-a-producible-output rule (a trust-gated artifact-only stage
 * is valid). An undeclared artifact type is rejected at profile LOAD.
 */
import { describe, it, expect } from "vitest";
import { validateProfileShape } from "../src/profile/validate.js";
import type { ProfilePack } from "../src/profile/types.js";

function base(stage: Record<string, unknown>): ProfilePack {
  return {
    schemaVersion: 1, profileId: "artifact-writes-fixture",
    entities: { papers: { directory: "wiki/papers" } },
    artifacts: { "experiment-result": { fileName: "result.json", contentKind: "json", maxBytes: 4096 } },
    workflows: { build: { stages: [{ id: "run", reads: [], writes: [], ...stage }] } },
  } as ProfilePack;
}

describe("artifactWrites stage validation", () => {
  it("accepts an artifactWrites referencing a declared artifact type", () => {
    expect(() => validateProfileShape(base({ artifactWrites: ["experiment-result"] }))).not.toThrow();
  });
  it("rejects an artifactWrites referencing an undeclared artifact type", () => {
    expect(() => validateProfileShape(base({ artifactWrites: ["nope"] }))).toThrow(/not a declared artifact type/);
  });
  it("accepts a trust-gated stage whose only output is an artifact", () => {
    expect(() => validateProfileShape(base({ artifactWrites: ["experiment-result"], gate: "trust:high" }))).not.toThrow();
  });
});
