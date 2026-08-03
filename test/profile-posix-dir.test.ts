/**
 * @file test/profile-posix-dir.test.ts
 * @description Direct behavioral test for `isInsidePosixDir` (#163): pins the
 * no-normalization invariant its own docstring asserts but that no test
 * previously exercised.
 *
 * `isInsidePosixDir` (`src/profile/paths.ts`) compares CANONICAL repo-relative
 * POSIX strings and, by design, does NOT normalize its inputs. A literal
 * backslash must keep failing to match a `/` separator, because on POSIX
 * (Linux/macOS) `\` is a legal filename character: a directory really named
 * `wiki\papers` is one segment — a sibling of `wiki`, not a child of it.
 * Rewriting `\` to `/` before comparing would make that sibling read as
 * contained, which is a real POSIX containment escape, not a Windows
 * compatibility fix.
 *
 * That property is currently pinned by prose alone. It is unreachable through
 * the rest of the suite because `normalizeDeclaredDir` — the only production
 * caller path — splits on `/[\\/]/` and so strips every backslash before
 * `isInsidePosixDir` is ever invoked; no higher-level test can therefore see a
 * backslash reach this function. `test/profile-posix-path-gate.test.ts` does
 * not cover it either: it is a grep gate over the source text of
 * `profile/paths.ts` and `profile/validate.ts` (banning the `isInsideDir` and
 * `path.sep` tokens), not a behavioral test of what `isInsidePosixDir` returns.
 *
 * Without this file, a future contributor could "harden" the helper with
 * `.replace(/\\/g, "/")` — plausible-looking Windows-path normalization — and
 * pass `tsc`, the build, the full test suite, and the grep gate, while quietly
 * reopening the escape this function exists to close.
 */
import { describe, it, expect } from "vitest";
import { isInsidePosixDir } from "../src/profile/paths.js";

describe("isInsidePosixDir", () => {
  it("never treats a literal backslash as a separator (#163)", () => {
    expect(isInsidePosixDir("wiki\\papers", "wiki")).toBe(false);
    expect(isInsidePosixDir("sources\\evil/x.md", "sources")).toBe(false);
  });

  it("requires a segment boundary, not a textual prefix", () => {
    expect(isInsidePosixDir("wikifoo", "wiki")).toBe(false);
    expect(isInsidePosixDir("wiki/papers", "wiki")).toBe(true);
    expect(isInsidePosixDir("wiki", "wiki")).toBe(true);
  });
});
