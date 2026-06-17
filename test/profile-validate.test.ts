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

  it("rejects a non-empty extends (schema maxItems:0 gate)", () => {
    const raw = { ...baseProfile(), extends: ["base"] };
    expect(() => validateProfile(raw)).toThrow(ProfileValidationError);
    expect(() => validateProfile(raw)).toThrow(/extends|0 items/i);
  });

  it("rejects extends:['default'] (inheritance still unsupported)", () => {
    const raw = { ...baseProfile(), extends: ["default"] };
    expect(() => validateProfile(raw)).toThrow(ProfileValidationError);
  });

  it("accepts an absent / empty extends", () => {
    expect(() => validateProfile({ ...baseProfile(), extends: [] })).not.toThrow();
  });
});

describe("validateProfile — directories", () => {
  it("rejects an entity directory outside wiki/ (schema pattern gate)", () => {
    const raw = baseProfile();
    raw.entities.papers.directory = "outside/papers";
    expect(() => validateProfile(raw)).toThrow(ProfileValidationError);
    expect(() => validateProfile(raw)).toThrow(/directory|wiki/i);
  });

  it("rejects two entities sharing a directory", () => {
    const raw = baseProfile();
    raw.entities.notes.directory = "wiki/papers";
    expect(() => validateProfile(raw)).toThrow(/share|same directory/i);
  });

  it("rejects a directory overlapping a reserved root (sources/)", () => {
    const raw = baseProfile();
    raw.entities.papers.directory = "sources/papers";
    expect(() => validateProfile(raw)).toThrow(/reserved root|must be under 'wiki\/'|pattern/i);
  });

  it("rejects a directory overlapping wiki/graph", () => {
    const raw = baseProfile();
    raw.entities.papers.directory = "wiki/graph";
    expect(() => validateProfile(raw)).toThrow(ProfilePathError);
    expect(() => validateProfile(raw)).toThrow(/reserved root 'wiki\/graph'/);
  });

  it("rejects equivalent directories that normalize to the same dir", () => {
    const raw = baseProfile();
    raw.entities.papers.directory = "wiki/papers";
    raw.entities.notes.directory = "wiki/papers/.";
    expect(() => validateProfile(raw)).toThrow(/share|same directory/i);
  });

  it("canonicalizes the returned entity directory (strips '.')", () => {
    const raw = baseProfile();
    raw.entities.papers.directory = "wiki/papers/.";
    const result = validateProfile(raw);
    expect(result.profile.entities.papers.directory).toBe("wiki/papers");
  });
});

describe("validateProfile — entity-type keys", () => {
  it("rejects an uppercase entity-type key", () => {
    const raw = baseProfile();
    raw.entities = { Papers: { directory: "wiki/papers" } };
    expect(() => validateProfile(raw)).toThrow(ProfileValidationError);
  });

  it("rejects an entity-type key with a space", () => {
    const raw = baseProfile();
    raw.entities = { "research papers": { directory: "wiki/papers" } };
    expect(() => validateProfile(raw)).toThrow(ProfileValidationError);
  });
});

describe("validateProfile — schema-parity rejection", () => {
  it("rejects an unknown top-level key", () => {
    const raw = { ...baseProfile(), surprise: true };
    expect(() => validateProfile(raw)).toThrow(/unknown|unexpected/i);
  });

  it("rejects an unknown per-entity key", () => {
    const raw = baseProfile();
    (raw.entities.papers as Record<string, unknown>).bogus = 1;
    expect(() => validateProfile(raw)).toThrow(/unknown|unexpected/i);
  });

  it("rejects an unknown field-def key", () => {
    const raw = baseProfile();
    raw.entities.papers.fields = { w: { type: "number", weird: 1 } as never };
    expect(() => validateProfile(raw)).toThrow(/unknown|unexpected/i);
  });

  it("rejects a retrieval.readExposure outside the allowed set", () => {
    const raw = baseProfile();
    raw.entities.papers.retrieval = { readExposure: "public" as never };
    expect(() => validateProfile(raw)).toThrow(ProfileValidationError);
  });

  it("rejects a non-finite retrieval.defaultWeight", () => {
    const raw = baseProfile();
    raw.entities.papers.retrieval = { defaultWeight: Infinity };
    expect(() => validateProfile(raw)).toThrow(ProfileValidationError);
  });

  it("rejects a requiredFields entry not declared in fields", () => {
    const raw = baseProfile();
    raw.entities.papers.fields = { title: { type: "string" } };
    raw.entities.papers.requiredFields = ["title", "missing"];
    expect(() => validateProfile(raw)).toThrow(/requiredFields|missing/i);
  });
});

describe("validateProfile — ajv structural gate (codex fail-closed cases)", () => {
  it("rejects an unknown retrieval key (retrieval.bogus)", () => {
    const raw = baseProfile();
    raw.entities.papers.retrieval = { bogus: true } as never;
    expect(() => validateProfile(raw)).toThrow(ProfileValidationError);
  });

  it("rejects a non-boolean retrieval.includeInSearch ('yes')", () => {
    const raw = baseProfile();
    raw.entities.papers.retrieval = { includeInSearch: "yes" } as never;
    expect(() => validateProfile(raw)).toThrow(ProfileValidationError);
  });

  it("rejects a non-number field min (score.min = 'low')", () => {
    const raw = baseProfile();
    raw.entities.papers.fields = { score: { type: "number", min: "low" } as never };
    expect(() => validateProfile(raw)).toThrow(ProfileValidationError);
  });

  it("rejects a non-boolean field required (title.required = 'yes')", () => {
    const raw = baseProfile();
    raw.entities.papers.fields = { title: { type: "string", required: "yes" } as never };
    expect(() => validateProfile(raw)).toThrow(ProfileValidationError);
  });

  it("rejects an unknown lifecycle key (lifecycle.bogus)", () => {
    const raw = baseProfile();
    raw.entities.papers.lifecycle = {
      field: "status", initial: "draft", terminal: ["done"],
      transitions: { draft: ["done"] }, bogus: true,
    } as never;
    expect(() => validateProfile(raw)).toThrow(ProfileValidationError);
  });

  it("rejects a non-array lifecycle.terminal ('done')", () => {
    const raw = baseProfile();
    raw.entities.papers.lifecycle = {
      field: "status", initial: "draft", terminal: "done",
      transitions: { draft: ["done"] },
    } as never;
    expect(() => validateProfile(raw)).toThrow(ProfileValidationError);
  });
});

describe("validateProfile — non-mutating (all-or-nothing)", () => {
  it("leaves the caller's input unchanged when a later entity is invalid", () => {
    const raw = baseProfile();
    raw.entities.papers.directory = "wiki/papers/.";
    raw.entities.notes.directory = "sources/secret"; // later entity is invalid
    expect(() => validateProfile(raw)).toThrow();
    // The earlier entity's directory must NOT have been canonicalized in place.
    expect(raw.entities.papers.directory).toBe("wiki/papers/.");
  });

  it("does not mutate the input on the happy path; returns a canonical clone", () => {
    const raw = baseProfile();
    raw.entities.papers.directory = "wiki/papers/.";
    const result = validateProfile(raw);
    expect(raw.entities.papers.directory).toBe("wiki/papers/.");
    expect(result.profile.entities.papers.directory).toBe("wiki/papers");
    expect(result.profile).not.toBe(raw);
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

  it("rejects a disk profile that claims the reserved 'default' id", () => {
    const raw = { ...baseProfile(), profileId: "default" };
    expect(() => validateProfile(raw)).toThrow(/reserved/);
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
