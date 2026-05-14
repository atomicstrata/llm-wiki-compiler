/**
 * Long-lived CLI subprocess helper for viewer integration tests.
 *
 * Built as a deliberate sibling to `run-cli.ts` rather than as an
 * extension of `runCLI`: `runCLI` uses `execFile` for short-lived
 * commands that exit on their own, while the viewer test path needs to
 * spawn `llmwiki view`, parse stdout to discover the OS-assigned port,
 * hand control back to the test, then send SIGTERM to shut down.
 * Combining both shapes in one helper would just blur the API.
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
 * line, and resolve with a handle. Rejects when the process exits or
 * times out before printing the readiness line so tests fail fast with
 * the captured stderr instead of hanging.
 */
export async function startViewerCLI(
  args: string[],
  cwd: string,
  timeoutMs: number = DEFAULT_READY_TIMEOUT_MS,
): Promise<ViewerProcessHandle> {
  const child = spawn("node", [CLI, "view", ...args], {
    cwd,
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return new Promise<ViewerProcessHandle>((resolve, reject) => {
    let stdoutBuffer = "";
    let stderrBuffer = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      reject(
        new Error(
          `viewer readiness timeout after ${timeoutMs}ms\nstdout: ${stdoutBuffer}\nstderr: ${stderrBuffer}`,
        ),
      );
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutBuffer += chunk.toString("utf-8");
      const match = stdoutBuffer.match(READINESS_RE);
      if (match && !settled) {
        settled = true;
        clearTimeout(timer);
        const host = match[1] ?? match[2];
        resolve(buildHandle(child, host, Number(match[3]), stdoutBuffer));
      }
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      stderrBuffer += chunk.toString("utf-8");
    });

    child.once("exit", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(
        new Error(
          `viewer process exited before ready (code=${code}, signal=${signal})\nstdout: ${stdoutBuffer}\nstderr: ${stderrBuffer}`,
        ),
      );
    });
  });
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
  afterEach(async () => {
    while (handles.length > 0) {
      const handle = handles.pop();
      if (handle) await handle.kill();
    }
  });
  return {
    start: async (cwd, args = ["--port", "0"]) => {
      const handle = await startViewerCLI(args, cwd);
      handles.push(handle);
      return handle;
    },
  };
}
