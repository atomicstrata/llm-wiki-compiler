/**
 * @file test/helpers-child-process.ts
 * @description Run REAL child processes over the current TypeScript source.
 *
 * A child entry file is bundled once per test file by esbuild (already a
 * development dependency) into an ESM script under `node_modules/.cache` (so
 * package imports still resolve, and nothing tracked is written), so each child runs the
 * exact source under test in its own Node process: separate memory, separate
 * file handles, and a real SIGKILL when a witness needs one. Children print
 * one JSON line; {@link runChild} returns it with the exit code and signal.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp } from "node:fs/promises";
import path from "node:path";
import { build } from "esbuild";

/** One child's end. */
export interface ChildEnd {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly json: Record<string, unknown> | null;
  readonly stdout: string;
  readonly stderr: string;
  /** Set when the child could not be spawned at all. */
  readonly error?: Error;
}

/** Bundle `entry` (a path relative to the repository root) into a runnable script; returns its path. */
export async function bundleChild(entry: string): Promise<string> {
  const cache = path.resolve("node_modules/.cache/llmwiki-test-children");
  await mkdir(cache, { recursive: true });
  const dir = await mkdtemp(path.join(cache, "child-"));
  const outfile = path.join(dir, `${path.basename(entry, ".ts")}.mjs`);
  await build({
    entryPoints: [path.resolve(entry)], outfile, bundle: true, platform: "node", format: "esm", target: "node24", logLevel: "silent",
    packages: "external",
  });
  return outfile;
}

/**
 * Start `script` with `args` (and, when given, exactly `env` as its environment); the caller awaits {@link childEnd}.
 * `runtime` is the executable that runs the script: by default this test process's own runtime (`process.execPath`);
 * a caller whose child must run under a specific runtime names it explicitly (resolved like any spawned command).
 */
export function startChild(script: string, args: readonly string[], env?: NodeJS.ProcessEnv, runtime: string = process.execPath): ChildProcess {
  return spawn(runtime, [script, ...args], { stdio: ["ignore", "pipe", "pipe"], ...(env === undefined ? {} : { env }) });
}

/** The last stdout line parsed as JSON, or `null`. */
function lastJsonLine(stdout: string): Record<string, unknown> | null {
  const last = stdout.trim().split("\n").at(-1) ?? "";
  try { return last === "" ? null : JSON.parse(last) as Record<string, unknown>; } catch { return null; }
}

/** Wait for `child` to CLOSE (exit and all output drained), or fail to spawn, and parse its last stdout line as JSON. */
export function childEnd(child: ChildProcess): Promise<ChildEnd> {
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
  child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
  return new Promise((resolve) => {
    child.once("error", (error) => resolve({ code: null, signal: null, json: lastJsonLine(stdout), stdout, stderr, error }));
    child.once("close", (code, signal) => resolve({ code, signal, json: lastJsonLine(stdout), stdout, stderr }));
  });
}

/** Run `script` to completion. */
export function runChild(script: string, args: readonly string[]): Promise<ChildEnd> {
  return childEnd(startChild(script, args));
}
