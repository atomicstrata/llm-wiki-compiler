import { describe, it, expect } from "vitest";
import { validateProfile } from "../../src/profile/validate.js";
import { profileDigest } from "../../src/profile/digest.js";
import { DEFAULT_PROFILE } from "../../src/profile/default.js";

const base = { schemaVersion: 1 as const, profileId: "p", entities: { note: { directory: "wiki/notes" } } };
const withArtifact = (a: unknown) => ({ ...base, artifacts: { "experiment-result": a } });

describe("artifacts profile declaration", () => {
  it("accepts a well-formed json artifact type", () => {
    const p = withArtifact({ fileName: "result.json", contentKind: "json", maxBytes: 65536, metadata: { accuracy: { type: "number", required: true } } });
    expect(() => validateProfile(p)).not.toThrow();
  });
  it("rejects a fileName whose extension mismatches contentKind", () => {
    expect(() => validateProfile(withArtifact({ fileName: "result.txt", contentKind: "json", maxBytes: 1024 }))).toThrow(/fileName/);
  });
  it("rejects metadata declared on a text artifact", () => {
    expect(() => validateProfile(withArtifact({ fileName: "n.txt", contentKind: "text", maxBytes: 1024, metadata: { x: { type: "string" } } }))).toThrow(/metadata/);
  });
  it("rejects non-positive or over-cap maxBytes", () => {
    expect(() => validateProfile(withArtifact({ fileName: "result.json", contentKind: "json", maxBytes: 0 }))).toThrow(/maxBytes/);
  });
  it("leaves the default-profile digest unchanged (omitted-for-default)", () => {
    const before = profileDigest(DEFAULT_PROFILE);
    validateProfile(withArtifact({ fileName: "result.json", contentKind: "json", maxBytes: 1024 }));
    expect(profileDigest(DEFAULT_PROFILE)).toBe(before);
  });
});
