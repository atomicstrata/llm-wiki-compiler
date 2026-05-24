/**
 * Long-lived CLI subprocess helper for tests that need to wait for the
 * viewer readiness line and then shut down a still-running CLI process.
 *
 * Built as a deliberate sibling to `run-cli.ts` rather than as an
 * extension of `runCLI`: `runCLI` uses `execFile` for short-lived
 * commands that exit on their own, while the viewer / quickstart-handoff
 * paths spawn a CLI that keeps the event loop alive via a listening
 * socket, parse stdout to discover the OS-assigned port, hand control
 * back to the test, then send SIGTERM to shut down. Combining both
 * shapes in one helper would just blur the API.
 *
 * Two entry points share one spawn-and-await-readiness implementation:
 * `startViewerCLI` for `llmwiki view ...` and `startQuickstartCLI` for
 * `llmwiki quickstart ...`. Both rely on the same `Viewer ready at`
 * line — quickstart's foreground handoff delegates to viewCommand which
 * emits the same readiness line.
 */

import { ChildProcess, spawn } from "child_process";
import path from "path";
import { afterEach } from "vitest";

const CLI = path.resolve("dist/cli.js");
// Parses either `http://127.0.0.1:PORT` or the bracketed-IPv6 form
// `http://[::1]:PORT` — group 1 captures the host without the brackets.
const READINESS_RE = /Viewer ready at http:\/\/(?:\[([^\]]+)\]|([^\s:]+)):(\d+)/;
const DEFAULT_READY_TIMEOUT_MS = 5000;

/** Handle returned by {@link startViewerCLI}. */
export interface ViewerProcessHandle {
  /** Hostname the viewer bound to (as printed in the readiness line). */
  host: string;
  /** Port the viewer bound to (as printed in the readiness line). */
  port: number;
  /** Underlying child process, exposed for signal tests. */
  process: ChildProcess;
  /** Captured stdout up to the moment the readiness line was emitted. */
  stdout: string;
  /** Send SIGTERM and await exit. Idempotent. */
  kill(): Promise<void>;
}

/**
 * Spawn `node dist/cli.js view <args>` in `cwd`, wait for the readiness
 * line, and resolve with a handle. Thin wrapper around the shared
 * `spawnAwaitingReadiness` core so the viewer and quickstart paths
 * share one timeout/stderr-capture/cleanup story.
 */
export async function startViewerCLI(
  args: string[],
  cwd: string,
  timeoutMs: number = DEFAULT_READY_TIMEOUT_MS,
): Promise<ViewerProcessHandle> {
  return spawnAwaitingReadiness(["view", ...args], cwd, timeoutMs, "viewer", { env: process.env });
}

/**
 * Spawn `node dist/cli.js quickstart <args>` in `cwd`, wait for the
 * readiness line emitted by quickstart's viewer handoff, and resolve
 * with a handle. `envOverrides` is merged on top of `process.env` so
 * tests can inject aimock credentials the same way `runCLI` does.
 */
export async function startQuickstartCLI(
  args: string[],
  cwd: string,
  envOverrides: NodeJS.ProcessEnv = {},
  timeoutMs: number = DEFAULT_READY_TIMEOUT_MS,
): Promise<ViewerProcessHandle> {
  return spawnAwaitingReadiness(
    ["quickstart", ...args],
    cwd,
    timeoutMs,
    "quickstart",
    { env: { ...process.env, ...envOverrides } },
  );
}

/** Options forwarded to `child_process.spawn` from each entry point. */
interface SpawnOptions {
  env: NodeJS.ProcessEnv;
}

/**
 * Spawn `node dist/cli.js <argv>` and resolve once the viewer readiness
 * line is observed on stdout. Rejects on early exit or timeout so tests
 * fail fast with captured stderr instead of hanging.
 */
async function spawnAwaitingReadiness(
  argv: string[],
  cwd: string,
  timeoutMs: number,
  label: string,
  options: SpawnOptions,
): Promise<ViewerProcessHandle> {
  const child = spawn("node", [CLI, ...argv], {
    cwd,
    env: options.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return new Promise<ViewerProcessHandle>((resolve, reject) => {
    awaitReadiness({ child, label, timeoutMs, resolve, reject });
  });
}

/** Inputs for the readiness-watch state machine. */
interface ReadinessWatch {
  child: ChildProcess;
  label: string;
  timeoutMs: number;
  resolve: (handle: ViewerProcessHandle) => void;
  reject: (err: Error) => void;
}

/** Wire up the timeout, stdout/stderr listeners, and early-exit guard for one spawn. */
function awaitReadiness(watch: ReadinessWatch): void {
  const buffers = { stdout: "", stderr: "" };
  let settled = false;
  const settle = (fn: () => void): void => {
    if (settled) return;
    settled = true;
    fn();
  };
  const timer = setTimeout(() => {
    settle(() => {
      watch.child.kill("SIGTERM");
      watch.reject(timeoutError(watch.label, watch.timeoutMs, buffers));
    });
  }, watch.timeoutMs);
  watch.child.stdout?.on("data", (chunk: Buffer) => {
    buffers.stdout += chunk.toString("utf-8");
    const match = buffers.stdout.match(READINESS_RE);
    if (!match) return;
    settle(() => {
      clearTimeout(timer);
      const host = match[1] ?? match[2];
      watch.resolve(buildHandle(watch.child, host, Number(match[3]), buffers.stdout));
    });
  });
  watch.child.stderr?.on("data", (chunk: Buffer) => {
    buffers.stderr += chunk.toString("utf-8");
  });
  watch.child.once("exit", (code, signal) => {
    settle(() => {
      clearTimeout(timer);
      watch.reject(earlyExitError(watch.label, code, signal, buffers));
    });
  });
}

/** Format the captured buffers into a deterministic error message body. */
function bufferTail(buffers: { stdout: string; stderr: string }): string {
  return `stdout: ${buffers.stdout}\nstderr: ${buffers.stderr}`;
}

/** Build the timeout-failure error. */
function timeoutError(
  label: string,
  timeoutMs: number,
  buffers: { stdout: string; stderr: string },
): Error {
  return new Error(`${label} readiness timeout after ${timeoutMs}ms\n${bufferTail(buffers)}`);
}

/** Build the early-exit failure error. */
function earlyExitError(
  label: string,
  code: number | null,
  signal: NodeJS.Signals | null,
  buffers: { stdout: string; stderr: string },
): Error {
  return new Error(
    `${label} process exited before ready (code=${code}, signal=${signal})\n${bufferTail(buffers)}`,
  );
}

/** Construct the handle once the readiness line has matched. */
function buildHandle(
  child: ChildProcess,
  host: string,
  port: number,
  stdout: string,
): ViewerProcessHandle {
  let killed = false;
  return {
    host,
    port,
    process: child,
    stdout,
    kill: () => terminate(child, () => killed, () => { killed = true; }),
  };
}

/** Send SIGTERM and wait for the child to exit. Resolves immediately on repeat calls. */
function terminate(
  child: ChildProcess,
  isAlreadyKilled: () => boolean,
  markKilled: () => void,
): Promise<void> {
  if (isAlreadyKilled() || child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  markKilled();
  return new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
    child.kill("SIGTERM");
  });
}

/**
 * Composable that registers an `afterEach` hook to tear down every
 * viewer subprocess started through the returned `start` function.
 * Call at the top level of a `describe` block; use the returned `start`
 * to launch the viewer with default `--port 0` (override via the second
 * argument).
 */
export function useViewerProcessLifecycle(): {
  start: (cwd: string, args?: string[]) => Promise<ViewerProcessHandle>;
} {
  const handles: ViewerProcessHandle[] = [];
  registerHandleTeardown(handles);
  return {
    start: async (cwd, args = ["--port", "0"]) => {
      const handle = await startViewerCLI(args, cwd);
      handles.push(handle);
      return handle;
    },
  };
}

/**
 * Sibling composable for `llmwiki quickstart` subprocesses that hand
 * off to the foreground viewer. Uses the same teardown contract as
 * `useViewerProcessLifecycle` so the only thing tests vary is the CLI
 * subcommand argv they want spawned.
 */
export function useQuickstartProcessLifecycle(): {
  start: (
    cwd: string,
    args: string[],
    envOverrides?: NodeJS.ProcessEnv,
  ) => Promise<ViewerProcessHandle>;
} {
  const handles: ViewerProcessHandle[] = [];
  registerHandleTeardown(handles);
  return {
    start: async (cwd, args, envOverrides = {}) => {
      const handle = await startQuickstartCLI(args, cwd, envOverrides);
      handles.push(handle);
      return handle;
    },
  };
}

/**
 * Register an afterEach that kills every still-running handle in the
 * shared list. Extracted so the viewer and quickstart composables can
 * not drift on the teardown semantics — both must SIGTERM their
 * subprocesses or the next test inherits a stuck listening socket.
 */
function registerHandleTeardown(handles: ViewerProcessHandle[]): void {
  afterEach(async () => {
    while (handles.length > 0) {
      const handle = handles.pop();
      if (handle) await handle.kill();
    }
  });
}
