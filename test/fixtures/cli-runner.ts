/**
 * Shared helpers for CLI integration tests that spawn `bun dist/cli.js`.
 *
 * Centralises the `exec` / `CLI` constants and the ANSI-stripping utility
 * so individual test files don't duplicate this boilerplate.
 */

import { execFile } from "child_process";
import { promisify } from "util";
import path from "path";

/** Promisified execFile for spawning the CLI in tests. */
export const exec = promisify(execFile);

/** Absolute path to the built CLI entry point. */
export const CLI = path.resolve("dist/cli.js");

/** Strip ANSI escape codes so plain-text assertions work on colored output. */
export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}
