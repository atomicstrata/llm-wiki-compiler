/**
 * @file test/lifecycle-frontmatter-preservation.test.ts
 * @description Regression tests for the lifecycle-transition body rebuild: a
 * transition must flip ONLY the lifecycle field (and append accepted evidence),
 * leaving every OTHER frontmatter field's original bytes UNTOUCHED.
 *
 * Pre-fix the handler rebuilt the body via `buildFrontmatter(parseFrontmatter(...))`,
 * which round-tripped an unquoted date-only `created: 2024-01-15` through a JS
 * `Date` and re-dumped it as the ISO datetime `2024-01-15T00:00:00.000Z` — a field
 * the transition never touched was silently retyped on EVERY transition. These
 * tests pin that the date line stays byte-for-byte and the lifecycle flips.
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile, mkdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { transitionLifecycle } from "../src/trust/lifecycle-transition.js";
import { buildResearchLiteProject } from "./fixtures/profile-fixtures.js";
import { reviewerLifecycleProfile } from "./fixtures/seam-fixtures.js";
import { parseFrontmatter } from "../src/utils/markdown.js";
import { PROFILE_FILE } from "../src/utils/constants.js";
import type { ProfilePack } from "../src/profile/types.js";

const PAGE_PATH = "wiki/papers/a.md";

/** Seed a project whose `papers/a` page carries a date-only `created` field. */
async function seedDatedPage(root: string, frontmatter: string): Promise<void> {
  await buildResearchLiteProject(root);
  await writeFile(path.join(root, PROFILE_FILE), JSON.stringify(reviewerLifecycleProfile()), "utf8");
  await mkdir(path.join(root, "wiki/papers"), { recursive: true });
  await writeFile(path.join(root, PAGE_PATH), frontmatter, "utf8");
}

/** Read the rebuilt page's frontmatter block (the text between the `---` fences). */
async function readFrontmatterBlock(root: string): Promise<string> {
  const raw = await readFile(path.join(root, PAGE_PATH), "utf8");
  return raw.match(/^---\n([\s\S]*?)\n---/)![1];
}

describe("lifecycle transition preserves non-lifecycle frontmatter bytes", () => {
  let root = "";
  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    root = "";
  });

  it("leaves a date-only created field byte-unchanged and flips the lifecycle field", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "lc-fm-"));
    await seedDatedPage(root, "---\ncreated: 2024-01-15\ntitle: Hello\nlifecycle: draft\n---\n\nBody.\n");
    await transitionLifecycle(root, "papers", "a", "review", { reviewer: "alice" });
    const fm = await readFrontmatterBlock(root);
    // The date line is byte-for-byte: no time component, no ISO datetime, no quotes.
    expect(fm).toContain("created: 2024-01-15");
    expect(fm).not.toContain("2024-01-15T00:00:00");
    expect(fm).toContain("title: Hello"); // untouched neighbour preserved
    expect(fm).toContain("lifecycle: review"); // lifecycle flipped
    expect(fm).toContain("reviewer: alice"); // accepted evidence appended
  });

  it("preserves multiple non-lifecycle date fields untouched on a no-evidence transition", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "lc-fm-"));
    await seedDatedPage(
      root,
      "---\ncreated: 2024-01-15\nupdated: 2024-06-01\nlifecycle: review\n---\n\nBody.\n",
    );
    await transitionLifecycle(root, "papers", "a", "published"); // no requirements
    const fm = await readFrontmatterBlock(root);
    expect(fm).toContain("created: 2024-01-15");
    expect(fm).toContain("updated: 2024-06-01");
    expect(fm).not.toContain("T00:00:00");
    expect(fm).toContain("lifecycle: published");
  });
});

/** A `papers` lifecycle whose `review` transition requires a `string[]` `reviewers`. */
function listReviewerProfile(): ProfilePack {
  return {
    schemaVersion: 1,
    profileId: "research-list-reviewer",
    entities: {
      papers: {
        directory: "wiki/papers",
        requiredFields: ["lifecycle"],
        fields: {
          lifecycle: { type: "enum", enum: ["draft", "review", "published"] },
          reviewers: { type: "string[]" },
        },
        lifecycle: {
          field: "lifecycle",
          initial: "draft",
          terminal: ["published"],
          transitions: { draft: ["review"], review: ["published"] },
          transitionRequirements: { review: ["reviewers"] },
        },
      },
    },
  } as ProfilePack;
}

describe("lifecycle transition through the SDK writes EXACTLY the validated list evidence", () => {
  let root = "";
  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    root = "";
  });

  // A `string[]` requirement re-supplied while it pre-exists as a block list must
  // not merge old+new: the written page must re-parse to EXACTLY the validated value.
  it("re-supplying a string[] that pre-exists as a block list writes only the new items", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "lc-fm-"));
    await buildResearchLiteProject(root);
    await writeFile(path.join(root, PROFILE_FILE), JSON.stringify(listReviewerProfile()), "utf8");
    await mkdir(path.join(root, "wiki/papers"), { recursive: true });
    await writeFile(
      path.join(root, PAGE_PATH),
      "---\nlifecycle: draft\nreviewers:\n  - oldA\n  - oldB\n---\n\nBody.\n",
      "utf8",
    );
    await transitionLifecycle(root, "papers", "a", "review", { reviewers: ["alice"] });
    const meta = parseFrontmatter(await readFile(path.join(root, PAGE_PATH), "utf8")).meta;
    expect(meta.reviewers).toEqual(["alice"]); // NOT ["alice","oldA","oldB"]
    expect(meta.lifecycle).toBe("review");
  });
});
