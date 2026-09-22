/**
 * @file test/profile-subject-gate.test.ts
 * @description Profile-load controls for subject-bound gates: they are human
 * gates only and must name an earlier stage that produces the declared artifact.
 */

import { describe, expect, it } from "vitest";
import { validateProfile } from "../src/profile/validate.js";
import { ProfileValidationError } from "../src/profile/errors.js";
import type { ProfilePack, WorkflowStageDef } from "../src/profile/types.js";

/** Build a small profile around a caller-selected review stage. */
function profile(review: WorkflowStageDef): ProfilePack {
  return {
    schemaVersion: 1, profileId: "subject-gate", entities: { docs: { directory: "wiki/docs" } },
    artifacts: { snapshot: { fileName: "snapshot.json", contentKind: "json", maxBytes: 4096 } },
    workflows: { build: { stages: [
      { id: "check", reads: [], writes: [], artifactWrites: ["snapshot"] }, review,
    ] } },
  };
}

/** The valid subject-bound review stage. */
function review(): WorkflowStageDef {
  return { id: "review", reads: [], writes: [], gate: "human:editor", subjectGate: {
    outputStageId: "check", artifactType: "snapshot", verifierId: "covered-items/v1",
  } };
}

describe("profile subject-gate descriptor", () => {
  it("accepts a human gate bound to an earlier artifact output", () => {
    expect(validateProfile(profile(review())).profile.profileId).toBe("subject-gate");
  });

  it.each([
    { ...review(), gate: "agent:editor" },
    { ...review(), subjectGate: { ...review().subjectGate!, outputStageId: "missing" } },
    { ...review(), subjectGate: { ...review().subjectGate!, artifactType: "missing" } },
    { ...review(), subjectGate: { ...review().subjectGate!, verifierId: "../unsafe" } },
  ])("rejects an unenforceable subject-gate contract", (stage) => {
    expect(() => validateProfile(profile(stage))).toThrow(ProfileValidationError);
  });
});
