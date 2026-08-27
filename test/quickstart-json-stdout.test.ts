/**
 * @file test/quickstart-json-stdout.test.ts
 * @description `quickstart --json` must put nothing but its envelope on stdout.
 *
 * `--concurrency` is parsed while the CLI assembles quickstartCommand's
 * arguments, which happens BEFORE the command body can enable quiet mode. A
 * diagnostic emitted from there escapes quiet mode entirely, and on stdout it
 * lands ahead of the JSON envelope. The command still exits 0, so an automated
 * caller reads a successful-looking stream that does not parse.
 *
 * The contract has two halves and both need pinning: stdout stays parseable,
 * and the diagnostic is still delivered. Dropping the warning would satisfy the
 * first half on its own, so an assertion for each is what keeps the pair honest.
 *
 * No credentials are needed. Quickstart ingests the local file, fails at the
 * provider, and reports that inside the envelope, which is exactly the shape an
 * automated caller has to be able to read.
 */

import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expectCLIExit, runCLI } from "./fixtures/run-cli.js";

/** A workspace holding one local source, enough for quickstart to reach compile. */
async function workspace(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "llmwiki-qs-json-"));
  await writeFile(path.join(dir, "src.md"), "# Topic\n\nProse about a topic.\n", "utf-8");
  return dir;
}

/**
 * Blank credentials so the run is hermetic rather than inheriting an ambient key, and blank
 * the two ambient knobs that could perturb the run: a developer's LLMWIKI_COMPILE_CONCURRENCY
 * would add its own resolution path, and a local Claude settings file could leak provider
 * configuration into the subprocess.
 */
const NO_CREDENTIALS = {
  LLMWIKI_PROVIDER: "anthropic",
  ANTHROPIC_API_KEY: "",
  ANTHROPIC_AUTH_TOKEN: "",
  LLMWIKI_COMPILE_CONCURRENCY: "",
  LLMWIKI_CLAUDE_SETTINGS_PATH: "/path/does/not/exist.json",
};

describe("quickstart --json and a rejected --concurrency value", () => {
  // One case per rejection branch of `!Number.isInteger(n) || n <= 0`: non-numeric,
  // zero, non-integer, negative.
  it.each(["eight", "0", "2.5", "-1"])(
    "puts only the envelope on stdout, exits 0, and still reports %s",
    async (invalidValue) => {
      const cwd = await workspace();
      try {
        const result = await runCLI(
          ["quickstart", "src.md", "--json", "--no-open", "--concurrency", invalidValue],
          cwd,
          NO_CREDENTIALS,
        );

        // The defect was "exit 0 + unparseable stream"; pin BOTH coordinates —
        // runCLI never throws, so without this a nonzero-exit regression with an
        // intact envelope would pass.
        expectCLIExit(result, 0);

        // stdout is the data channel: it must parse whole, with nothing ahead of it.
        expect(result.stdout.trimStart().startsWith("{")).toBe(true);
        expect(JSON.parse(result.stdout).version).toBe(1);

        // and the diagnostic still reaches the operator, on the other channel.
        expect(result.stderr).toContain(`"${invalidValue}"`);
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    },
    60_000,
  );

  it("keeps the warning visible in human mode", async () => {
    const cwd = await workspace();
    try {
      const result = await runCLI(
        ["quickstart", "src.md", "--no-open", "--concurrency", "eight"],
        cwd,
        NO_CREDENTIALS,
      );

      expectCLIExit(result, 0);
      // Without --json the channel split is not the contract; visibility is.
      expect(`${result.stdout}\n${result.stderr}`).toContain('"eight"');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }, 60_000);
});
