import { describe, it, expect } from "vitest";
import { validateArtifactBody } from "../../src/artifacts/body-contract.js";
import type { ArtifactTypeDef } from "../../src/profile/types.js";

const jsonDef: ArtifactTypeDef = {
  fileName: "result.json",
  contentKind: "json",
  maxBytes: 65536,
  metadata: { accuracy: { type: "number", required: true } },
};

const textDef: ArtifactTypeDef = {
  fileName: "notes.txt",
  contentKind: "text",
  maxBytes: 16,
};

describe("validateArtifactBody", () => {
  it("accepts a valid json body satisfying its declared metadata", () => {
    expect(validateArtifactBody(jsonDef, `{"accuracy":0.9}`)).toEqual([]);
  });
  it("reports one violation for an oversize body", () => {
    const problems = validateArtifactBody(textDef, "this body is far too long");
    expect(problems).toHaveLength(1);
  });
  it("reports one violation for non-JSON content on a json artifact", () => {
    const problems = validateArtifactBody(jsonDef, "not json at all");
    expect(problems).toHaveLength(1);
  });
  it("reports one violation for a top-level JSON array", () => {
    const problems = validateArtifactBody(jsonDef, `[1,2,3]`);
    expect(problems).toHaveLength(1);
  });
  it("reports one violation for a missing required metadata field", () => {
    const problems = validateArtifactBody(jsonDef, `{}`);
    expect(problems).toHaveLength(1);
  });
  it("reports one violation for a wrong-typed metadata field", () => {
    const problems = validateArtifactBody(jsonDef, `{"accuracy":"high"}`);
    expect(problems).toHaveLength(1);
  });
  it("accepts any body within the byte cap for a text artifact (only the cap applies)", () => {
    expect(validateArtifactBody(textDef, "short")).toEqual([]);
  });
});
