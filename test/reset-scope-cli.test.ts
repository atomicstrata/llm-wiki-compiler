/**
 * @file test/reset-scope-cli.test.ts
 * @description `llmwiki state reset --scope <scope>` through the BUILT binary.
 *
 * WHY THIS RUNS THE REAL CLI. The scope option was once accepted and silently
 * ignored: `--scope wiki --yes` fell through to the state reset and backed up
 * and removed `state.json` while reporting success. Every unit test passed and
 * the type-checker was happy, because the defect lived in the wiring between
 * the flag and the function. Only driving the actual binary catches that class,
 * and destroying something the operator did not name — while telling them it
 * worked — is the worst failure this surface has.
 *
 * Every OTHER scope's own preview-and-delete journey lives in
 * `reset-all-scopes-cli.test.ts`; this file holds the wiki and state scopes,
 * the unknown-scope refusal, and the lock refusal.
 */

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runCLI } from "./fixtures/run-cli.js";
import { useFileProject } from "./fixtures/file-project.js";

const createProject = useFileProject("reset-cli-");

/** A project holding one wiki page and a state file. */
async function project(): Promise<string> {
  return createProject({ "wiki/concepts/alpha.md": "a", ".llmwiki/state.json": "{}" });
}

describe("state reset --scope", () => {
  it("NAMES every file the scope would delete, and deletes none", async () => {
    const root = await project();
    const result = await runCLI(["state", "reset", "--scope", "wiki"], root);
    expect(result.stdout).toContain(path.join("wiki", "concepts", "alpha.md"));
    expect(existsSync(path.join(root, "wiki", "concepts", "alpha.md"))).toBe(true);
  }, 60_000);

  it("DELETES the named scope on --yes, and only that scope", async () => {
    const root = await project();
    const result = await runCLI(["state", "reset", "--scope", "wiki", "--yes"], root);
    expect(result.code).toBe(0);
    expect(existsSync(path.join(root, "wiki", "concepts", "alpha.md"))).toBe(false);
    // The regression that motivated this suite: the state file must survive a
    // request that never mentioned it.
    expect(await readFile(path.join(root, ".llmwiki", "state.json"), "utf8")).toBe("{}");
    expect(existsSync(path.join(root, ".llmwiki", "state.json.bak"))).toBe(false);
  }, 60_000);

  it("names every file it is about to delete, even on the confirmed path", async () => {
    // §4.8 pins that the preview comes BEFORE destruction. An operator who
    // passed --yes from memory still needs the list in their scrollback.
    const root = await project();
    const result = await runCLI(["state", "reset", "--scope", "wiki", "--yes"], root);
    expect(result.stdout).toContain(path.join("wiki", "concepts", "alpha.md"));
  }, 60_000);

  it("refuses an unknown scope rather than defaulting to state", async () => {
    const root = await project();
    const result = await runCLI(["state", "reset", "--scope", "everything", "--yes"], root);
    expect(result.code).not.toBe(0);
    expect(existsSync(path.join(root, ".llmwiki", "state.json.bak"))).toBe(false);
    // And it destroyed nothing while refusing.
    expect(existsSync(path.join(root, "wiki", "concepts", "alpha.md"))).toBe(true);
  }, 60_000);

  it("still applies the STATE scope, which is the one it executes", async () => {
    const root = await project();
    const result = await runCLI(["state", "reset", "--yes"], root);
    expect(result.code).toBe(0);
    expect(existsSync(path.join(root, ".llmwiki", "state.json.bak"))).toBe(true);
  }, 60_000);
});

describe("the destructive path takes the project lock", () => {
  it("REFUSES while another process holds it, and destroys nothing", async () => {
    // The lock is a claimed safety property, so it gets a control: a concurrent
    // compile writing pages while a reset removes them would leave a tree
    // neither one intended. Refusing must also be non-zero, so a caller never
    // reads success when nothing was reset.
    const root = await project();
    const { acquireMutationLock } = await import("../src/operation-bundles/lock-gate.js");
    const { releaseLock } = await import("../src/utils/lock.js");
    expect(await acquireMutationLock(root, "ordinary")).toBe(true);
    try {
      const result = await runCLI(["state", "reset", "--scope", "wiki", "--yes"], root);
      expect(result.code).not.toBe(0);
      expect(existsSync(path.join(root, "wiki", "concepts", "alpha.md"))).toBe(true);
    } finally {
      await releaseLock(root);
    }
  }, 60_000);
});
