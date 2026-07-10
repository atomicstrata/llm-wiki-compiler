/**
 * @file test/profile-workflows-validate.test.ts
 * @description Tests for the optional declarative `workflows` block on a profile
 * pack (Phase 5) and its fail-closed load validation.
 *
 * A workflow declares an ordered set of stages, each naming the declared entity
 * types it `reads`/`writes` and an optional `<kind>:<id>` gate. These tests pin:
 * a valid block passes `validateProfileShape` (with and without a gate); the
 * workflow id must be slug-safe and must not collide with a reserved core CLI
 * verb; stage ids must be slug-safe and unique within a workflow; every
 * `reads`/`writes` entry must reference a DECLARED entity type; a malformed gate
 * is rejected; and a workflow-less profile still validates (omitted-for-default).
 */

import { describe, it, expect } from "vitest";
import { validateProfileShape, ProfileValidationError } from "../src/profile/validate.js";
import { ProfilePathError } from "../src/profile/paths.js";
import type { ProfilePack, WorkflowDef } from "../src/profile/types.js";

/** A minimal valid profile with two entity types and one workflow. */
function workflowProfile(workflow?: WorkflowDef): ProfilePack {
  return {
    schemaVersion: 1,
    profileId: "research",
    entities: {
      ideas: { directory: "wiki/ideas" },
      experiments: { directory: "wiki/experiments" },
    },
    workflows: {
      "idea-to-experiment": workflow ?? {
        stages: [
          { id: "draft", reads: ["ideas"], writes: ["ideas"] },
          { id: "run", reads: ["ideas"], writes: ["experiments"], gate: "human:reviewer" },
        ],
      },
    },
  };
}

describe("validateProfileShape — workflows (happy path)", () => {
  it("accepts a multi-stage workflow referencing declared entities with a gate", () => {
    const result = validateProfileShape(workflowProfile());
    expect(result.profile.workflows?.["idea-to-experiment"].stages).toHaveLength(2);
  });

  it("accepts a single-stage workflow with no gate", () => {
    const raw = workflowProfile({ stages: [{ id: "draft", reads: ["ideas"], writes: ["ideas"] }] });
    expect(() => validateProfileShape(raw)).not.toThrow();
  });

  it("accepts a profile with NO workflows key (omitted-for-default)", () => {
    const raw: ProfilePack = {
      schemaVersion: 1,
      profileId: "research",
      entities: { ideas: { directory: "wiki/ideas" } },
    };
    expect(() => validateProfileShape(raw)).not.toThrow();
  });
});

describe("validateProfileShape — workflows (fail closed)", () => {
  it("rejects a slug-unsafe workflow id", () => {
    const raw = workflowProfile();
    raw.workflows = { "Idea Flow": raw.workflows!["idea-to-experiment"] };
    expect(() => validateProfileShape(raw)).toThrow(/slug-safe/);
  });

  it("rejects a workflow id that collides with a reserved core verb", () => {
    const raw = workflowProfile();
    raw.workflows = { compile: raw.workflows!["idea-to-experiment"] };
    expect(() => validateProfileShape(raw)).toThrow(ProfileValidationError);
    expect(() => validateProfileShape(raw)).toThrow(/reserved/);
  });

  it("rejects a slug-unsafe stage id", () => {
    const raw = workflowProfile({ stages: [{ id: "Draft Stage", reads: ["ideas"], writes: ["ideas"] }] });
    expect(() => validateProfileShape(raw)).toThrow(/slug-safe/);
  });

  it("rejects a duplicate stage id within a workflow", () => {
    const raw = workflowProfile({
      stages: [
        { id: "draft", reads: ["ideas"], writes: ["ideas"] },
        { id: "draft", reads: ["ideas"], writes: ["experiments"] },
      ],
    });
    expect(() => validateProfileShape(raw)).toThrow(/duplicate stage id/);
  });

  it("rejects a reads entry that is not a declared entity type", () => {
    const raw = workflowProfile({ stages: [{ id: "draft", reads: ["ghosts"], writes: ["ideas"] }] });
    expect(() => validateProfileShape(raw)).toThrow(/'ghosts' is not a declared entity/);
  });

  it("rejects a writes entry that is not a declared entity type", () => {
    const raw = workflowProfile({ stages: [{ id: "draft", reads: ["ideas"], writes: ["phantom"] }] });
    expect(() => validateProfileShape(raw)).toThrow(/'phantom' is not a declared entity/);
  });

  it("rejects a gate with an unknown kind", () => {
    const raw = workflowProfile({ stages: [{ id: "draft", reads: ["ideas"], writes: ["ideas"], gate: "bogus:x" }] });
    expect(() => validateProfileShape(raw)).toThrow(/gate/);
  });

  it("rejects a gate with an empty id", () => {
    const raw = workflowProfile({ stages: [{ id: "draft", reads: ["ideas"], writes: ["ideas"], gate: "trust:" }] });
    expect(() => validateProfileShape(raw)).toThrow(/gate/);
  });

  it("rejects a duplicate reads entry via the schema uniqueItems gate", () => {
    const raw = workflowProfile({ stages: [{ id: "draft", reads: ["ideas", "ideas"], writes: ["experiments"] }] });
    expect(() => validateProfileShape(raw)).toThrow(ProfileValidationError);
  });

  it("rejects a projectionFile that escapes the project with '..'", () => {
    const raw = workflowProfile({
      stages: [{ id: "draft", reads: ["ideas"], writes: ["ideas"] }],
      projectionFile: "../../etc/passwd",
    });
    expect(() => validateProfileShape(raw)).toThrow(ProfileValidationError);
  });

  it("rejects an absolute projectionFile", () => {
    const raw = workflowProfile({
      stages: [{ id: "draft", reads: ["ideas"], writes: ["ideas"] }],
      projectionFile: "/etc/passwd",
    });
    expect(() => validateProfileShape(raw)).toThrow(ProfileValidationError);
  });

  it("rejects a projectionFile not under wiki/", () => {
    const raw = workflowProfile({
      stages: [{ id: "draft", reads: ["ideas"], writes: ["ideas"] }],
      projectionFile: "sources/leak.md",
    });
    expect(() => validateProfileShape(raw)).toThrow(ProfileValidationError);
  });

  it("accepts a safe projectionFile under wiki/", () => {
    const raw = workflowProfile({
      stages: [{ id: "draft", reads: ["ideas"], writes: ["ideas"] }],
      projectionFile: "wiki/outputs/workflows/idea-to-experiment.md",
    });
    expect(() => validateProfileShape(raw)).not.toThrow();
  });

  it("rejects a projectionFile under wiki/ but OUTSIDE the reserved subtree (clobber vector)", () => {
    const raw = workflowProfile({
      stages: [{ id: "draft", reads: ["ideas"], writes: ["ideas"] }],
      projectionFile: "wiki/concepts/important.md",
    });
    expect(() => validateProfileShape(raw)).toThrow(ProfileValidationError);
    expect(() => validateProfileShape(raw)).toThrow(/wiki\/outputs\/workflows/);
  });

  it("rejects an entity directory that overlaps the projection subtree", () => {
    const raw = workflowProfile();
    raw.entities.notes = { directory: "wiki/outputs/workflows" };
    expect(() => validateProfileShape(raw)).toThrow(ProfilePathError);
    expect(() => validateProfileShape(raw)).toThrow(/reserved root 'wiki\/outputs\/workflows'/);
  });
});

describe("validateProfileShape — trust-gated stage requires writes (M2)", () => {
  /** A one-stage `build`-style profile whose only stage carries `gate` + `writes`. */
  const gatedStageProfile = (gate: string, writes: string[]): ProfilePack =>
    workflowProfile({ stages: [{ id: "draft", reads: ["ideas"], writes, gate }] });

  it("rejects a trust:-gated stage with empty writes (unsatisfiable at runtime)", () => {
    const raw = gatedStageProfile("trust:high", []);
    expect(() => validateProfileShape(raw)).toThrow(ProfileValidationError);
    expect(() => validateProfileShape(raw)).toThrow(/trust/);
  });

  it("accepts a trust:-gated stage with non-empty writes", () => {
    expect(() => validateProfileShape(gatedStageProfile("trust:high", ["ideas"]))).not.toThrow();
  });

  it("accepts a human:-gated stage with empty writes (satisfied by approval)", () => {
    expect(() => validateProfileShape(gatedStageProfile("human:reviewer", []))).not.toThrow();
  });
});

describe("validateProfileShape — workflow stage previousIds", () => {
  it("accepts a stage declaring a valid previousIds rename source", () => {
    const raw = workflowProfile({
      stages: [
        { id: "compose", reads: ["ideas"], writes: ["ideas"], previousIds: ["draft"] },
        { id: "run", reads: ["ideas"], writes: ["experiments"] },
      ],
    });
    expect(() => validateProfileShape(raw)).not.toThrow();
  });

  it("rejects a previousId equal to a current stage id in the same workflow", () => {
    const raw = workflowProfile({
      stages: [
        { id: "draft", reads: ["ideas"], writes: ["ideas"] },
        { id: "run", reads: ["ideas"], writes: ["experiments"], previousIds: ["draft"] },
      ],
    });
    expect(() => validateProfileShape(raw)).toThrow(ProfileValidationError);
    expect(() => validateProfileShape(raw)).toThrow(/previousId 'draft'/);
  });

  it("rejects two stages sharing the same previousId", () => {
    const raw = workflowProfile({
      stages: [
        { id: "compose", reads: ["ideas"], writes: ["ideas"], previousIds: ["draft"] },
        { id: "run", reads: ["ideas"], writes: ["experiments"], previousIds: ["draft"] },
      ],
    });
    expect(() => validateProfileShape(raw)).toThrow(/previousId 'draft'/);
  });

  it("rejects a non-slug-safe previousId", () => {
    const raw = workflowProfile({
      stages: [{ id: "compose", reads: ["ideas"], writes: ["ideas"], previousIds: ["Old Draft"] }],
    });
    expect(() => validateProfileShape(raw)).toThrow(/slug-safe/);
  });
});
