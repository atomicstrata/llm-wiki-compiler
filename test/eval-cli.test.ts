/**
 * Subprocess smoke test for the `eval` command tree.
 *
 * All other eval-*.test.ts files exercise src/commands/eval.ts and
 * src/eval/* in-process — none of them drive Commander's actual `eval`
 * registration through the compiled CLI binary. That leaves a gap: a
 * wiring bug in how `eval` (and its `cache`/`report`/`history`/`judgements`
 * subcommands) gets registered on `program` could ship green. This file is
 * the regression oracle for that registration — it must stay green across
 * the src/cli.ts → src/cli/eval-commands.ts extraction.
 */

import { describe, it, expect } from "vitest";
import path from "path";
import { mkdir, rm } from "fs/promises";
import { tmpdir } from "os";
import { runCLI, expectCLIExit } from "./fixtures/run-cli.js";

/** Create a fresh temporary project directory with a sources/ sub-folder. */
async function makeTempProject(label: string): Promise<string> {
  const dir = path.join(tmpdir(), `llmwiki-eval-cli-${label}-${Date.now()}`);
  await mkdir(path.join(dir, "sources"), { recursive: true });
  return dir;
}

describe("eval CLI subprocess smoke test", () => {
  it("eval --help lists the cache/report/history/judgements subcommands", async () => {
    const result = await runCLI(["eval", "--help"], process.cwd());
    expectCLIExit(result, 0);
    expect(result.stdout).toContain("Evaluate wiki quality");
    expect(result.stdout).toContain("cache");
    expect(result.stdout).toContain("report");
    expect(result.stdout).toContain("history");
    expect(result.stdout).toContain("judgements");
  });

  it("eval cache show runs end-to-end on a fresh project with no cache", async () => {
    const cwd = await makeTempProject("cache-show");
    try {
      const result = await runCLI(["eval", "cache", "show"], cwd);
      expectCLIExit(result, 0);
      expect(result.stdout).toContain("Citation Cache");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("eval report runs end-to-end on a fresh project with no history", async () => {
    const cwd = await makeTempProject("report");
    try {
      const result = await runCLI(["eval", "report"], cwd);
      expectCLIExit(result, 0);
      expect(result.stdout).toContain("No eval history found");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
