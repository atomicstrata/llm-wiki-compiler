/**
 * @file test/profile-human-input.test.ts
 * @description Profile-load witnesses for the bounded, closed human-input
 * descriptor grammar. Invalid contracts fail before a workflow can park on an
 * unenforceable schema.
 */

import { describe, expect, it } from "vitest";
import { validateProfile } from "../src/profile/validate.js";
import { ProfileValidationError } from "../src/profile/errors.js";
import type { HumanInputFieldV1, ProfilePack } from "../src/profile/types.js";

function profile(fields: Record<string, HumanInputFieldV1>): ProfilePack {
  return {
    schemaVersion: 1, profileId: "human-contract", entities: { notes: { directory: "wiki/notes" } },
    artifacts: { evidence: { fileName: "evidence.txt", contentKind: "text", maxBytes: 1024 } },
    workflows: { story: { stages: [{
      id: "frame", reads: [], writes: [], humanInput: { schemaVersion: 1, schemaId: "story/frame-v1", fields },
    }] } },
  };
}

function rejects(fields: Record<string, HumanInputFieldV1>): void {
  expect(() => validateProfile(profile(fields))).toThrow(ProfileValidationError);
}

describe("profile human-input descriptor", () => {
  it("accepts bounded values without requiring slug-shaped enum labels", () => {
    expect(validateProfile(profile({ format: { kind: "enum", values: ["Breaking News", "Long-form"] } })).profile)
      .toMatchObject({ profileId: "human-contract" });
  });

  it("rejects more than 32 fields", () => {
    const fields = Object.fromEntries(Array.from({ length: 33 }, (_, index) => [`field${index}`, { kind: "string", maxBytes: 10 }]));
    rejects(fields as Record<string, HumanInputFieldV1>);
  });

  it.each([
    [{ choice: { kind: "enum", values: Array.from({ length: 65 }, (_, i) => `v${i}`) } }],
    [{ choice: { kind: "enum", values: ["same", "same"] } }],
    [{ refs: { kind: "ref-list", referenceKind: "entity", entityTypes: ["missing"], maxItems: 2 } }],
    [{ text: { kind: "string", maxBytes: 65_537 } }],
  ] as Array<[Record<string, HumanInputFieldV1>]>) ("rejects an invalid bounded field contract", (fields) => rejects(fields));

  it("rejects a stage that combines human input with mutation output", () => {
    const invalid = profile({ angle: { kind: "string", maxBytes: 20 } });
    invalid.workflows!.story.stages[0].writes = ["notes"];
    expect(() => validateProfile(invalid)).toThrow(ProfileValidationError);
  });
});
