/**
 * Subprocess tests for `llmwiki refresh --stale [--dry-run]`.
 *
 * Covers dry-run/no-work/error paths that must work with NO provider key and
 * make NO LLM calls. Each test asserts exit code, output strings, and — for
 * the dry-run case — a zero-writes contract (state.json + page content
 * unchanged, no .bak file created).
 *
 * Tests run against `dist/cli.js` with the Anthropic key/token stripped from the
 * environment, proving these dry-run / early-exit paths never invoke the
 * provider guard.
 */

import { describe, it, expect } from "vitest";
import { existsSync } from "fs";
import { mkdir, readFile, writeFile } from "fs/promises";
import path from "path";
import { runCLI, expectCLIExit } from "./fixtures/run-cli.js";
import { makeTempRoot } from "./fixtures/temp-root.js";
import {
  writeSourceFile,
  writeSourceState,
  sha256Hex,
  writeCorruptTestStateJson,
} from "./fixtures/state-json.js";
import { writePage } from "./fixtures/write-page.js";

/** Env with Anthropic credentials stripped — proves these paths never hit the provider guard. */
const NO_KEY_ENV = { ANTHROPIC_API_KEY: undefined, ANTHROPIC_AUTH_TOKEN: undefined };

/** Write a concept page with the minimal frontmatter the compiler expects. */
async function writeConceptPage(root: string, slug: string): Promise<void> {
  await writePage(
    path.join(root, "wiki/concepts"),
    slug,
    { title: "Topic", sources: ["a.md"], summary: "s", createdAt: "t" },
    "Body.",
  );
}

describe("llmwiki refresh --stale --dry-run", () => {
  it("previews the plan, makes no LLM calls, and writes nothing", async () => {
    const root = await makeTempRoot("refresh-dry");
    await writeConceptPage(root, "topic");
    await writeSourceFile(root, "a.md", "NEW body");
    await writeSourceFile(root, "new.md", "brand new");
    await writeSourceState(root, { "a.md": { hash: sha256Hex("OLD body"), concepts: ["topic"] } });

    const statePath = path.join(root, ".llmwiki/state.json");
    const pagePath = path.join(root, "wiki/concepts/topic.md");
    const stateBefore = await readFile(statePath, "utf-8");
    const pageBefore = await readFile(pagePath, "utf-8");

    const result = await runCLI(["refresh", "--stale", "--dry-run"], root, NO_KEY_ENV);

    expectCLIExit(result, 0);
    const combined = result.stdout + result.stderr;
    expect(combined).toMatch(/recompiled:\s+topic\b/);
    expect(combined).toMatch(/new sources skipped:.*new\.md/);
    expect(combined).toMatch(/no files changed, no LLM calls made/i);
    expect(await readFile(statePath, "utf-8")).toBe(stateBefore);
    expect(await readFile(pagePath, "utf-8")).toBe(pageBefore);
    expect(existsSync(path.join(root, ".llmwiki/state.json.bak"))).toBe(false);
  });

  it("nothing-stale exits 0 with the up-to-date message", async () => {
    const root = await makeTempRoot("refresh-clean");
    await writeConceptPage(root, "topic");
    await writeSourceFile(root, "a.md", "SAME");
    await writeSourceState(root, { "a.md": { hash: sha256Hex("SAME"), concepts: ["topic"] } });

    const result = await runCLI(["refresh", "--stale", "--dry-run"], root, NO_KEY_ENV);

    expectCLIExit(result, 0);
    expect(result.stdout + result.stderr).toMatch(/up to date — nothing to refresh/i);
  });

  it("corrupt state.json exits 1 with the unreadable message and writes no .bak", async () => {
    const root = await makeTempRoot("refresh-corrupt");
    await writeConceptPage(root, "topic");
    await writeCorruptTestStateJson(root);

    const result = await runCLI(["refresh", "--stale", "--dry-run"], root, NO_KEY_ENV);

    expectCLIExit(result, 1);
    expect(result.stdout + result.stderr).toMatch(/state\.json is unreadable/i);
    expect(existsSync(path.join(root, ".llmwiki/state.json.bak"))).toBe(false);
  });

  it("missing --stale prints usage and exits 1", async () => {
    const root = await makeTempRoot("refresh-nostale");

    const result = await runCLI(["refresh"], root, NO_KEY_ENV);

    expectCLIExit(result, 1);
    expect(result.stdout + result.stderr).toMatch(/usage: llmwiki refresh --stale/i);
  });
});

/**
 * Set up a cleanup-only stale project: a page whose sole owning source is in
 * state but deleted from disk → computedOrphaned, no recompile, no LLM.
 */
async function setupCleanupOnlyStale(label: string): Promise<string> {
  const root = await makeTempRoot(label);
  await writeConceptPage(root, "topic");
  await writeSourceState(root, { "a.md": { hash: sha256Hex("gone"), concepts: ["topic"] } });
  return root;
}

/** Hold the compile lock by writing a live PID, so the subprocess can't acquire it. */
async function holdLock(root: string, pid: number): Promise<void> {
  await mkdir(path.join(root, ".llmwiki"), { recursive: true });
  await writeFile(path.join(root, ".llmwiki/lock"), String(pid), "utf-8");
}

/** Write a minimal valid pending review candidate so countCandidates() sees one. */
async function writePendingCandidate(root: string): Promise<void> {
  const dir = path.join(root, ".llmwiki/candidates");
  await mkdir(dir, { recursive: true });
  const candidate = {
    id: "cand1", title: "Topic", slug: "topic", body: "Body.",
    sources: ["a.md"], generatedAt: "2026-01-01T00:00:00.000Z",
  };
  await writeFile(path.join(dir, "cand1.json"), JSON.stringify(candidate), "utf-8");
}

describe("llmwiki refresh --stale (live, cleanup-only)", () => {
  it("cleans up a deleted-owner page with no provider key and makes no LLM calls", async () => {
    const root = await setupCleanupOnlyStale("refresh-cleanup");

    const result = await runCLI(["refresh", "--stale"], root, NO_KEY_ENV);

    expectCLIExit(result, 0);
    const combined = result.stdout + result.stderr;
    expect(combined).not.toMatch(/anthropic|credentials|API[_ ]?KEY/i);
    expect(combined).toMatch(/cleaned up \(orphaned\):.*topic/);
    const state = JSON.parse(await readFile(path.join(root, ".llmwiki/state.json"), "utf-8"));
    expect(state.sources["a.md"]).toBeUndefined();
    const page = await readFile(path.join(root, "wiki/concepts/topic.md"), "utf-8");
    expect(page).toMatch(/^orphaned:\s*true/m);
  });

  it("exits non-zero and surfaces the error when the compile lock is held", async () => {
    const root = await setupCleanupOnlyStale("refresh-locked");
    // The test process is alive for the whole run, so its PID reads as a live
    // lock holder in the subprocess → acquireLock returns false → compile error.
    await holdLock(root, process.pid);

    const result = await runCLI(["refresh", "--stale"], root, NO_KEY_ENV);

    expectCLIExit(result, 1);
    expect(result.stdout + result.stderr).toMatch(/could not acquire .*lock/i);
  });

  it("warns about pending candidates and review policy when pending candidates exist", async () => {
    const root = await setupCleanupOnlyStale("refresh-bypass");
    await writePendingCandidate(root);

    const result = await runCLI(["refresh", "--stale"], root, NO_KEY_ENV);

    expectCLIExit(result, 0);
    expect(result.stdout + result.stderr).toMatch(/pending review candidate.*refresh respects the project review policy/i);
  });
});
