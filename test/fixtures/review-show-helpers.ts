/**
 * Shared helpers for tests that exercise `llmwiki review show`.
 *
 * Centralises the console.log spy + invocation pattern so the schema and
 * provenance violation suites share one implementation. fallow's CI mode
 * flags the duplicate boilerplate as a clone group otherwise.
 */

import { vi } from "bun:test";
import reviewShowCommand from "../../src/commands/review-show.js";

/**
 * Run `reviewShowCommand` for a single candidate id and return all the
 * console.log output it produced as a single newline-joined string.
 * Tests assert against substrings of the returned text.
 */
export async function captureShowOutput(candidateId: string): Promise<string> {
  const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  await reviewShowCommand(candidateId);
  return logSpy.mock.calls.map((args) => args.join(" ")).join("\n");
}
