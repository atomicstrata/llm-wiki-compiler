/**
 * @file test/profile-posix-dir.test.ts
 * @description Pins WHERE separator resolution happens in the profile path
 * layer (#163), across the two functions that together decide it.
 *
 * The layer has exactly one rule: `normalizeDeclaredDir` resolves separators,
 * and everything downstream compares the `/`-joined result lexically. Both
 * halves need pinning, because a change to either alone silently breaks the
 * other:
 *
 *  - `normalizeDeclaredDir` splits on `[\\/]`, so a Windows-authored
 *    `wiki\papers` canonicalizes to `wiki/papers` and loads everywhere. That is
 *    what makes the `..` check meaningful — it runs on the split segments, so
 *    `wiki\..\..\etc` is rejected instead of passing a `/`-only split as one
 *    opaque segment.
 *  - `isInsidePosixDir` does NOT normalize. It is only ever handed canonical
 *    output from the function above, so a backslash arriving here means a
 *    caller skipped canonicalization, and refusing to match is the fail-closed
 *    answer. A future contributor could "harden" it with `.replace(/\\/g, "/")`
 *    — plausible-looking Windows normalization — and pass `tsc`, the build, and
 *    the grep gate; the result would be a second, divergent place deciding what
 *    a separator is, which is exactly the split-brain this file exists to stop.
 *
 * `test/profile-posix-path-gate.test.ts` does not cover any of this: it greps
 * the source text of the profile modules for native-separator tokens, and never
 * calls these functions.
 */
import { describe, it, expect } from "vitest";
import { isInsidePosixDir, validateEntityDirectory } from "../src/profile/paths.js";

describe("normalizeDeclaredDir — the one place separators are resolved", () => {
  it("treats a backslash as a separator so Windows-authored profiles load", () => {
    expect(validateEntityDirectory("wiki\\papers", [])).toBe("wiki/papers");
    expect(validateEntityDirectory("wiki\\a\\b", [])).toBe("wiki/a/b");
  });

  it("checks '..' on the split segments, so a backslash cannot smuggle traversal", () => {
    expect(() => validateEntityDirectory("wiki\\..\\..\\etc", [])).toThrow(/'\.\.' or NUL segment/);
  });

  it("still rejects a canonicalized path that overlaps a reserved root", () => {
    expect(() => validateEntityDirectory("wiki\\papers", ["wiki/papers"])).toThrow(/reserved root/);
  });
});

describe("isInsidePosixDir — compares canonical input, never normalizes it", () => {
  it("does not treat a literal backslash as a separator (#163)", () => {
    expect(isInsidePosixDir("wiki\\papers", "wiki")).toBe(false);
    expect(isInsidePosixDir("sources\\evil/x.md", "sources")).toBe(false);
  });

  it("requires a segment boundary, not a textual prefix", () => {
    expect(isInsidePosixDir("wikifoo", "wiki")).toBe(false);
    expect(isInsidePosixDir("wiki/papers", "wiki")).toBe(true);
    expect(isInsidePosixDir("wiki", "wiki")).toBe(true);
  });
});
