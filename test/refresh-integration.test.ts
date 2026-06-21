/**
 * Real-run integration tests for `llmwiki refresh --stale`.
 *
 * Exercises the full in-process recompile path via `resolveStaleRefresh` +
 * `compileAndReport` with a stubbed AnthropicProvider (same convention as
 * compile-delta.test.ts). Proves four guarantees of the implementation:
 *
 *  1. A stale page (changed source hash) IS recompiled.
 *  2. A new source (not in state) is skipped — refresh does not compile new sources.
 *  3. A partial-deletion "shared" page has its state REPAIRED (deleted owner
 *     removed from state.sources) but its content byte-for-byte UNCHANGED — the
 *     unchanged live owner is NOT recompiled (v1 limitation: no force-rebuild).
 *  4. When a review policy is active, a refreshed page that trips policy is held
 *     as a candidate (not written to wiki/) and the command reports it as held,
 *     NOT as "refreshed".
 */

import { describe, it, expect, vi } from "vitest";
import { mkdir, writeFile, readFile, rm } from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import { compileAndReport } from "../src/compiler/index.js";
import { resolveStaleRefresh } from "../src/compiler/refresh-plan.js";
import refreshCommand from "../src/commands/refresh.js";
import { listCandidates } from "../src/compiler/candidates.js";
import { AnthropicProvider } from "../src/providers/anthropic.js";
import { readStateClassified } from "../src/utils/state.js";
import { CONCEPTS_DIR } from "../src/utils/constants.js";
import { makeCompileProjectRoot } from "./fixtures/compile-project.js";
import { trackToolCallConcurrency } from "./fixtures/concurrency-probe.js";
import { writeSourceState, writeSourceFile, sha256Hex } from "./fixtures/state-json.js";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Minimal extraction JSON for one concept, optionally with confidence. */
function extractionFor(title: string, confidence?: number): string {
  const concept: Record<string, unknown> = { concept: title, summary: `Summary of ${title}.`, is_new: true };
  if (confidence !== undefined) concept.confidence = confidence;
  return JSON.stringify({ concepts: [concept] });
}

const STUB_BODY = "Stub body content. ^[a.md]";

/** Write a low-confidence policy config to .llmwiki/config.json. */
async function writeLowConfidencePolicy(root: string): Promise<void> {
  await mkdir(path.join(root, ".llmwiki"), { recursive: true });
  await writeFile(
    path.join(root, ".llmwiki", "config.json"),
    JSON.stringify({ version: 1, review: { hold: ["low-confidence"], lowConfidenceThreshold: 0.5 } }),
    "utf-8",
  );
}

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
function stubProviderCalls(extractionTitle: string, confidence?: number) {
  const spy = vi.spyOn(AnthropicProvider.prototype, "toolCall")
    .mockResolvedValue(extractionFor(extractionTitle, confidence));
  vi.spyOn(AnthropicProvider.prototype, "complete").mockResolvedValue(STUB_BODY);
  return spy;
}

/**
 * Seed a stale topic-a project: a.md in sources with a stale state hash,
 * and an existing wiki page with "Old body.". Returns the actual a.md content.
 */
async function setupStaleTopicA(root: string): Promise<string> {
  const aContent = "# Topic A\n\nAbout A.";
  await writeSourceFile(root, "a.md", aContent);
  await writeSourceState(root, {
    "a.md": { hash: "stale-hash-not-matching-disk", concepts: ["topic-a"] },
  });
  await writeConceptPage(root, "topic-a", "Topic A", ["a.md"], "Old body.");
  return aContent;
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
      const aContent = await setupStaleTopicA(root);
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

  // -------------------------------------------------------------------------
  // Test 4: refresh + review policy — held pages reported as held, not refreshed
  // -------------------------------------------------------------------------

  it("reports a policy-held page as held for review, not as refreshed", async () => {
    process.env.LLMWIKI_PROVIDER = "anthropic";
    process.env.ANTHROPIC_API_KEY = "test-key";
    const root = await makeTmpRoot("policy-held");

    try {
      await setupStaleTopicA(root);
      // Low-confidence extraction triggers policy hold.
      await writeLowConfidencePolicy(root);
      stubProviderCalls("Topic A", 0.1);

      const logLines: string[] = [];
      vi.spyOn(console, "log").mockImplementation((...args) => {
        logLines.push(args.join(" "));
      });

      // refreshCommand reads process.cwd() — chdir into the temp root.
      const savedCwd = process.cwd();
      process.chdir(root);
      let exitCode: number;
      try {
        exitCode = await refreshCommand(
          { stale: true },
          () => { /* provider already set via env */ },
        );
      } finally {
        process.chdir(savedCwd);
      }

      expect(exitCode).toBe(0);
      // (a) page held as candidate — NOT overwritten in wiki/ (old body preserved)
      const candidates = await listCandidates(root);
      expect(candidates.some((c) => c.slug === "topic-a")).toBe(true);
      const livePageContent = await readFile(path.join(root, CONCEPTS_DIR, "topic-a.md"), "utf-8");
      expect(livePageContent).toContain("Old body.");
      // (b) output says "held for review", does NOT claim "Refreshed N page(s)"
      const allOutput = logLines.join("\n");
      expect(allOutput).toMatch(/held.*for review/i);
      expect(allOutput).not.toMatch(/Refreshed \d+ page\(s\)/);
    } finally {
      vi.restoreAllMocks();
      delete process.env.LLMWIKI_PROVIDER;
      delete process.env.ANTHROPIC_API_KEY;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("forwards the concurrency option into the recompile (serial cap keeps peak at 1)", async () => {
    process.env.LLMWIKI_PROVIDER = "anthropic";
    process.env.ANTHROPIC_API_KEY = "test-key";
    delete process.env.LLMWIKI_COMPILE_CONCURRENCY;
    const root = await makeTmpRoot("concurrency");
    try {
      await writeSourceFile(root, "a.md", "# A\n\nabout a");
      await writeSourceFile(root, "b.md", "# B\n\nabout b");
      await writeSourceState(root, {
        "a.md": { hash: "stale-a", concepts: ["topic-a"] },
        "b.md": { hash: "stale-b", concepts: ["topic-b"] },
      });
      await writeConceptPage(root, "topic-a", "Topic A", ["a.md"], "Old A.");
      await writeConceptPage(root, "topic-b", "Topic B", ["b.md"], "Old B.");

      const peak = trackToolCallConcurrency((n) => extractionFor(`Topic ${n}`));
      vi.spyOn(AnthropicProvider.prototype, "complete").mockResolvedValue(STUB_BODY);
      vi.spyOn(console, "log").mockImplementation(() => {});

      // refreshCommand reads process.cwd() — chdir into the temp root.
      const savedCwd = process.cwd();
      process.chdir(root);
      try {
        await refreshCommand({ stale: true, concurrency: 1 }, () => {});
      } finally {
        process.chdir(savedCwd);
      }

      // Without forwarding, refresh falls back to the default cap (5) and the two
      // stale extractions overlap (peak 2). The flag must serialize them to peak 1.
      expect(peak()).toBe(1);
    } finally {
      vi.restoreAllMocks();
      delete process.env.LLMWIKI_PROVIDER;
      delete process.env.ANTHROPIC_API_KEY;
      await rm(root, { recursive: true, force: true });
    }
  });
});
