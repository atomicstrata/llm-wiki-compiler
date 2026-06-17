/**
 * @file test/profile-lint.test.ts
 * @description Tests for profile-aware lint over non-default entity pages.
 *
 * Covers: (a) a NON-default project surfaces a `LintResult` (correct severity)
 * for each EntityProblem kind — invalid-directory, non-slug-safe-filename,
 * field-violation — plus an `empty-page` warning over an entity page's body;
 * (b) a DEFAULT project's `lint(root)` is unchanged (no profile findings, no
 * `entityType` on any result), proving the default path stays byte-identical.
 */

import { describe, it, beforeEach, afterEach, expect } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, symlink } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { lint } from "../src/linter/index.js";
import { CONCEPTS_DIR, PROFILE_FILE } from "../src/utils/constants.js";
import type { ProfilePack } from "../src/profile/types.js";

let root = "";

/**
 * A non-default profile: `notes` requires a `title` field and lives at
 * wiki/notes; `tasks` lives at wiki/tasks (used as the symlinked-dir victim).
 */
const PROFILE: ProfilePack = {
  schemaVersion: 1,
  profileId: "sample",
  entities: {
    notes: {
      directory: "wiki/notes",
      requiredFields: ["title"],
      fields: { title: { type: "string" } },
    },
    tasks: { directory: "wiki/tasks" },
  },
};

/** Write the profile.json into the project's .llmwiki/ dir. */
async function writeProfile(pack: ProfilePack): Promise<void> {
  await mkdir(path.join(root, path.dirname(PROFILE_FILE)), { recursive: true });
  await writeFile(path.join(root, PROFILE_FILE), JSON.stringify(pack));
}

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "profile-lint-"));
});

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

/** Find the lone result for a given rule id; assert exactly one exists. */
function ruleResult(results: { rule: string }[], rule: string): { severity: string; entityType?: string } {
  const matches = results.filter((r) => r.rule === rule);
  expect(matches).toHaveLength(1);
  return matches[0] as { severity: string; entityType?: string };
}

describe("lint — non-default profile entity findings", () => {
  beforeEach(async () => {
    await mkdir(path.join(root, "wiki/notes"), { recursive: true });
    // (a) symlinked entity dir for `tasks` → invalid-directory (error).
    const elsewhere = path.join(root, "elsewhere");
    await mkdir(elsewhere, { recursive: true });
    await symlink(elsewhere, path.join(root, "wiki/tasks"));
    // (b) non-slug-safe filename → non-slug-safe-filename (error).
    await writeFile(path.join(root, "wiki/notes/Bad Name.md"), "---\ntitle: T\n---\n\nbody body body body body body body body.\n");
    // (c) field-contract violation: missing required `title` → field-violation (warning).
    await writeFile(path.join(root, "wiki/notes/no-title.md"), "# no-title\n\nbody body body body body body body body.\n");
    // (d) empty entity page (titled, near-empty body) → empty-page (warning).
    await writeFile(path.join(root, "wiki/notes/sparse.md"), "---\ntitle: Sparse\n---\n\nhi\n");
    await writeProfile(PROFILE);
  });

  it("surfaces an error for each structural EntityProblem kind", async () => {
    const { results } = await lint(root);
    expect(ruleResult(results, "profile/invalid-directory").severity).toBe("error");
    expect(ruleResult(results, "profile/non-slug-safe-filename").severity).toBe("error");
  });

  it("surfaces field-violation and empty-page as warnings, tagged by entityType", async () => {
    const { results } = await lint(root);
    const fieldViolation = ruleResult(results, "profile/field-violation");
    expect(fieldViolation.severity).toBe("warning");
    expect(fieldViolation.entityType).toBe("notes");
    const empty = ruleResult(results, "empty-page");
    expect(empty.severity).toBe("warning");
    expect(empty.entityType).toBe("notes");
  });
});

describe("lint — default project unchanged", () => {
  it("emits no profile findings and no entityType on any result", async () => {
    const concepts = path.join(root, CONCEPTS_DIR);
    await mkdir(concepts, { recursive: true });
    await writeFile(path.join(concepts, "foo.md"), "---\ntitle: Foo\n---\n\nbody body body body body body body body.\n");
    const { results } = await lint(root);
    expect(results.some((r) => r.rule.startsWith("profile/"))).toBe(false);
    expect(results.every((r) => r.entityType === undefined)).toBe(true);
  });
});
