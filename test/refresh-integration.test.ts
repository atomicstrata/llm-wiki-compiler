/**
 * Real-run integration tests for `llmwiki refresh --stale`.
 *
 * Exercises the full in-process recompile path via `resolveStaleRefresh` +
 * `compileAndReport` with a stubbed AnthropicProvider (same convention as
 * compile-delta.test.ts). Proves three guarantees of the v1 implementation:
 *
 *  1. A stale page (changed source hash) IS recompiled.
 *  2. A new source (not in state) is skipped — refresh does not compile new sources.
 *  3. A partial-deletion "shared" page has its state REPAIRED (deleted owner
 *     removed from state.sources) but its content byte-for-byte UNCHANGED — the
 *     unchanged live owner is NOT recompiled (v1 limitation: no force-rebuild).
 */

import { describe, it, expect, vi } from "vitest";
import { writeFile, readFile, rm } from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import { compileAndReport } from "../src/compiler/index.js";
import { resolveStaleRefresh } from "../src/compiler/refresh-plan.js";
import { AnthropicProvider } from "../src/providers/anthropic.js";
import { readStateClassified } from "../src/utils/state.js";
import { CONCEPTS_DIR } from "../src/utils/constants.js";
import { makeCompileProjectRoot } from "./fixtures/compile-project.js";
import { writeSourceState, writeSourceFile, sha256Hex } from "./fixtures/state-json.js";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Minimal extraction JSON for one concept. */
function extractionFor(title: string): string {
  return JSON.stringify({
    concepts: [{ concept: title, summary: `Summary of ${title}.`, is_new: true }],
  });
}

const STUB_BODY = "Stub body content. ^[a.md]";

/**
 * Build a fresh temp project root with sources/ wiki/concepts/ .llmwiki/ dirs.
 * The shared fixture also seeds an unrelated `sample.md` into sources/ with no
 * state entry — like new.md it has no owner page and is correctly filtered out
 * of the refresh run, so each test's effective sources are its own files + sample.md.
 */
async function makeTmpRoot(suffix: string): Promise<string> {
  return makeCompileProjectRoot({ dirSuffix: `refresh-integ-${suffix}` });
}

/** Silence compile output and run resolveStaleRefresh + compileAndReport. */
async function runRefresh(root: string) {
  vi.spyOn(console, "log").mockImplementation(() => {});
  const { plan } = await resolveStaleRefresh(root);
  expect(plan).not.toBeNull();
  return compileAndReport(root, { changeFilter: plan!.changeFilter, skipSeedPages: true });
}

/** Write a minimal valid wiki page for a concept slug. */
async function writeConceptPage(root: string, slug: string, title: string, sources: string[], body: string): Promise<void> {
  const frontmatter = [
    "---",
    `title: ${title}`,
    `summary: ${title} summary.`,
    `sources: [${sources.join(", ")}]`,
    "createdAt: 2024-01-01T00:00:00.000Z",
    "updatedAt: 2024-01-01T00:00:00.000Z",
    "---",
    "",
    body,
  ].join("\n");
  await writeFile(path.join(root, CONCEPTS_DIR, `${slug}.md`), frontmatter, "utf-8");
}

/** Stub extraction and page-body calls on AnthropicProvider. Returns the extraction spy. */
function stubProviderCalls(extractionTitle: string) {
  const spy = vi.spyOn(AnthropicProvider.prototype, "toolCall")
    .mockResolvedValue(extractionFor(extractionTitle));
  vi.spyOn(AnthropicProvider.prototype, "complete").mockResolvedValue(STUB_BODY);
  return spy;
}

// ---------------------------------------------------------------------------
// Test 1: recompile a stale page, leave a new source uncompiled
// ---------------------------------------------------------------------------

describe("refresh --stale (real run, stubbed provider)", () => {
  it("recompiles a stale page and leaves a new source uncompiled", async () => {
    process.env.LLMWIKI_PROVIDER = "anthropic";
    process.env.ANTHROPIC_API_KEY = "test-key";
    const root = await makeTmpRoot("stale");

    try {
      const aContent = "# Topic A\n\nAbout A.";
      await writeSourceFile(root, "a.md", aContent);
      await writeSourceState(root, {
        "a.md": { hash: "stale-hash-not-matching-disk", concepts: ["topic-a"] },
      });
      // Wiki page must exist on disk for resolveStaleRefresh to classify it as stale.
      await writeConceptPage(root, "topic-a", "Topic A", ["a.md"], "Old body.");
      // new.md on disk but NOT in state — refresh must skip it.
      await writeSourceFile(root, "new.md", "# New Topic\n\nBrand new.");

      const extractSpy = stubProviderCalls("Topic A");
      const result = await runRefresh(root);

      expect(result.pages).toContain("topic-a");
      const { state } = await readStateClassified(root);
      expect(state.sources["a.md"]?.hash).toBe(sha256Hex(aContent));
      expect("new.md" in state.sources).toBe(false);
      expect(result.pages).not.toContain("new-topic");
      // No page file for new.md landed on disk either (slug "new-topic" from "# New Topic").
      expect(existsSync(path.join(root, CONCEPTS_DIR, "new-topic.md"))).toBe(false);
      // Only a.md was extracted; new.md was filtered out by changeFilter.
      expect(extractSpy).toHaveBeenCalledTimes(1);
    } finally {
      vi.restoreAllMocks();
      delete process.env.LLMWIKI_PROVIDER;
      delete process.env.ANTHROPIC_API_KEY;
      await rm(root, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // Test 2: partial-deletion shared page — status repaired, content kept
  // -------------------------------------------------------------------------

  it("status-repairs a partial-deletion shared page but does NOT regenerate its content (v1)", async () => {
    process.env.LLMWIKI_PROVIDER = "anthropic";
    process.env.ANTHROPIC_API_KEY = "test-key";
    const root = await makeTmpRoot("shared-kept");

    try {
      const aContent = "# Topic X\n\nAbout X from A.";
      await writeSourceFile(root, "a.md", aContent);
      // b.md intentionally absent from disk — it's the deleted owner.
      await writeSourceState(root, {
        "a.md": { hash: sha256Hex(aContent), concepts: ["topic-x"] },
        "b.md": { hash: "some-old-hash", concepts: ["topic-x"] },
      });
      await writeConceptPage(root, "topic-x", "Topic X", ["a.md", "b.md"], "Existing body of X.");
      const originalContent = await readFile(path.join(root, CONCEPTS_DIR, "topic-x.md"), "utf-8");

      // Spy: extraction must NOT fire (a.md is unchanged; no changed owners).
      const extractSpy = stubProviderCalls("Topic X");
      vi.spyOn(console, "log").mockImplementation(() => {});

      const { plan } = await resolveStaleRefresh(root);
      expect(plan).not.toBeNull();
      // Sanity: page is shared-kept, not recompiled.
      expect(plan!.sharedKeptPages).toContain("topic-x");
      expect(plan!.changedOwners).not.toContain("a.md");
      expect(plan!.deletedOwners).toContain("b.md");

      await compileAndReport(root, { changeFilter: plan!.changeFilter, skipSeedPages: true });

      // Deletion bookkeeping: b.md removed from state.
      const { state } = await readStateClassified(root);
      expect("b.md" in state.sources).toBe(false);
      // Content kept: topic-x.md byte-for-byte UNCHANGED.
      const afterContent = await readFile(path.join(root, CONCEPTS_DIR, "topic-x.md"), "utf-8");
      expect(afterContent).toBe(originalContent);
      // a.md NOT extracted — unchanged live owner skipped in v1.
      expect(extractSpy).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
      delete process.env.LLMWIKI_PROVIDER;
      delete process.env.ANTHROPIC_API_KEY;
      await rm(root, { recursive: true, force: true });
    }
  });
});
