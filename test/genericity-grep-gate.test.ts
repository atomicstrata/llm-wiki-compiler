/**
 * @file test/genericity-grep-gate.test.ts
 * @description Executable abstraction-failure gate (Phase 7 C1). Walks every `.ts`
 * under `src/`, strips comment content (keeping string literals + line numbers), and
 * asserts core carries ZERO profile-shaped branches: no `profileId === "<non-default>"`
 * equality, and no equality/`case` branch on any declared research OR newsroom
 * entity-type or relation-type name. A hit means a capability quietly grew a
 * hard-coded per-profile branch — the exact regression this gate exists to catch, so
 * failures report the offending `file:line` + matched text. The one built-in exception
 * is `src/profile/default.ts`'s `profileId === "default"` sentinel (allowlisted below).
 * Matching the QUOTED literal exactly word-boundaries the check (`=== "tests"` is a
 * hit; `=== "attests"` is not). No `src/` edit — this is a pure read gate.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SRC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src");

/** The sole file allowed to compare `profileId` to the built-in `default` sentinel. */
const DEFAULT_PROFILE_ALLOWLIST = "profile/default.ts";

const TEMPLATE_DATA_FILES = new Set([
  "profile/templates/builtin/default.ts",
  "profile/templates/builtin/autosci/entities.ts",
  "profile/templates/builtin/autosci/relations.ts",
  "profile/templates/builtin/autosci/artifacts.ts",
  "profile/templates/builtin/autosci/workflows.ts",
  "profile/templates/builtin/autosci.ts",
  "profile/templates/builtin/newsroom.ts",
]);

/** Every declared research + newsroom entity-type name (a branch on any is an abstraction failure). */
const ENTITY_TYPES = ["experiments", "papers", "manuscripts", "ideas", "methods", "foundations", "reviews", "topics", "people", "research-outputs", "articles", "desks", "bylines", "stories"];
/** Every declared research + newsroom relation-type name. */
const RELATION_TYPES = ["cites", "builds-on", "challenges", "introduces-concept", "uses-concept", "proposes-method", "extends-method", "tests", "supports", "contradicts", "derived-from", "addresses-gap", "filed-under"];

/**
 * A `profileId` compared to a string literal (captures an optional `typeof` prefix +
 * the compared value). A `typeof profileId !== "string"` runtime type guard is NOT a
 * profile-identity branch, so the `typeof` capture lets {@link findViolations} skip it.
 */
const PROFILE_ID_EQ = /(\btypeof\s+)?profileId\s*(?:===|!==|==|!=)\s*(['"])([^'"]*)\2/g;

interface Violation { file: string; line: number; text: string; }

/** Match strings/comments; used to blank comment bytes while preserving strings + newlines. */
const STRINGS_OR_COMMENTS = /("(?:\\.|[^"\\])*")|('(?:\\.|[^'\\])*')|(`(?:\\.|[^`\\])*`)|(\/\/[^\n]*)|(\/\*[\s\S]*?\*\/)/g;

/** Blank comment content (keep string literals verbatim, preserve newlines for line numbers). */
function stripComments(src: string): string {
  return src.replace(STRINGS_OR_COMMENTS, (m, dq, sq, tpl) =>
    dq || sq || tpl ? m : m.replace(/[^\n]/g, " "));
}

/** An equality/`case` branch on any of `names`, matched as an exact quoted literal. */
function branchLiteralRegex(names: string[]): RegExp {
  const alt = names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  return new RegExp(`(?:===|!==|==|!=|\\bcase)\\s*(['"])(?:${alt})\\1`, "g");
}

/** Every recursive `.ts` file under `dir`, as paths relative to `SRC_DIR` (forward slashes). */
function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listTsFiles(full));
    else if (entry.name.endsWith(".ts")) out.push(path.relative(SRC_DIR, full).split(path.sep).join("/"));
  }
  return out;
}

/** Collect every abstraction-failure branch in one file's (comment-stripped) source. */
function findViolations(file: string, src: string): Violation[] {
  const out: Violation[] = [];
  const nameRe = branchLiteralRegex([...ENTITY_TYPES, ...RELATION_TYPES]);
  stripComments(src).split("\n").forEach((line, idx) => {
    for (const m of line.matchAll(PROFILE_ID_EQ)) {
      if (m[1]) continue; // `typeof profileId !== "string"` type guard, not an identity branch
      if (m[3] === "default" && file === DEFAULT_PROFILE_ALLOWLIST) continue; // built-in sentinel
      out.push({ file, line: idx + 1, text: m[0] });
    }
    for (const m of line.matchAll(nameRe)) out.push({ file, line: idx + 1, text: m[0] });
  });
  return out;
}

describe("genericity grep gate", () => {
  it("the matcher catches planted abstraction-failure branches (and ignores comments/substrings)", () => {
    const planted = [
      'if (loaded.profile.profileId === "custom") return;',
      'switch (rel.type) { case "filed-under": break; }',
      'const stale = kind !== "stories";',
      '// profileId === "custom" — a mention in a comment must NOT trip',
      'const ok = suffix === "attests"; // substring of "tests" must NOT trip',
    ].join("\n");
    const hits = findViolations("some/module.ts", planted);
    expect(hits.map((h) => ({ line: h.line, text: h.text }))).toEqual([
      { line: 1, text: 'profileId === "custom"' },
      { line: 2, text: 'case "filed-under"' },
      { line: 3, text: '!== "stories"' },
    ]);
  });

  it("allowlists only src/profile/default.ts's profileId === \"default\" sentinel", () => {
    expect(findViolations(DEFAULT_PROFILE_ALLOWLIST, 'return p.profileId === "default";')).toEqual([]);
    // The SAME construct in any other file is a violation (a per-profile branch).
    expect(findViolations("profile/other.ts", 'if (p.profileId === "default") {}')).toHaveLength(1);
  });

  it("src/ contains zero abstraction-failure branches", () => {
    const violations = listTsFiles(SRC_DIR)
      .filter((file) => !TEMPLATE_DATA_FILES.has(file))
      .flatMap((file) => findViolations(file, readFileSync(path.join(SRC_DIR, file), "utf8")));
    expect(violations.map((v) => `${v.file}:${v.line} ${v.text}`)).toEqual([]);
  });
});
