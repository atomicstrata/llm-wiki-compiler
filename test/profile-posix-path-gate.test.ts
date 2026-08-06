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
 * Three rules, and the third is the general one. Naming `isInsideDir` and
 * `path.sep` only catches the two symbols the original fix happened to touch —
 * raw `path.relative` output reaching a public field is the SAME bug one layer
 * out (a `path` promised as `wiki/notes/x.md` arriving as `wiki\notes\x.md`),
 * and it passed the first two rules untouched. So the third rule gates the
 * mechanism: `path.relative` is the call that turns a native filesystem path
 * into portable content, and in this layer its result must always be routed
 * through `toPosixPath`.
 *
 * `path.join` is deliberately NOT gated. Its ~23 call sites here build native
 * paths to hand back to `fs`, which is exactly what it should emit; forbidding
 * it would be noise. The invariant is about values that LEAVE as content.
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

/**
 * Blank the `path.relative` calls that ARE correctly routed through
 * `toPosixPath`, leaving only the bare ones for the mechanism rule to catch.
 */
function blankWrappedRelative(line: string): string {
  return line.replace(/toPosixPath\(\s*path\.relative\b/g, "");
}

/**
 * `file:line — text` for every CODE line in the lexical modules matching `pattern`.
 *
 * @param pattern - What disqualifies a line.
 * @param prepare - Applied to each code line first, to blank the forms that are
 *   allowed (see {@link blankWrappedRelative}). Defaults to no rewriting.
 */
function hits(pattern: RegExp, prepare: (line: string) => string = (line) => line): string[] {
  const found: string[] = [];
  for (const relativePath of lexicalModules()) {
    const source = readFileSync(path.join(PROFILE_DIR, relativePath), "utf8");
    stripComments(source).split("\n").forEach((line, index) => {
      // .search(), not .test(): stays flag-independent if a pattern here ever gains
      // the stateful /g flag, which would advance lastIndex and skip alternating matches.
      if (prepare(line).search(pattern) !== -1) found.push(`${relativePath}:${index + 1} — ${line.trim()}`);
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

  it("never lets a path.relative result out unwrapped by toPosixPath", () => {
    expect(hits(/\bpath\.relative\b/, blankWrappedRelative)).toEqual([]);
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

  it("spares a wrapped path.relative but still catches a bare one (matcher self-test)", () => {
    expect(blankWrappedRelative("x = toPosixPath(path.relative(a, b));")).not.toContain("path.relative");
    expect(blankWrappedRelative("x = path.relative(a, b);")).toContain("path.relative");
    // Both forms on one line: the bare one must survive the blanking.
    expect(blankWrappedRelative("toPosixPath(path.relative(a, b)) + path.relative(c, d)")).toContain("path.relative");
  });
});
