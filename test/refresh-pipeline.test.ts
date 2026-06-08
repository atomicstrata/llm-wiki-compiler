/**
 * Tests for the `changeFilter` and `skipSeedPages` CompileOptions introduced
 * for `refresh --stale`.
 *
 * (A) `changeFilter` — verifies the option scopes the compile run to a subset
 *     of detected source changes AND that affected-source expansion still pulls
 *     in co-contributors of shared concepts from the filtered set.
 *
 * (B) `skipSeedPages` — verifies that schema-declared seed pages are NOT
 *     written to disk when the flag is set, while a control run without the
 *     flag DOES write them.
 *
 * Strategy mirrors compile-provenance.test.ts: stub AnthropicProvider so
 * extraction / page-generation calls are deterministic and no real API is hit.
 */

import { describe, it, expect, vi } from "vitest";
import { writeFile, mkdir } from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import { compileAndReport } from "../src/compiler/index.js";
import type { CompileOptions } from "../src/utils/types.js";
import { AnthropicProvider } from "../src/providers/anthropic.js";
import { useCompileProject } from "./fixtures/compile-project.js";
import { writeSourceState, sha256Hex } from "./fixtures/state-json.js";
import { CONCEPTS_DIR } from "../src/utils/constants.js";

// ---------------------------------------------------------------------------
// Shared stub helpers
// ---------------------------------------------------------------------------

/** Minimal extraction JSON for a single concept with the given title. */
function extractionFor(title: string): string {
  return JSON.stringify({
    concepts: [{ concept: title, summary: `Summary of ${title}.`, is_new: true }],
  });
}

const STUB_BODY = "Body content. ^[a.md]";

/**
 * Stub AnthropicProvider so toolCall returns an extraction keyed on which
 * source the system prompt mentions, and complete() returns a fixed body.
 * Routes by sniffing the system-prompt string for each source's title.
 */
function stubProviderFor(titlesBySource: Record<string, string>): void {
  vi.spyOn(AnthropicProvider.prototype, "toolCall").mockImplementation(
    async (system: string) => {
      for (const [, title] of Object.entries(titlesBySource)) {
        if (system.includes(title)) return extractionFor(title);
      }
      // Default: return the first entry's extraction.
      const firstTitle = Object.values(titlesBySource)[0] ?? "Default";
      return extractionFor(firstTitle);
    },
  );
  vi.spyOn(AnthropicProvider.prototype, "complete").mockResolvedValue(STUB_BODY);
}

// ---------------------------------------------------------------------------
// (A) changeFilter
// ---------------------------------------------------------------------------

/**
 * Silence console output and run compileAndReport scoped to a single file.
 * Both changeFilter tests share this setup: filter to "a.md", suppress output,
 * return the CompileResult for assertion.
 */
async function runFilteredToA(root: string) {
  vi.spyOn(console, "log").mockImplementation(() => {});
  return compileAndReport(root, { changeFilter: (c) => c.file === "a.md" });
}

describe("changeFilter scopes the run", () => {
  const ctx = useCompileProject({
    dirSuffix: "filter-drop",
    sourceFile: "a.md",
    sourceContent: "# Topic A\n\nAbout A.",
  });

  it("drops an unrelated changed source", async () => {
    // Add a second independent source so detectChanges sees two "new" entries.
    await writeFile(
      path.join(ctx.dir, "sources", "c.md"),
      "# Topic C\n\nAbout C.",
      "utf-8",
    );
    stubProviderFor({ "a.md": "Topic A", "c.md": "Topic C" });

    const result = await runFilteredToA(ctx.dir);

    expect(result.pages).toContain("topic-a");
    expect(result.pages).not.toContain("topic-c");
  });

  it("still pulls a co-contributor in via affected expansion after filtering", async () => {
    // a.md is "changed": its on-disk content hashes differently from what
    // state records. b.md is "unchanged": its recorded hash matches on-disk.
    // Both share concept "x" in state, so findAffectedSources will pull b.md
    // in when only a.md passes the changeFilter.
    const aContent = "# Topic A\n\nAbout A.";
    const bContent = "# Topic B\n\nAbout B.";

    // Overwrite a.md (fixture already created it) with known content.
    await writeFile(path.join(ctx.dir, "sources", "a.md"), aContent, "utf-8");
    await writeFile(path.join(ctx.dir, "sources", "b.md"), bContent, "utf-8");

    // Write a concept page for the shared concept so the wiki dir is not empty.
    await mkdir(path.join(ctx.dir, CONCEPTS_DIR), { recursive: true });
    await writeFile(
      path.join(ctx.dir, CONCEPTS_DIR, "topic-x.md"),
      "---\ntitle: Topic X\nsummary: x.\nsources: []\ncreatedAt: t\nupdatedAt: t\n---\n\nX content.",
      "utf-8",
    );

    // Seed state: a.md hash is intentionally wrong ("stale") → "changed".
    // b.md hash matches on-disk content exactly → "unchanged".
    // Both share concept slug "topic-x".
    await writeSourceState(ctx.dir, {
      "a.md": { hash: "stale-hash-differs-from-disk", concepts: ["topic-x"] },
      "b.md": { hash: sha256Hex(bContent), concepts: ["topic-x"] },
    });

    // Stub extraction: every source produces "Topic X". toolCall is the
    // EXTRACTION call (once per source); its system prompt embeds the source
    // content, so we can detect which source it ran for. complete() is the
    // page-BODY call (once per page) and would pass even without b.md, so the
    // co-contributor assertion must hinge on toolCall instead.
    const extractSpy = vi.spyOn(AnthropicProvider.prototype, "toolCall")
      .mockImplementation(async (_system: string) => extractionFor("Topic X"));
    vi.spyOn(AnthropicProvider.prototype, "complete").mockResolvedValue(STUB_BODY);

    const result = await runFilteredToA(ctx.dir);

    // The shared concept page must be produced.
    expect(result.pages).toContain("topic-x");
    // Affected-source expansion must pull b.md in: extraction runs once per
    // source, so exactly two extraction calls (a.md + the b.md co-contributor)
    // prove b.md was processed. This goes red if augmentWithAffectedSources is
    // disabled (only a.md would be extracted).
    expect(extractSpy).toHaveBeenCalledTimes(2);
    const extractedBContent = extractSpy.mock.calls.some(
      ([system]) => typeof system === "string" && system.includes("About B."),
    );
    expect(extractedBContent).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// (B) skipSeedPages
// ---------------------------------------------------------------------------

describe("skipSeedPages suppresses seed-page writes", () => {
  const SEED_TITLE = "Overview Page";
  const SEED_SLUG = "overview-page";

  const ctx = useCompileProject({
    dirSuffix: "skip-seed",
    sourceFile: "a.md",
    sourceContent: "# Topic A\n\nAbout A.",
  });

  /** Write a schema.json with one overview seed page under .llmwiki/. */
  async function writeSeedSchema(root: string): Promise<void> {
    await mkdir(path.join(root, ".llmwiki"), { recursive: true });
    const schema = {
      version: 1,
      defaultKind: "concept",
      kinds: {},
      seedPages: [
        { title: SEED_TITLE, kind: "overview", summary: "A top-level overview." },
      ],
    };
    await writeFile(
      path.join(root, ".llmwiki", "schema.json"),
      JSON.stringify(schema),
      "utf-8",
    );
  }

  /** Set up the seed-schema project, stub the LLM, and run compileAndReport. */
  async function runSeedCompile(root: string, options: CompileOptions = {}): Promise<string> {
    await writeSeedSchema(root);
    stubProviderFor({ "a.md": "Topic A" });
    vi.spyOn(console, "log").mockImplementation(() => {});
    await compileAndReport(root, options);
    return path.join(root, CONCEPTS_DIR, `${SEED_SLUG}.md`);
  }

  it("does not write the seed page when skipSeedPages is true", async () => {
    const seedPath = await runSeedCompile(ctx.dir, { skipSeedPages: true });
    expect(existsSync(seedPath)).toBe(false);
  });

  it("does write the seed page in a control run without skipSeedPages", async () => {
    const seedPath = await runSeedCompile(ctx.dir);
    expect(existsSync(seedPath)).toBe(true);
  });
});
