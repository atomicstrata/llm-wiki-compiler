/**
 * @file test/fixtures/ps-lstart.ts
 * @description What `ps -o lstart=` prints for a pid: the start time lock
 * records are compared against. Asked through {@link spawnCaptured}, not a
 * synchronous spawn, which can hang a Bun test worker (oven-sh/bun#46488).
 */

import { spawnCaptured } from "./spawn-captured.js";

/** `ps -o lstart=` for `pid`, trimmed, under `env` (default: this process's). */
export async function psLstart(pid: number, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const { status, stdout, stderr } = await spawnCaptured("ps", ["-o", "lstart=", "-p", String(pid)], { env });
  if (status !== 0) throw new Error(`ps exited ${status}: ${stderr}`);
  return stdout.trim();
}
