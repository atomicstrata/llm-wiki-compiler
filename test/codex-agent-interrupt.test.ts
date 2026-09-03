/**
 * Real-entrypoint interruption custody for a running Codex invocation.
 *
 * The test signals llmwiki itself—not the fake—and observes the process PID and
 * throwaway cwd captured at the literal Codex executable boundary.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { access, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAimockLifecycle } from "./fixtures/aimock-helper.js";
import { installFakeCodex, type CapturedCodexCall, type FakeCodex } from "./fixtures/fake-codex.js";
import { CLI } from "./fixtures/run-cli.js";

const aimock = useAimockLifecycle("codex-agent-interrupt");
const fakes: FakeCodex[] = [];
const interruptionCases: Array<{ label: string; signals: NodeJS.Signals[] }> = [
  { label: "one SIGINT", signals: ["SIGINT"] },
  { label: "repeated SIGINT", signals: ["SIGINT", "SIGINT"] },
  { label: "one SIGTERM", signals: ["SIGTERM"] },
  { label: "repeated SIGTERM", signals: ["SIGTERM", "SIGTERM"] },
];

/** Wait until the fake has captured its first real process-boundary call. */
async function waitForCall(fake: FakeCodex): Promise<CapturedCodexCall> {
  await fake.ready();
  const [call] = await fake.calls();
  if (!call) throw new Error("Codex fake reported ready without a captured call");
  return call;
}

/** Wait for the llmwiki parent to honor an interruption signal. */
async function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await once(child, "exit");
}

/** Check PID liveness without reading any process-owned state. */
function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Deliver repeated interrupts only after cleanup has observably started. */
async function sendInterrupts(
  child: ChildProcess,
  fake: FakeCodex,
  signals: NodeJS.Signals[],
): Promise<void> {
  child.kill(signals[0]);
  await fake.waitForSignal("SIGTERM");
  for (const signal of signals.slice(1)) child.kill(signal);
}

afterEach(async () => {
  await Promise.all(fakes.splice(0).map((fake) => fake.cleanup()));
});

describe("codex-agent parent interruption", () => {
  it.each(interruptionCases)(
    "terminates the active Codex tree and removes its cwd after $label",
    async ({ signals }) => {
      const cwd = await aimock.makeWorkspace("# Source\n\nInterrupt the compile.\n");
      const fake = await installFakeCodex({ hang: true, ignoreTerm: true });
      fakes.push(fake);
      const child = spawn(process.execPath, [CLI, "compile", "--provider", "codex-agent"], {
        cwd,
        env: {
          ...process.env,
          PATH: `${fake.binDir}${path.delimiter}${process.env.PATH ?? ""}`,
          LLMWIKI_EMBEDDING_PROVIDER: "ollama",
        },
        stdio: "ignore",
      });
      let call: CapturedCodexCall | undefined;
      try {
        call = await waitForCall(fake);
        const exited = waitForExit(child);
        await sendInterrupts(child, fake, signals);
        await exited;
        expect(processIsAlive(call.pid)).toBe(false);
        await expect(access(call.cwd)).rejects.toThrow();
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        if (call && processIsAlive(call.pid)) process.kill(-call.pid, "SIGKILL");
        if (call) await rm(call.cwd, { recursive: true, force: true });
      }
    },
  );
});
