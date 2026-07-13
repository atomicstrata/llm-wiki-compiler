/**
 * @file test/profile-template-confirm.test.ts
 * @description Confirmation refuses automation and accepts only a bounded,
 * explicit interactive yes response.
 */
import { describe, expect, it } from "vitest";
import { confirmTemplateMutation, type TemplateConfirmationIo } from "../src/profile/templates/confirm.js";

function io(answer: string | null, tty = true): TemplateConfirmationIo & { output: string[] } {
  const output: string[] = [];
  return {
    stdinIsTty: tty,
    stdoutIsTty: tty,
    output,
    write: (text) => output.push(text),
    readLine: async () => answer,
  };
}

describe("remote template confirmation", () => {
  it("refuses a non-interactive invocation without prompting", async () => {
    const terminal = io("yes", false);
    expect(await confirmTemplateMutation("Install verified release", terminal)).toBe(false);
    expect(terminal.output).toEqual([]);
  });

  it("accepts only an explicit bounded yes", async () => {
    expect(await confirmTemplateMutation("Install", io("yes"))).toBe(true);
    expect(await confirmTemplateMutation("Install", io("no"))).toBe(false);
    expect(await confirmTemplateMutation("Install", io("y".repeat(17)))).toBe(false);
  });
});
