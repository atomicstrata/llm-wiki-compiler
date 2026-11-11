/**
 * The CLI declares every top-level command from a table and loads a command's
 * module only when that command is dispatched. These cases cover the paths
 * that reach a command without running it, where a missing load would print
 * the bare declaration: no options and no subcommands.
 */
import { describe, expect, it } from "bun:test";
import { expectCLIExit, expectCLIFailure, runCLI } from "./fixtures/run-cli.js";

describe("CLI command loading", () => {
  it.each(["compile", "review", "eval"])("prints the same help for `help %s` as for `%s --help`", async (name) => {
    const viaHelpCommand = await runCLI(["help", name], process.cwd());
    const viaFlag = await runCLI([name, "--help"], process.cwd());
    expectCLIExit(viaHelpCommand, 0);
    expect(viaHelpCommand.stdout).toBe(viaFlag.stdout);
  });

  it("shows a leaf command's options and a group's subcommands", async () => {
    expect((await runCLI(["help", "compile"], process.cwd())).stdout).toContain("--concurrency <n>");
    expect((await runCLI(["help", "review"], process.cwd())).stdout).toContain("approve-batch");
  });

  it("fails with the command list when asked for help on an unknown command", async () => {
    const result = await runCLI(["help", "no-such-command"], process.cwd());
    expectCLIFailure(result);
    expect(result.stderr).toContain("Usage: llmwiki [options] [command]");
  });
});
