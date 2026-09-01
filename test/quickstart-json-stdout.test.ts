/**
 * CLI regressions for invalid quickstart concurrency diagnostics.
 *
 * These subprocess tests exercise the built user-facing entry point with the
 * documented quickstart arguments. Machine mode must reserve stdout for one
 * JSON envelope while keeping the warning visible on stderr; human mode keeps
 * the historical yellow status line on stdout.
 */

import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { runCLI, expectCLIExit, type CLIResult } from "./fixtures/run-cli.js";
import { stripAnsi } from "./fixtures/cli-runner.js";

const INVALID_WARNING = (value: string): string =>
  `--concurrency value "${value}" is not a positive integer; ignoring it.`;
const quickstartRoots: string[] = [];

/** Run quickstart against a real Markdown source without calling a provider. */
async function runInvalidConcurrency(jsonMode: boolean, value = "eight"): Promise<CLIResult> {
  const cwd = await mkdtemp(path.join(tmpdir(), "llmwiki-quickstart-json-"));
  quickstartRoots.push(cwd);
  await writeFile(path.join(cwd, "source.md"), "# Source\n\nRegression witness.\n", "utf-8");
  const args = jsonMode
    ? ["quickstart", "source.md", "--json", "--no-open", "--concurrency", value]
    : ["quickstart", "source.md", "--no-open", "--concurrency", "eight"];
  return runCLI(args, cwd, {
    LLMWIKI_PROVIDER: "anthropic",
    LLMWIKI_COMPILE_CONCURRENCY: "",
    ANTHROPIC_API_KEY: "",
    ANTHROPIC_AUTH_TOKEN: "",
    LLMWIKI_CLAUDE_SETTINGS_PATH: "/path/does/not/exist.json",
  });
}

afterEach(async () => {
  await Promise.all(quickstartRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("quickstart invalid --concurrency diagnostics", () => {
  it.each(["eight", "0", "2.5", "-1"])(
    "keeps --json stdout as one envelope and writes the warning to stderr for %s",
    async (value) => {
      const result = await runInvalidConcurrency(true, value);
      expectCLIExit(result, 0);
      const envelope = JSON.parse(result.stdout) as Record<string, unknown>;
      expect(Object.keys(envelope)).toEqual(["version", "source", "ingest", "compile", "viewer", "next"]);
      expect(result.stdout).not.toContain("--concurrency");
      expect(stripAnsi(result.stderr).trim()).toBe(`! ${INVALID_WARNING(value)}`);
    },
  );

  it("keeps the yellow status warning on stdout without --json", async () => {
    const result = await runInvalidConcurrency(false);
    expectCLIExit(result, 0);
    expect(result.stdout).toContain(`! \x1b[33m${INVALID_WARNING("eight")}\x1b[0m`);
    expect(result.stderr).not.toContain("--concurrency");
  });
});
