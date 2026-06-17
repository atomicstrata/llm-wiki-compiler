/**
 * Tests for the fail-closed v0 profile validator and path validator.
 *
 * The validator is all-or-nothing: any structural violation throws a
 * ProfileValidationError and nothing is returned. These tests pin every
 * fail-closed branch — bad schemaVersion, the unsupported `extends`
 * inheritance, reserved/colliding/escaping directories, and lifecycle FSM
 * well-formedness — plus the happy path and the canonical default profile.
 */

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";
import { describe, it, expect } from "vitest";
import { validateProfile, ProfileValidationError } from "../src/profile/validate.js";
import { ProfilePathError } from "../src/profile/paths.js";
import { DEFAULT_PROFILE } from "../src/profile/default.js";
import type { ProfilePack } from "../src/profile/types.js";

/** A minimal valid two-entity profile used as a base for negative cases. */
function baseProfile(): ProfilePack {
  return {
    schemaVersion: 1,
    profileId: "research",
    entities: {
      papers: { directory: "wiki/papers" },
      notes: { directory: "wiki/notes" },
    },
  };
}

describe("validateProfile — schema gate and inheritance", () => {
  it("rejects an unknown schemaVersion", () => {
    const raw = { ...baseProfile(), schemaVersion: 2 };
    expect(() => validateProfile(raw)).toThrow(ProfileValidationError);
  });

  it("rejects a non-empty extends with a clear message", () => {
    const raw = { ...baseProfile(), extends: ["base"] };
    expect(() => validateProfile(raw)).toThrow(/inheritance \(extends\) is not supported/);
  });

  it("rejects extends:['default'] (inheritance still unsupported)", () => {
    const raw = { ...baseProfile(), extends: ["default"] };
    expect(() => validateProfile(raw)).toThrow(/inheritance \(extends\) is not supported/);
  });

  it("accepts an absent / empty extends", () => {
    expect(() => validateProfile({ ...baseProfile(), extends: [] })).not.toThrow();
  });
});

describe("validateProfile — directories", () => {
  it("rejects an entity directory outside wiki/", () => {
    const raw = baseProfile();
    raw.entities.papers.directory = "outside/papers";
    expect(() => validateProfile(raw)).toThrow(ProfilePathError);
    expect(() => validateProfile(raw)).toThrow(/must be under 'wiki\/'/);
  });

  it("rejects two entities sharing a directory", () => {
    const raw = baseProfile();
    raw.entities.notes.directory = "wiki/papers";
    expect(() => validateProfile(raw)).toThrow(/share|same directory/i);
  });

  it("rejects a directory overlapping a reserved root (sources/)", () => {
    const raw = baseProfile();
    raw.entities.papers.directory = "sources/papers";
    expect(() => validateProfile(raw)).toThrow(/reserved root|must be under 'wiki\/'/);
  });

  it("rejects a directory overlapping wiki/graph", () => {
    const raw = baseProfile();
    raw.entities.papers.directory = "wiki/graph";
    expect(() => validateProfile(raw)).toThrow(ProfilePathError);
    expect(() => validateProfile(raw)).toThrow(/reserved root 'wiki\/graph'/);
  });
});

describe("validateProfile — lifecycle FSM", () => {
  it("rejects a terminal state with outgoing transitions", () => {
    const raw = baseProfile();
    raw.entities.papers.lifecycle = {
      field: "status",
      initial: "draft",
      terminal: ["done"],
      transitions: { draft: ["done"], done: ["draft"] },
    };
    expect(() => validateProfile(raw)).toThrow(/terminal/i);
  });

  it("rejects an initial state not in the state set", () => {
    const raw = baseProfile();
    raw.entities.papers.lifecycle = {
      field: "status",
      initial: "ghost",
      terminal: ["done"],
      transitions: { draft: ["done"] },
    };
    expect(() => validateProfile(raw)).toThrow(/initial/i);
  });

  it("rejects a transitionRequirements key for a non-existent state", () => {
    const raw = baseProfile();
    raw.entities.papers.lifecycle = {
      field: "status",
      initial: "draft",
      terminal: ["done"],
      transitions: { draft: ["done"] },
      transitionRequirements: { phantom: ["x"] },
    };
    expect(() => validateProfile(raw)).toThrow(/transitionRequirements|state/i);
  });
});

describe("validateProfile — field types", () => {
  it("rejects a non-finite numeric default", () => {
    const raw = baseProfile();
    raw.entities.papers.fields = { weight: { type: "number", default: Infinity } };
    expect(() => validateProfile(raw)).toThrow(ProfileValidationError);
  });

  it("allows a finite decimal numeric default", () => {
    const raw = baseProfile();
    raw.entities.papers.fields = { weight: { type: "number", default: 0.5 } };
    expect(() => validateProfile(raw)).not.toThrow();
  });

  it("rejects a field type outside the v0 allowlist", () => {
    const raw = baseProfile();
    raw.entities.papers.fields = { bad: { type: "object" } as never };
    expect(() => validateProfile(raw)).toThrow(ProfileValidationError);
  });
});

describe("validateProfile — happy paths", () => {
  it("accepts a valid two-entity profile and returns it", () => {
    const result = validateProfile(baseProfile());
    expect(result.profile.profileId).toBe("research");
    expect(Object.keys(result.profile.entities)).toEqual(["papers", "notes"]);
  });

  it("accepts the built-in DEFAULT_PROFILE", () => {
    expect(() => validateProfile(DEFAULT_PROFILE)).not.toThrow();
  });

  it("returns unreachable lifecycle states as warnings, not errors", () => {
    const raw = baseProfile();
    raw.entities.papers.fields = {
      status: { type: "enum", enum: ["draft", "review", "done", "orphan"] },
    };
    raw.entities.papers.lifecycle = {
      field: "status",
      initial: "draft",
      terminal: ["done", "orphan"],
      transitions: { draft: ["review"], review: ["done"] },
    };
    const result = validateProfile(raw);
    expect(result.warnings.join(" ")).toMatch(/orphan/);
  });
});

describe("profile.v1 JSON schema", () => {
  it("parses as JSON", () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const schemaPath = path.join(here, "../src/profile/schema/profile.v1.schema.json");
    const parsed = JSON.parse(readFileSync(schemaPath, "utf8"));
    expect(parsed.$schema).toContain("2020-12");
  });
});
