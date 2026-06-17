/**
 * Tests for the built-in default profile pack.
 *
 * Verifies that the default profile declares the `concepts` and `queries`
 * entity types pointing at the canonical wiki directories, and that
 * isDefaultProfile recognises it by profileId.
 */

import { describe, it, expect } from "vitest";
import { DEFAULT_PROFILE, isDefaultProfile } from "../src/profile/default.js";

describe("DEFAULT_PROFILE", () => {
  it("declares the concepts entity at wiki/concepts", () => {
    expect(DEFAULT_PROFILE.entities.concepts.directory).toBe("wiki/concepts");
  });

  it("declares the queries entity at wiki/queries", () => {
    expect(DEFAULT_PROFILE.entities.queries.directory).toBe("wiki/queries");
  });

  it("is recognised as the default profile", () => {
    expect(isDefaultProfile(DEFAULT_PROFILE)).toBe(true);
  });
});
