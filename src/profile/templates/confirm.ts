/**
 * @file src/profile/templates/confirm.ts
 * @description Bounded, injectable confirmation for remote template writes.
 * Confirmation is a product safety gate only; it never replaces signature,
 * package, corpus, or project-lock validation.
 */
import { processTerminalLineIo, type TerminalLineIo } from "../../utils/terminal-line.js";

const MAX_CONFIRMATION_BYTES = 16;

/** Minimal terminal IO used by remote install/update confirmation. */
export type TemplateConfirmationIo = TerminalLineIo;

/** Confirm one already-verified remote template mutation. */
export async function confirmTemplateMutation(summary: string, io: TemplateConfirmationIo): Promise<boolean> {
  if (!io.stdinIsTty || !io.stdoutIsTty) return false;
  io.write(`${summary}\nType 'yes' to continue: `);
  const answer = await io.readLine();
  return answer !== null
    && Buffer.byteLength(answer, "utf8") <= MAX_CONFIRMATION_BYTES
    && answer.trim().toLowerCase() === "yes";
}

/** Bind template confirmation to the current process terminal. */
export function processTemplateConfirmationIo(): TemplateConfirmationIo {
  return processTerminalLineIo();
}
