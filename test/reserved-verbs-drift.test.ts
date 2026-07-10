/**
 * @file test/reserved-verbs-drift.test.ts
 * @description Drift guard tying the live CLI command registry to
 * `RESERVED_CORE_VERBS`.
 *
 * A profile-declared workflow id is surfaced in command space, so it must never
 * collide with a core top-level verb. This test parses the top-level verbs out of
 * the real `--help` output and asserts EVERY one is reserved — so adding a new CLI
 * verb without reserving it fails here rather than silently shadowing a workflow.
 * Commander's synthetic `help` verb is excluded (it is not a reservable surface).
 */

import { describe, it, expect } from "vitest";
import { runCLI } from "./fixtures/run-cli.js";
import { RESERVED_CORE_VERBS } from "../src/profile/reserved-verbs.js";

/** Commander prints two-space-indented command lines under a `Commands:` header. */
const COMMAND_LINE = /^ {2}(\S+)/;

/**
 * Parse the top-level verbs from `--help` output: every two-space-indented line
 * in the `Commands:` section contributes its first token. Deeper-indented
 * continuation lines and the synthetic `help` verb are excluded.
 */
function parseTopLevelVerbs(helpOutput: string): string[] {
  const lines = helpOutput.split("\n");
  const start = lines.findIndex((line) => line.trim() === "Commands:");
  const verbs: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const match = COMMAND_LINE.exec(line);
    if (match && match[1] !== "help") verbs.push(match[1]);
  }
  return verbs;
}

describe("reserved-verbs drift guard", () => {
  it("every registered top-level CLI verb is reserved", async () => {
    const result = await runCLI(["--help"], process.cwd());
    expect(result.code).toBe(0);
    const verbs = parseTopLevelVerbs(result.stdout);
    expect(verbs).toContain("workflow");
    expect(verbs.length).toBeGreaterThan(5);
    const unreserved = verbs.filter((verb) => !RESERVED_CORE_VERBS.has(verb));
    expect(unreserved).toEqual([]);
  });
});
