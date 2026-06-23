/**
 * @file test/safe-evidence-path.test.ts
 * @description Pure unit tests for the shared {@link isSafeRelativeEvidencePath}
 * helper. Verifies it rejects all absolute/drive/UNC/traversal/unsafe forms and
 * accepts only clean project-relative paths.
 */

import { describe, it, expect } from "vitest";
import { isSafeRelativeEvidencePath } from "../src/utils/evidence-path.js";

describe("isSafeRelativeEvidencePath — rejected paths", () => {
  it.each([
    ["Windows drive-absolute", "C:/secrets.md"],
    ["Windows drive-absolute backslash", "C:\\secrets.md"],
    ["UNC double-slash", "//host/share/x"],
    ["UNC double-backslash", "\\\\host\\share"],
    ["POSIX absolute", "/etc/passwd"],
    ["backslash-absolute", "\\windows"],
    ["dot-dot traversal", "foo/../bar"],
    ["bare dot-dot", ".."],
    ["empty segment", "a//b"],
    ["space in segment", "a/ /b"],
    ["NUL in segment", "a/\0/b"],
    ["drive-colon in non-first segment", "sources/C:/secrets.md"],
    ["NTFS alternate data stream", "sources/file.md:ads"],
    ["colon mid-segment", "a/b:c/d"],
    ["colon-prefixed", "x:y"],
  ])("rejects %s (%s)", (_label, p) => {
    expect(isSafeRelativeEvidencePath(p)).toBe(false);
  });

  it("rejects a path over the length cap", () => {
    expect(isSafeRelativeEvidencePath("a/".repeat(600) + "b.md")).toBe(false);
  });
});

describe("isSafeRelativeEvidencePath — accepted paths", () => {
  it.each([
    ["simple relative", "sources/paper.md"],
    ["two-segment", "a/b/c.md"],
    ["nested", "sources/sub/x.md"],
    ["single file", "guide.md"],
  ])("accepts %s (%s)", (_label, p) => {
    expect(isSafeRelativeEvidencePath(p)).toBe(true);
  });
});
