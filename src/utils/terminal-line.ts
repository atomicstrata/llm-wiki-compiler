/**
 * @file src/utils/terminal-line.ts
 * @description Shared process-terminal adapter for bounded, line-oriented
 * confirmation prompts. Domain modules own the confirmation policy.
 */
import { createInterface } from "node:readline";

/** Minimal line-oriented terminal IO shared by confirmation policies. */
export interface TerminalLineIo {
  stdinIsTty: boolean;
  stdoutIsTty: boolean;
  write(text: string): void;
  readLine(): Promise<string | null>;
}

/** Bind line-oriented confirmation IO to the current process streams. */
export function processTerminalLineIo(): TerminalLineIo {
  return {
    stdinIsTty: process.stdin.isTTY === true,
    stdoutIsTty: process.stdout.isTTY === true,
    write: (text) => process.stdout.write(text),
    readLine: () => new Promise<string | null>((resolve) => {
      const rl = createInterface({ input: process.stdin });
      let settled = false;
      const finish = (value: string | null): void => {
        if (settled) return;
        settled = true;
        rl.close();
        resolve(value);
      };
      rl.once("line", (line) => finish(line));
      rl.once("close", () => finish(null));
    }),
  };
}
