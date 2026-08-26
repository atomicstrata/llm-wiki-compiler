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
import { runCLI } from "./fixtures/run-cli.js";

/** A workspace holding one local source, enough for quickstart to reach compile. */
async function workspace(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "llmwiki-qs-json-"));
  await writeFile(path.join(dir, "src.md"), "# Topic\n\nProse about a topic.\n", "utf-8");
  return dir;
}

/** Blank credentials so the run is hermetic rather than inheriting an ambient key. */
const NO_CREDENTIALS = {
  LLMWIKI_PROVIDER: "anthropic",
  ANTHROPIC_API_KEY: "",
  ANTHROPIC_AUTH_TOKEN: "",
};

describe("quickstart --json and a rejected --concurrency value", () => {
  it("puts only the envelope on stdout, and still reports the rejected value", async () => {
    const cwd = await workspace();
    try {
      const result = await runCLI(
        ["quickstart", "src.md", "--json", "--no-open", "--concurrency", "eight"],
        cwd,
        NO_CREDENTIALS,
      );

      // stdout is the data channel: it must parse whole, with nothing ahead of it.
      expect(result.stdout.trimStart().startsWith("{")).toBe(true);
      expect(JSON.parse(result.stdout).version).toBe(1);

      // and the diagnostic still reaches the operator, on the other channel.
      expect(result.stderr).toContain('"eight"');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }, 60_000);
});
