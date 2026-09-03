/**
 * Process-tree custody for active Codex CLI invocations.
 *
 * Codex runs in detached process groups so timeout termination reaches every
 * descendant. This registry preserves that custody when the llmwiki parent is
 * interrupted or exits, and removes invocation-owned temporary directories.
 */

import {
  spawn,
  spawnSync,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { rmSync } from "node:fs";
import { rm } from "node:fs/promises";

interface ActiveCodexProcess {
  child: ChildProcessWithoutNullStreams;
  closed: Promise<void>;
  cwd: string;
  graceMs: number;
}

const activeProcesses = new Map<number, ActiveCodexProcess>();
const EXIT_WAIT_MS = 1_000;
let interrupting = false;

/** Signal one isolated Codex process tree without exposing child output. */
export function signalCodexTree(
  child: ChildProcessWithoutNullStreams,
  signal: NodeJS.Signals,
): void {
  if (child.pid === undefined) return;
  if (process.platform === "win32") {
    const args = ["/PID", String(child.pid), "/T"];
    if (signal === "SIGKILL") args.push("/F");
    const killer = spawn("taskkill", args, { stdio: "ignore", windowsHide: true });
    killer.once("error", () => child.kill(signal));
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") child.kill(signal);
  }
}

/** Force process-tree termination from Node's synchronous exit hook. */
function forceTreeOnExit(entry: ActiveCodexProcess): void {
  const pid = entry.child.pid;
  if (pid === undefined) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // The group already exited.
  }
}

/** Wait a bounded interval without retaining any invocation resources. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Gracefully stop, force the tree, await pipe closure, and clean its cwd. */
async function stopForInterrupt(entry: ActiveCodexProcess): Promise<void> {
  signalCodexTree(entry.child, "SIGTERM");
  await delay(entry.graceMs);
  signalCodexTree(entry.child, "SIGKILL");
  await Promise.race([entry.closed, delay(EXIT_WAIT_MS)]);
  await rm(entry.cwd, { recursive: true, force: true });
}

/** Own parent interruption while at least one detached Codex tree is live. */
async function interrupt(signal: "SIGINT" | "SIGTERM"): Promise<void> {
  if (interrupting) return;
  interrupting = true;
  try {
    await Promise.allSettled([...activeProcesses.values()].map(stopForInterrupt));
  } finally {
    process.exit(signal === "SIGINT" ? 130 : 143);
  }
}

const onSigint = (): void => { void interrupt("SIGINT"); };
const onSigterm = (): void => { void interrupt("SIGTERM"); };
const onExit = (): void => {
  for (const entry of activeProcesses.values()) {
    try {
      forceTreeOnExit(entry);
    } finally {
      try {
        rmSync(entry.cwd, { recursive: true, force: true });
      } catch {
        // Exit hooks cannot retry asynchronously; continue cleaning other entries.
      }
    }
  }
};

/** Install parent-lifecycle handlers only while Codex owns live resources. */
function installHandlers(): void {
  if (activeProcesses.size !== 1) return;
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);
  process.once("exit", onExit);
}

/** Remove idle handlers so unrelated commands retain their prior lifecycle. */
function removeHandlers(): void {
  if (activeProcesses.size > 0 || interrupting) return;
  process.removeListener("SIGINT", onSigint);
  process.removeListener("SIGTERM", onSigterm);
  process.removeListener("exit", onExit);
}

/** Register one detached Codex invocation and return its artifact-cleanup release. */
export function registerCodexProcess(
  child: ChildProcessWithoutNullStreams,
  cwd: string,
  graceMs: number,
): () => void {
  if (child.pid === undefined) return () => undefined;
  const pid = child.pid;
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  activeProcesses.set(pid, { child, closed, cwd, graceMs });
  installHandlers();
  return () => {
    activeProcesses.delete(pid);
    removeHandlers();
  };
}
