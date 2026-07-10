/**
 * @file src/workflows/human-gate-confirm.ts
 * @description Interactive proof for HUMAN gates — the ONE path that can produce a
 * `human` actor, shared by the direct `gate approve` command AND the `action run`
 * surface (so there is exactly one way to satisfy a human gate).
 *
 * A `human:` gate is the highest-trust action, yet the prior `--actor human` flag was
 * self-asserted: any agent that spawned the CLI could satisfy a human gate
 * non-interactively. This raises the bar:
 *
 *  - Both stdin AND stdout must be a TTY. A piped/redirected/non-interactive stream
 *    fails closed — no prompt, no approval. SDK/MCP callers supply
 *    {@link nonInteractiveHumanGateIo}, so they always fail closed.
 *  - At a real terminal the operator is shown a short random token and must type it
 *    back. A mismatch (or EOF/closed stdin) fails closed.
 *
 * ## Honest trust boundary (NOT a barrier against a determined local agent)
 * This is a SPEED-BUMP against NAIVE automation (an agent that merely pipes the CLI),
 * NOT a defence against a determined local agent: such an agent can allocate a
 * pseudo-terminal, read the echoed token off the pty, and type it back — the proof is
 * presence-of-a-TTY, not proof-of-a-human, and the token is echoed on the same stream
 * the agent controls. The REAL security boundary against a fully-hostile local agent
 * is OS-LEVEL ISOLATION: run the agent as a restricted user WITHOUT a real TTY,
 * WITHOUT write access to the run store, and WITHOUT the operator's environment. This
 * in-process check raises the bar (no silent programmatic human-gate satisfaction) but
 * does not replace OS isolation.
 *
 * The IO is INJECTED ({@link HumanGateIo}) so tests drive the prompt without a real
 * terminal; the cli passes `process.stdin`/`process.stdout`. This module decides ONLY
 * whether the interactive proof passed — the caller does the actual `approveGate`.
 */

import { randomBytes } from "node:crypto";

/** Bytes of entropy in the confirmation token (8 hex chars — easy to retype, unguessable). */
const CONFIRM_TOKEN_BYTES = 4;

/**
 * The minimal injectable IO the interactive prompt needs. Mirrors the slice of
 * `process.stdin`/`process.stdout` used, so tests can supply a fake without a real
 * terminal. `isTTY` is the interactivity signal; `write` echoes the prompt; `readLine`
 * resolves the operator's typed line (or `null` on EOF/closed stdin).
 */
export interface HumanGateIo {
  /** Whether stdin is an interactive terminal (false when piped/redirected). */
  stdinIsTty: boolean;
  /** Whether stdout is an interactive terminal (false when redirected). */
  stdoutIsTty: boolean;
  /** Write a prompt line to stdout. */
  write(text: string): void;
  /** Read one line of operator input, or `null` on EOF / closed stdin. */
  readLine(): Promise<string | null>;
}

/** Generate a short random confirmation token the operator must retype. */
function mintConfirmToken(): string {
  return randomBytes(CONFIRM_TOKEN_BYTES).toString("hex");
}

/**
 * A NON-INTERACTIVE {@link HumanGateIo} that always fails the proof: it reports no TTY
 * and yields no input. The default for any PROGRAMMATIC caller (SDK/MCP and the
 * `runAction` default), so a human gate is NEVER satisfiable off a real cli terminal.
 *
 * @returns An IO whose proof always fails closed.
 */
export function nonInteractiveHumanGateIo(): HumanGateIo {
  return {
    stdinIsTty: false,
    stdoutIsTty: false,
    write: () => {},
    readLine: async () => null,
  };
}

/**
 * Confirm a HUMAN gate via an interactive TTY challenge — the ONLY way to produce a
 * `human` actor (C1).
 *
 * FAILS CLOSED (returns `false`, no prompt) unless BOTH stdin and stdout are a TTY,
 * so an agent piping/redirecting the CLI non-interactively can never satisfy a human
 * gate. At a real terminal it prints a random token and requires the operator to type
 * it back EXACTLY; any other line — or EOF/closed stdin — fails closed.
 *
 * @param gateId - The gate id being approved (echoed in the prompt for clarity).
 * @param io - The injected terminal IO (production: `process.stdin`/`process.stdout`).
 * @returns `true` only when an interactive operator retyped the token correctly.
 */
export async function confirmHumanGateInteractively(gateId: string, io: HumanGateIo): Promise<boolean> {
  if (!io.stdinIsTty || !io.stdoutIsTty) {
    io.write(
      `Refusing to approve human gate ${JSON.stringify(gateId)}: a human gate requires ` +
        `interactive confirmation at a terminal (stdin/stdout are not a TTY).\n`,
    );
    return false;
  }
  const token = mintConfirmToken();
  io.write(
    `Human gate ${JSON.stringify(gateId)} requires human confirmation.\n` +
      `Type this token to confirm you are a human at this terminal: ${token}\n> `,
  );
  const answer = await io.readLine();
  return answer !== null && answer.trim() === token;
}
