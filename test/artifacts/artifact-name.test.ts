import { describe, it, expect } from "vitest";
import { isValidArtifactFileName } from "../../src/artifacts/name.js";

describe("isValidArtifactFileName", () => {
  it("accepts a json name with .json", () => {
    expect(isValidArtifactFileName("result.json", "json")).toBe(true);
  });
  it("accepts a text name with .txt or .md", () => {
    expect(isValidArtifactFileName("notes.txt", "text")).toBe(true);
    expect(isValidArtifactFileName("notes.md", "text")).toBe(true);
  });
  it("rejects a json name whose extension is not .json", () => {
    expect(isValidArtifactFileName("result.txt", "json")).toBe(false);
  });
  it("rejects an extensionless, dotfile, traversal, or separator name", () => {
    for (const bad of ["result", ".result.json", "../x.json", "a/b.json", "x .json"]) {
      expect(isValidArtifactFileName(bad, "json")).toBe(false);
    }
  });
});
