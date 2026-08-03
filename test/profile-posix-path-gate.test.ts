/**
 * @file test/profile-posix-path-gate.test.ts
 * @description Executable regression gate for issue #163.
 *
 * `src/profile/paths.ts` and `src/profile/validate.ts` perform PURELY LEXICAL
 * containment checks on canonical repo-relative POSIX strings produced by
 * `normalizeDeclaredDir` (always `/`-joined, never backslashed). Their CODE must
 * therefore never call the native-separator helper from `utils/path-confine.js`,
 * nor reach for the platform separator directly — on win32 that rejected every
 * nested declared directory and no profile could load.
 *
 * Comments are blanked before matching, via the shared `stripComments` fixture
 * also used by `test/genericity-grep-gate.test.ts`. The most valuable comment in
 * this fix is the docstring explaining WHY the native helper is wrong here, and
 * that prose necessarily names it. String literals are kept, so a name smuggled
 * through a string still trips the gate.
 *
 * Deliberately scoped to those two modules. `src/profile/scaffold.ts` and
 * `src/profile/templates/publish/*` compare NATIVE absolute realpaths and must
 * keep using both; flagging them would be a false positive.
 *
 * Pure read gate — touches nothing under `src/`.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stripComments } from "./fixtures/strip-comments.js";

const SRC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src");

/** The lexical profile-path modules: these compare posix repo-relative strings only. */
const LEXICAL_MODULES = ["profile/paths.ts", "profile/validate.ts"];

/** `file:line — text` for every CODE line in {@link LEXICAL_MODULES} matching `pattern`. */
function hits(pattern: RegExp): string[] {
  const found: string[] = [];
  for (const relativePath of LEXICAL_MODULES) {
    const source = readFileSync(path.join(SRC_DIR, relativePath), "utf8");
    stripComments(source).split("\n").forEach((line, index) => {
      if (pattern.test(line)) found.push(`${relativePath}:${index + 1} — ${line.trim()}`);
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

  it("blanks comments while keeping string literals (matcher self-test)", () => {
    const stripped = stripComments('const a = "isInsideDir";\n// isInsideDir in a comment\n');
    expect(stripped).toContain('"isInsideDir"');
    expect(stripped.split("\n")[1]).not.toContain("isInsideDir");
  });
});
