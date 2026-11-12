/**
 * @file test/fixtures/spawn-captured.ts
 * @description `spawnSync`'s result, from an asynchronous spawn.
 *
 * Under Bun a synchronous spawn can spin forever beside its exited, unreaped
 * child (oven-sh/bun#46488): CI shards hung on a test worker at 100% CPU next
 * to a `[bun] <defunct>`, with the per-test timeout unable to fire. Tests that
 * start a process and read what it printed use {@link spawnCaptured} instead,
 * which resolves with the same `status` / `signal` / `stdout` / `stderr` /
 * `error` fields a `spawnSync(..., { encoding: "utf8" })` result carries.
 */

import { spawn } from "node:child_process";

/** Options {@link spawnCaptured} honours, as `spawnSync` reads them. */
export interface SpawnCapturedOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Written to the child's stdin, which is then closed. */
  input?: string;
  /** Milliseconds before the child is sent SIGTERM, as `spawnSync`'s `timeout`. */
  timeout?: number;
}

/** What a `spawnSync(..., { encoding: "utf8" })` call returns, minus `pid` and `output`. */
export interface SpawnCapturedResult {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

/**
 * Run `command` with `args` to completion and capture its output. Never
 * rejects: a failed spawn is reported in `error`, as `spawnSync` reports it.
 */
export function spawnCaptured(
  command: string, args: readonly string[], options: SpawnCapturedOptions = {},
): Promise<SpawnCapturedResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env, timeout: options.timeout });
    let stdout = "";
    let stderr = "";
    let error: Error | undefined;
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", (failure) => { error = failure; });
    child.on("close", (status, signal) => resolve({ status, signal, stdout, stderr, ...(error ? { error } : {}) }));
    child.stdin.end(options.input ?? "");
  });
}
