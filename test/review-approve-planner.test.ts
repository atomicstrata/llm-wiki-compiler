/**
 * @file test/review-approve-planner.test.ts
 * @description Reroute-specific coverage for `review approve` once its page
 * write goes through the write planner/executor (CLP Invariant 4) instead of a
 * direct `atomicWrite`. The byte/stdout PARITY of the happy path is pinned by
 * the existing `test/review.test.ts` "review approve command" suite (which must
 * still pass unchanged); this file pins the behaviours the reroute newly
 * activates: Unicode slugs (only possible because PR2's typed planner is
 * bypassed for default pages), upsert-on-overwrite, loud failure when the
 * mandatory resource-limit floor blocks the body, and crashed-batch journal
 * replay under the already-held review lock.
 */

import { describe, it, expect, vi } from "vitest";
import { writeFile, readFile } from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import { writeCandidate } from "../src/compiler/candidates.js";
import reviewApproveCommand from "../src/commands/review-approve.js";
import { openBatch, recordPreState, type JournalBatch } from "../src/trust/journal.js";
import { CANDIDATES_DIR, CONCEPTS_DIR, MAX_SOURCE_CHARS } from "../src/utils/constants.js";
import { useTempRoot } from "./fixtures/temp-root.js";

const root = useTempRoot();

/** A frontmatter+body page string that passes validateWikiPage, for `slug`. */
function validBody(slug: string): string {
  return [
    "---",
    `title: ${slug}`,
    'summary: "A summary"',
    "sources:",
    '  - "source.md"',
    'createdAt: "2026-01-01T00:00:00.000Z"',
    'updatedAt: "2026-01-01T00:00:00.000Z"',
    "tags: []",
    "aliases: []",
    "---",
    "",
    `Body for ${slug}.`,
    "",
  ].join("\n");
}

/** Write a pending candidate whose body is the valid page for its slug. */
function draftFor(slug: string, body = validBody(slug)) {
  return { title: slug, slug, summary: "A summary", sources: ["source.md"], body };
}

/** Absolute wiki page / candidate-record paths for a slug under the temp root. */
const pageFor = (slug: string) => path.join(root.dir, CONCEPTS_DIR, `${slug}.md`);
const recordFor = (id: string) => path.join(root.dir, CANDIDATES_DIR, `${id}.json`);

/**
 * Seed a candidate for `slug` (body defaults to its valid page), silence both
 * console streams, run approve, and return the candidate id — the shared arrange
 * step so each reroute test asserts only its own outcome.
 */
async function approveDraft(slug: string, body?: string): Promise<string> {
  const candidate = await writeCandidate(root.dir, draftFor(slug, body ?? validBody(slug)));
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  await reviewApproveCommand(candidate.id);
  return candidate.id;
}

describe("review approve — planner reroute", () => {
  it("approves a Unicode-slug candidate and writes wiki/concepts/café-society.md", async () => {
    const slug = "café-society";
    const id = await approveDraft(slug);
    expect(await readFile(pageFor(slug), "utf-8")).toBe(validBody(slug));
    expect(existsSync(recordFor(id))).toBe(false);
  });

  it("re-approves an existing page via update without a create collision", async () => {
    const slug = "reapprove";
    await writeFile(pageFor(slug), "stale prior bytes\n");
    await approveDraft(slug);
    expect(await readFile(pageFor(slug), "utf-8")).toBe(validBody(slug));
    expect(process.exitCode ?? 0).toBe(0);
  });

  it("fails loudly and retains the candidate when the body exceeds the resource-limit floor", async () => {
    const slug = "oversized";
    const filler = "\n" + "x".repeat(MAX_SOURCE_CHARS); // valid frontmatter, oversized total
    const id = await approveDraft(slug, validBody(slug) + filler);
    expect(process.exitCode).toBe(1);
    expect(existsSync(pageFor(slug))).toBe(false);
    expect(existsSync(recordFor(id))).toBe(true);
    process.exitCode = 0;
  });

  it("replays a dangling pending journal on the next approve (crashed-batch recovery)", async () => {
    // Plant the journal under the SAME root form the command uses (process.cwd,
    // the realpath of root.dir) so the crashed batch is the one approve replays.
    const cmdRoot = process.cwd();
    const orphan = path.join(cmdRoot, CONCEPTS_DIR, "orphan.md");
    await writeFile(orphan, "pre-batch bytes\n");
    const batch: JournalBatch = await openBatch(cmdRoot);
    await recordPreState(batch, orphan); // pending, never committed → a crashed batch
    await writeFile(orphan, "torn post-crash bytes\n"); // simulate a half-applied write

    await approveDraft("trigger");

    // The approve ran replayJournal under the review lock → orphan reverted to pre-batch bytes.
    expect(await readFile(orphan, "utf-8")).toBe("pre-batch bytes\n");
  });
});
