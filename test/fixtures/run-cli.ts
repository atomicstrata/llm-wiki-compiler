/**
 * Shared CLI subprocess helper for integration tests.
 *
 * Spawns the compiled CLI binary and captures full subprocess diagnostics
 * (code, signal, killed flag, error message, stdout, stderr) so test
 * failures can be diagnosed without rerunning.
 */

import { execFile } from "child_process";
import { promisify } from "util";
import { access } from "fs/promises";
import path from "path";
import { expect } from "vitest";

const exec = promisify(execFile);

/** Absolute path to the compiled CLI entry point. */
export const CLI = path.resolve("dist/cli.js");

/** Result shape returned by {@link runCLI}. */
export interface CLIResult {
  stdout: string;
  stderr: string;
  code: number;
  /** Signal that terminated the process (null if exit was via code). */
  signal: string | null;
  /** True when the process was killed (timeout, signal, etc). */
  killed: boolean;
  /** Error message from child_process when the spawn itself fails (ENOENT etc). */
  message: string | null;
  /** Original args for inclusion in assertion-failure messages. */
  args: string[];
  /** Working directory passed to the subprocess. */
  cwd: string;
}

/**
 * Format a CLIResult into a multi-line diagnostic string. Included in
 * assertion failure messages by {@link expectCLIExit} so CI logs capture
 * everything without rerunning.
 * @param result - The CLIResult to format.
 * @returns Multi-line diagnostic string.
 */
export function formatCLIFailure(result: CLIResult): string {
  return [
    `  args: ${JSON.stringify(result.args)}`,
    `  cwd: ${result.cwd}`,
    `  code: ${result.code}`,
    `  signal: ${result.signal}`,
    `  killed: ${result.killed}`,
    `  message: ${result.message}`,
    `  stdout: ${JSON.stringify(result.stdout.slice(0, 500))}`,
    `  stderr: ${JSON.stringify(result.stderr.slice(0, 500))}`,
  ].join("\n");
}

/**
 * Assert that a CLIResult exited with the expected code. On mismatch, the
 * assertion message includes the full subprocess diagnostics so CI logs
 * reveal what actually happened without needing to rerun.
 * @param result - The CLIResult to check.
 * @param expectedCode - Expected exit code (use 0 for success).
 */
export function expectCLIExit(result: CLIResult, expectedCode: number): void {
  expect(
    result.code,
    `CLI exited ${result.code}, expected ${expectedCode}:\n${formatCLIFailure(result)}`,
  ).toBe(expectedCode);
}

/**
 * Assert that a CLIResult exited with any non-zero code (i.e. failed).
 * Includes full subprocess diagnostics on mismatch.
 * @param result - The CLIResult to check.
 */
export function expectCLIFailure(result: CLIResult): void {
  expect(
    result.code,
    `CLI unexpectedly exited 0, expected non-zero:\n${formatCLIFailure(result)}`,
  ).not.toBe(0);
}

/**
 * Run the llmwiki CLI with the given arguments and return its output +
 * rich diagnostics. Never throws — non-zero exits, spawn errors, and
 * missing-cwd errors are all captured into the returned CLIResult.
 * @param args - CLI arguments to pass after `node dist/cli.js`.
 * @param cwd - Working directory for the subprocess.
 * @param envOverrides - Optional environment variable overrides.
 */
export async function runCLI(
  args: string[],
  cwd: string,
  envOverrides: NodeJS.ProcessEnv = {},
): Promise<CLIResult> {
  try {
    // Guard against the temp-dir race: if cwd isn't visible yet, the
    // subprocess error is hard to read. Check inside the try so we surface
    // it via the normal CLIResult shape instead of as a raw throw.
    await access(cwd);

    const { stdout, stderr } = await exec("node", [CLI, ...args], {
      cwd,
      env: { ...process.env, ...envOverrides },
    });
    return {
      stdout,
      stderr,
      code: 0,
      signal: null,
      killed: false,
      message: null,
      args,
      cwd,
    };
  } catch (err: unknown) {
    const e = err as {
      stdout?: string;
      stderr?: string;
      code?: number;
      signal?: string | null;
      killed?: boolean;
      message?: string;
    };
    return {
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? "",
      code: typeof e.code === "number" ? e.code : 1,
      signal: e.signal ?? null,
      killed: e.killed ?? false,
      message: e.message ?? null,
      args,
      cwd,
    };
  }
}

/**
 * Start a `build` workflow run via the real CLI and return its minted run id.
 * Shared by the workflow CLI integration tests so the start-and-extract-id
 * preamble isn't duplicated per file.
 *
 * @param cwd - The temp project root (with a `build` workflow installed).
 * @returns The minted run id (e.g. `build-...`).
 */
export async function startBuildRunCLI(cwd: string): Promise<string> {
  const start = await runCLI(["workflow", "start", "build"], cwd);
  expect(start.code).toBe(0);
  return (start.stdout.match(/build-[\w-]+/) ?? [""])[0];
}
