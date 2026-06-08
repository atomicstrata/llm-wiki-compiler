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
import { readFile } from "fs/promises";
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

describe("llmwiki refresh --stale (live, cleanup-only)", () => {
  it("cleans up a deleted-owner page with no provider key and makes no LLM calls", async () => {
    const root = await makeTempRoot("refresh-cleanup");
    await writeConceptPage(root, "topic");
    // a.md is recorded in state but absent on disk → its exclusively-owned page
    // is orphaned cleanup only, never a recompile, so the LLM is never invoked.
    await writeSourceState(root, { "a.md": { hash: sha256Hex("gone"), concepts: ["topic"] } });

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
});
