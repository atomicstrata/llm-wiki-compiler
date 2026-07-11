/**
 * @file test/profile-scaffold.test.ts
 * @description Verifies the deterministic beginner profile scaffold.
 */

import { describe, expect, it } from "vitest";
import {
  buildStarterProfile,
  canonicalStarterProfileJson,
} from "../src/profile/scaffold.js";
import { validateProfile } from "../src/profile/validate.js";

const EXPECTED_PROFILE = {
  schemaVersion: 1,
  profileId: "issue-tracker",
  displayName: "Issue Tracker",
  entities: {
    issues: {
      directory: "wiki/issues",
      titleField: "title",
      requiredFields: ["title"],
      fields: { title: { type: "string" } },
    },
  },
};

describe("buildStarterProfile", () => {
  it("builds the exact validated issue-tracker profile", () => {
    const profile = buildStarterProfile("issue-tracker", "issues");

    expect(profile).toEqual(EXPECTED_PROFILE);
    expect(validateProfile(profile).profile).toEqual(EXPECTED_PROFILE);
  });

  it.each([
    ["Issue-Tracker", "issues"],
    ["issue_tracker", "issues"],
    ["issue-tracker", "Issue"],
    ["issue-tracker", "../issues"],
  ])("rejects unsafe identifiers: %s / %s", (profileId, entityType) => {
    expect(() => buildStarterProfile(profileId, entityType)).toThrow(/lowercase letters, numbers, and hyphens/i);
  });

  it("title-cases hyphenated profile names deterministically", () => {
    expect(buildStarterProfile("release-issue-tracker", "tickets").displayName)
      .toBe("Release Issue Tracker");
  });

  it("serializes the canonical profile with a trailing newline", () => {
    expect(canonicalStarterProfileJson("issue-tracker", "issues"))
      .toBe(`${JSON.stringify(EXPECTED_PROFILE, null, 2)}\n`);
  });
});
