/**
 * @file test/workflow-human-gate-confirm.test.ts
 * @description Tests for the interactive human-gate proof (C1).
 *
 * The invariant: a human gate is satisfiable ONLY at an interactive terminal. A
 * non-TTY io (the realistic agent-piping-the-CLI case) FAILS CLOSED with no prompt;
 * an interactive io that retypes the echoed random token correctly confirms; a wrong
 * token (or EOF) fails closed. The IO is injected so no real terminal is needed.
 */

import { describe, it, expect } from "vitest";
import { confirmHumanGateInteractively, type HumanGateIo } from "../src/workflows/human-gate-confirm.js";

/** A fake terminal IO capturing writes and replying with a caller-chosen answer. */
function makeIo(opts: {
  stdinIsTty: boolean;
  stdoutIsTty: boolean;
  /** Build the operator's typed line from the captured prompt (e.g. extract the token). */
  answer?: (captured: string) => string | null;
}): { io: HumanGateIo; captured: () => string } {
  let buffer = "";
  const io: HumanGateIo = {
    stdinIsTty: opts.stdinIsTty,
    stdoutIsTty: opts.stdoutIsTty,
    write: (text) => {
      buffer += text;
    },
    readLine: async () => (opts.answer ? opts.answer(buffer) : null),
  };
  return { io, captured: () => buffer };
}

/** Extract the echoed confirmation token from the captured prompt. */
function tokenFrom(captured: string): string {
  return (captured.match(/confirm you are a human at this terminal: ([0-9a-f]+)/) ?? ["", ""])[1];
}

describe("confirmHumanGateInteractively — non-TTY fails closed (C1)", () => {
  it("returns false when stdin is not a TTY (piped — the agent case)", async () => {
    const { io } = makeIo({ stdinIsTty: false, stdoutIsTty: true });
    expect(await confirmHumanGateInteractively("approve", io)).toBe(false);
  });

  it("returns false when stdout is not a TTY (redirected)", async () => {
    const { io } = makeIo({ stdinIsTty: true, stdoutIsTty: false });
    expect(await confirmHumanGateInteractively("approve", io)).toBe(false);
  });

  it("does not even prompt for a token on a non-TTY io", async () => {
    const { io, captured } = makeIo({ stdinIsTty: false, stdoutIsTty: false });
    await confirmHumanGateInteractively("approve", io);
    expect(captured()).not.toMatch(/Type this token/);
  });
});

describe("confirmHumanGateInteractively — interactive TTY", () => {
  it("returns true when the operator retypes the echoed token exactly", async () => {
    const { io } = makeIo({ stdinIsTty: true, stdoutIsTty: true, answer: tokenFrom });
    expect(await confirmHumanGateInteractively("approve", io)).toBe(true);
  });

  it("tolerates surrounding whitespace on the typed token", async () => {
    const { io } = makeIo({ stdinIsTty: true, stdoutIsTty: true, answer: (c) => `  ${tokenFrom(c)}\n` });
    expect(await confirmHumanGateInteractively("approve", io)).toBe(true);
  });

  it("returns false on a WRONG token (an agent guessing a canned string)", async () => {
    const { io } = makeIo({ stdinIsTty: true, stdoutIsTty: true, answer: () => "yes" });
    expect(await confirmHumanGateInteractively("approve", io)).toBe(false);
  });

  it("returns false on EOF / closed stdin (null line)", async () => {
    const { io } = makeIo({ stdinIsTty: true, stdoutIsTty: true, answer: () => null });
    expect(await confirmHumanGateInteractively("approve", io)).toBe(false);
  });
});
