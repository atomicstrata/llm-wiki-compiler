/**
 * Subprocess integration tests for `llmwiki context`.
 *
 * Runs the compiled CLI binary end-to-end via `runCLI`, so the v1 JSON
 * contract, exit codes, ANSI hygiene, and the `--omit-root` flag are
 * pinned at the same surface real users (and agents) see. No provider
 * credentials are required — Slice 1 is lexical-only.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import os from "os";
import path from "path";
import { runCLI, expectCLIExit } from "./fixtures/run-cli.js";
import { CONCEPTS_DIR } from "../src/utils/constants.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), "context-cli-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

/** Seed one concept page so the lexical ranker has something to find. */
async function seedConcept(slug: string, title: string, body: string = ""): Promise<void> {
  await mkdir(path.join(tmpDir, CONCEPTS_DIR), { recursive: true });
  const content = `---\ntitle: ${title}\n---\n\n${body}\n`;
  await writeFile(path.join(tmpDir, CONCEPTS_DIR, `${slug}.md`), content, "utf-8");
}

/** Run `llmwiki context <prompt> [args...] --json`, assert exit 0, return parsed payload. */
async function runJsonContext(
  prompt: string,
  extra: string[] = [],
): Promise<Record<string, unknown>> {
  const result = await runCLI(["context", prompt, ...extra, "--json"], tmpDir);
  expectCLIExit(result, 0);
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

describe("`llmwiki context --json` — JSON envelope", () => {
  it("returns version 1 and stable top-level field set on an empty wiki", async () => {
    const payload = await runJsonContext("anything");
    expect(payload.version).toBe(1);
    expect(Object.keys(payload)).toEqual([
      "version",
      "prompt",
      "budget",
      "project",
      "primary",
      "neighbors",
      "warnings",
      "gaps",
      "suggestedActions",
    ]);
  });

  it("classifies a seeded page lexically and surfaces matchedIn-derived reasons", async () => {
    await seedConcept("retrieval", "Retrieval");
    const payload = await runJsonContext("retrieval");
    const primary = payload.primary as Array<Record<string, unknown>>;
    expect(primary.length).toBe(1);
    expect(primary[0].id).toBe("concepts/retrieval");
    const reasons = primary[0].reasons as string[];
    expect(reasons).toEqual(expect.arrayContaining(["title-match", "exact-slug", "exact-title"]));
  });

  it("emits no ANSI escape sequences in --json output", async () => {
    await seedConcept("alpha", "Alpha");
    const result = await runCLI(["context", "alpha", "--json"], tmpDir);
    expectCLIExit(result, 0);
    // eslint-disable-next-line no-control-regex
    expect(result.stdout).not.toMatch(/\x1b\[/);
  });

  it("places the recommendNextAction prefix in suggestedActions[0]", async () => {
    await seedConcept("hello", "Hello");
    const payload = await runJsonContext("hello");
    const actions = payload.suggestedActions as Array<Record<string, unknown>>;
    expect(actions.length).toBeGreaterThan(0);
    expect(actions[0].command).toBe("llmwiki view --open");
  });
});

describe("`llmwiki context --json --omit-root`", () => {
  it("sets project.root to null while keeping the field present", async () => {
    const payload = await runJsonContext("anything", ["--omit-root"]);
    const project = payload.project as Record<string, unknown>;
    expect(Object.keys(project)).toContain("root");
    expect(project.root).toBeNull();
  });
});

describe("`llmwiki context` — long prompt truncation", () => {
  it("truncates the echoed prompt and emits truncated-prompt warning", async () => {
    const longPrompt = "z".repeat(1100);
    const payload = await runJsonContext(longPrompt);
    expect((payload.prompt as string).length).toBe(1024);
    const warnings = payload.warnings as Array<Record<string, unknown>>;
    expect(warnings.map((w) => w.code)).toContain("truncated-prompt");
  });
});

describe("`llmwiki context` — markdown output", () => {
  it("renders a basic Context Pack markdown skeleton with primary and suggested actions", async () => {
    await seedConcept("alpha", "Alpha");
    const result = await runCLI(["context", "alpha"], tmpDir);
    expectCLIExit(result, 0);
    expect(result.stdout).toContain("# Context Pack");
    expect(result.stdout).toContain("## Primary Pages");
    expect(result.stdout).toContain("## Suggested Next Actions");
    expect(result.stdout).toContain("llmwiki view --open");
  });

  it("falls through to markdown when --format markdown is supplied explicitly", async () => {
    const result = await runCLI(["context", "x", "--format", "markdown"], tmpDir);
    expectCLIExit(result, 0);
    expect(result.stdout.startsWith("# Context Pack")).toBe(true);
  });

  it("--json wins over --format markdown when both are supplied", async () => {
    const result = await runCLI(["context", "x", "--format", "markdown", "--json"], tmpDir);
    expectCLIExit(result, 0);
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(parsed.version).toBe(1);
  });
});

describe("`llmwiki context` — defaults", () => {
  it("uses 8000 as the default budget when --budget is omitted", async () => {
    const payload = await runJsonContext("anything");
    const budget = payload.budget as Record<string, unknown>;
    expect(budget.requestedTokens).toBe(8000);
  });

  it("respects an explicit --budget override", async () => {
    const payload = await runJsonContext("anything", ["--budget", "1234"]);
    const budget = payload.budget as Record<string, unknown>;
    expect(budget.requestedTokens).toBe(1234);
  });
});
