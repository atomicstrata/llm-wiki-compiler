/**
 * @file test/reset-all-scopes-cli.test.ts
 * @description Every reset scope, through the BUILT binary: `raw`, `log`,
 * `checkpoints`, and `all` — the scopes the original journey never drove, so
 * "every scope previews its per-file plan and deletes exactly those files"
 * was measured for two scopes and assumed for the rest.
 *
 * EACH CASE PLANTS EVERY SCOPE'S FILES, then drives ONE scope end to end:
 * the preview names that scope's files and deletes nothing; `--yes` deletes
 * exactly the named files; every sibling scope's files survive byte-present.
 * The `all` case pins the union — a scope silently missing from `all` is how
 * "the option that claims to cover everything" comes to skip something.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runCLI } from "./fixtures/run-cli.js";
import { useFileProject } from "./fixtures/file-project.js";

const createProject = useFileProject("reset-scopes-");

/** One representative file per scope, relative to the project root. */
const SCOPE_FILES: Readonly<Record<string, string>> = {
  state: path.join(".llmwiki", "state.json"),
  wiki: path.join("wiki", "concepts", "alpha.md"),
  raw: path.join("raw", "paper.pdf"),
  log: "log.md",
  checkpoints: path.join(".llmwiki", "runs", "prr_1.json"),
};

/** A project holding EVERY scope's files, so survival is measurable per case. */
async function fullProject(): Promise<string> {
  return createProject(Object.fromEntries(Object.values(SCOPE_FILES).map(file => [file, "x"])));
}

/** The scopes whose files must SURVIVE a reset of `scope`. */
function siblings(scope: string): string[] {
  return Object.keys(SCOPE_FILES).filter((other) => other !== scope);
}

describe.each(["raw", "log", "checkpoints"] as const)("state reset --scope %s", (scope) => {
  it("previews the plan without deleting, then deletes EXACTLY that scope on --yes", async () => {
    const root = await fullProject();
    const preview = await runCLI(["state", "reset", "--scope", scope], root);
    expect(preview.stdout).toContain(SCOPE_FILES[scope]!);
    expect(existsSync(path.join(root, SCOPE_FILES[scope]!)), "preview deleted").toBe(true);
    const applied = await runCLI(["state", "reset", "--scope", scope, "--yes"], root);
    expect(applied.code, applied.stdout + applied.stderr).toBe(0);
    // The summary is EXACT: the reported count is what was actually unlinked.
    // A false "Deleted 999 file(s)" previously survived both reset suites.
    expect(applied.stdout).toContain("Deleted 1 file(s)");
    expect(existsSync(path.join(root, SCOPE_FILES[scope]!)), "scope file survived --yes").toBe(false);
    for (const other of siblings(scope)) {
      expect(existsSync(path.join(root, SCOPE_FILES[other]!)), `${other} was deleted by ${scope}`).toBe(true);
    }
  }, 60_000);
});

describe("state reset --scope all", () => {
  it("previews the UNION of every scope, and --yes deletes all of it", async () => {
    const root = await fullProject();
    const preview = await runCLI(["state", "reset", "--scope", "all"], root);
    for (const file of Object.values(SCOPE_FILES)) {
      expect(preview.stdout, `plan omits ${file}`).toContain(file);
      expect(existsSync(path.join(root, file)), "preview deleted").toBe(true);
    }
    const applied = await runCLI(["state", "reset", "--scope", "all", "--yes"], root);
    expect(applied.code, applied.stdout + applied.stderr).toBe(0);
    expect(applied.stdout).toContain(`Deleted ${Object.keys(SCOPE_FILES).length} file(s)`);
    for (const file of Object.values(SCOPE_FILES)) {
      expect(existsSync(path.join(root, file)), `${file} survived --scope all --yes`).toBe(false);
    }
  }, 60_000);
});
