/**
 * End-to-end subprocess test: real `llmwiki lint` writes freshness counts that
 * real `llmwiki next` then surfaces.
 *
 * Prior tests covered each half in isolation — in-process unit tests for
 * `writeLintCache`, and subprocess `next --json` tests with a hand-seeded cache.
 * This file closes the seam: no hand-seeding, no LLM/compile. Both commands run
 * as real subprocesses; the chain must carry freshness end-to-end on its own.
 */

import { describe, it, expect } from "vitest";
import { mkdir, writeFile } from "fs/promises";
import path from "path";
import { runCLI } from "./fixtures/run-cli.js";
import { useNextTempDir } from "./fixtures/next-test-helpers.js";
import { sha256Hex, writeSourceState } from "./fixtures/state-json.js";
import { CONCEPTS_DIR, SOURCES_DIR } from "../src/utils/constants.js";

const env = useNextTempDir("freshness-e2e");

/** Build a fixture where a.md's on-disk content differs from the recorded hash. */
async function buildStaleFixture(root: string): Promise<void> {
  // Concept page with required frontmatter so lint schema rules pass.
  const conceptDir = path.join(root, CONCEPTS_DIR);
  await mkdir(conceptDir, { recursive: true });
  const frontmatter = `---\ntitle: "Topic"\nsummary: "A topic page."\n---\n\nBody text here.\n`;
  await writeFile(path.join(conceptDir, "topic.md"), frontmatter);

  // Source on disk contains "NEW body" but state records hash of "OLD body".
  await mkdir(path.join(root, SOURCES_DIR), { recursive: true });
  await writeFile(path.join(root, SOURCES_DIR, "a.md"), "NEW body");
  await writeSourceState(root, { "a.md": { hash: sha256Hex("OLD body"), concepts: ["topic"] } });
}

describe("lint → next end-to-end freshness chain (no hand-seeded cache)", () => {
  it("real lint persists stalePages=1 and real next surfaces it", async () => {
    await buildStaleFixture(env.dir);

    // Step 1: run real lint — this writes .llmwiki/last-lint.json with freshness.
    const lint = await runCLI(["lint"], env.dir);
    // Stale pages emit warnings (not errors), so lint must exit 0.
    expect(lint.code, `lint failed:\n${lint.stderr}`).toBe(0);

    // Step 2: run real next --json — reads the cache lint just wrote.
    const next = await runCLI(["next", "--json"], env.dir);
    expect(next.code, `next failed:\n${next.stderr}`).toBe(0);

    const payload = JSON.parse(next.stdout) as Record<string, unknown>;
    const summary = payload.summary as Record<string, unknown>;

    // Freshness must come from the real lint run, not null.
    expect(summary.freshness, "freshness was null — lint did not write it or next did not read it")
      .not.toBeNull();
    expect((summary.freshness as Record<string, unknown>).stalePages).toBeGreaterThan(0);

    const warnings = payload.warnings as Array<Record<string, unknown>>;
    expect(warnings.some((w) => w.code === "stale-pages")).toBe(true);
  });
});
