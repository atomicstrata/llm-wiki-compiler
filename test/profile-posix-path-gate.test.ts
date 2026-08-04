/**
 * @file test/profile-posix-path-gate.test.ts
 * @description Executable regression gate for issue #163.
 *
 * The profile layer works in CANONICAL repo-relative POSIX strings — the
 * `/`-joined form `normalizeDeclaredDir` produces — so its containment checks
 * must be purely lexical. Reaching for the PLATFORM separator there (directly,
 * or via `isInsideDir` from `utils/path-confine.js`) rejected every nested
 * declared directory on win32, and no profile could load.
 *
 * Scoped to ALL of `src/profile/**`, minus an explicit {@link NATIVE_MODULES}
 * exception list, rather than to the two modules the fix happened to touch. An
 * allowlist of known-good files stops defending the invariant the moment someone
 * adds a third module; with the polarity inverted, a new file is covered by
 * default and an exception is a deliberate, reviewable edit to this list.
 *
 * Comments are blanked before matching, via the shared `stripComments` fixture
 * also used by `test/genericity-grep-gate.test.ts`. The most valuable comment in
 * this fix is the docstring explaining WHY the native helper is wrong here, and
 * that prose necessarily names it. String literals are kept, so a name smuggled
 * through a string still trips the gate.
 *
 * Pure read gate — touches nothing under `src/`.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stripComments } from "./fixtures/strip-comments.js";

const PROFILE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/profile");

/**
 * Modules that legitimately compare NATIVE absolute realpaths (symlink
 * confinement at a write boundary), where `path.sep` is the CORRECT separator.
 * Paths are `src/profile`-relative, matched as prefixes. Adding an entry means
 * asserting the module never compares declared, repo-relative paths.
 */
const NATIVE_MODULES = ["scaffold.ts", "templates/publish/"];

/** Every `.ts` under `src/profile`, POSIX-relative, excluding {@link NATIVE_MODULES}. */
function lexicalModules(dir = PROFILE_DIR, prefix = ""): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) found.push(...lexicalModules(path.join(dir, entry.name), rel));
    else if (entry.name.endsWith(".ts") && !NATIVE_MODULES.some((m) => rel.startsWith(m))) found.push(rel);
  }
  return found;
}

/** `file:line — text` for every CODE line in the lexical modules matching `pattern`. */
function hits(pattern: RegExp): string[] {
  const found: string[] = [];
  for (const relativePath of lexicalModules()) {
    const source = readFileSync(path.join(PROFILE_DIR, relativePath), "utf8");
    stripComments(source).split("\n").forEach((line, index) => {
      // .search(), not .test(): stays flag-independent if a pattern here ever gains
      // the stateful /g flag, which would advance lastIndex and skip alternating matches.
      if (line.search(pattern) !== -1) found.push(`${relativePath}:${index + 1} — ${line.trim()}`);
    });
  }
  return found;
}

describe("lexical profile path checks stay separator-agnostic (#163)", () => {
  it("never calls isInsideDir, the native-separator helper", () => {
    expect(hits(/\bisInsideDir\b/)).toEqual([]);
  });

  it("never uses path.sep, the platform separator", () => {
    expect(hits(/\bpath\.sep\b/)).toEqual([]);
  });

  it("covers the whole profile layer, not just the modules the fix touched", () => {
    const covered = lexicalModules();
    expect(covered).toContain("paths.ts");
    expect(covered).toContain("validate.ts");
    expect(covered.length).toBeGreaterThan(10);
    expect(covered).not.toContain("scaffold.ts");
    expect(covered.some((m) => m.startsWith("templates/publish/"))).toBe(false);
  });

  it("blanks comments while keeping string literals (matcher self-test)", () => {
    const stripped = stripComments('const a = "isInsideDir";\n// isInsideDir in a comment\n');
    expect(stripped).toContain('"isInsideDir"');
    expect(stripped.split("\n")[1]).not.toContain("isInsideDir");
  });
});
