/**
 * CLI integration test for issue #37 — `--lang` and LLMWIKI_OUTPUT_LANG
 * must thread through to the system prompt the LLM actually receives.
 *
 * Uses aimock to capture the request the CLI subprocess sent and asserts
 * that the configured language directive is present in the system prompt.
 */

import { describe, it, expect } from "bun:test";
import {
  mockClaudeEnv,
  useAimockLifecycle,
} from "./fixtures/aimock-helper.js";
import { runCLI, expectCLIExit } from "./fixtures/run-cli.js";

const aimock = useAimockLifecycle("output-language");

/** Stub the canned compile responses (extraction + page body) on a handle. */
function stubCannedCompile(handle: import("./fixtures/aimock-helper.js").MockClaudeHandle): void {
  handle.mock.onToolCall("extract_concepts", {
    toolCalls: [
      {
        name: "extract_concepts",
        arguments: {
          concepts: [
            {
              concept: "Lang Concept",
              summary: "Concept emitted by aimock for the lang test.",
              is_new: true,
              tags: ["lang-test"],
              confidence: 0.9,
            },
          ],
        },
      },
    ],
  });
  handle.mock.onMessage(/.*/, { content: "Page body produced for the lang test." });
}

/**
 * Concatenate every system prompt aimock saw across all recorded
 * requests. aimock normalises Anthropic's top-level `system` field into
 * a `{role: "system", content: ...}` message in `body.messages`, so we
 * walk the messages array (not body.system) to find them.
 */
function collectSystemPrompts(
  handle: import("./fixtures/aimock-helper.js").MockClaudeHandle,
): string {
  const requests = handle.mock.getRequests() as Array<{ body?: unknown }>;
  const collected: string[] = [];
  for (const req of requests) {
    const body = req.body as { messages?: unknown } | undefined;
    if (!Array.isArray(body?.messages)) continue;
    for (const msg of body.messages as Array<{ role?: unknown; content?: unknown }>) {
      if (msg.role === "system" && typeof msg.content === "string") {
        collected.push(msg.content);
      }
    }
  }
  return collected.join("\n---REQUEST-BOUNDARY---\n");
}

describe("output-language CLI integration (#37)", () => {
  it("compile --lang Spanish injects the directive into the system prompt", async () => {
    const handle = await aimock.start();
    stubCannedCompile(handle);

    const cwd = await aimock.makeWorkspace("# Source\n\nA short source for the lang test.\n");
    const result = await runCLI(
      ["compile", "--review", "--lang", "Spanish"],
      cwd,
      mockClaudeEnv(handle),
    );
    expectCLIExit(result, 0);

    const allSystemPrompts = collectSystemPrompts(handle);
    expect(allSystemPrompts).toContain("Write the output in Spanish.");
  }, 30_000);

  it("LLMWIKI_OUTPUT_LANG env var has the same effect as --lang", async () => {
    const handle = await aimock.start();
    stubCannedCompile(handle);

    const cwd = await aimock.makeWorkspace("# Source\n\nAnother short source.\n");
    const result = await runCLI(["compile", "--review"], cwd, {
      ...mockClaudeEnv(handle),
      LLMWIKI_OUTPUT_LANG: "Japanese",
    });
    expectCLIExit(result, 0);

    const allSystemPrompts = collectSystemPrompts(handle);
    expect(allSystemPrompts).toContain("Write the output in Japanese.");
  }, 30_000);

  it("compile without --lang leaves the directive out of the system prompt", async () => {
    const handle = await aimock.start();
    stubCannedCompile(handle);

    const cwd = await aimock.makeWorkspace("# Source\n\nA third short source.\n");
    const result = await runCLI(["compile", "--review"], cwd, mockClaudeEnv(handle));
    expectCLIExit(result, 0);

    const allSystemPrompts = collectSystemPrompts(handle);
    expect(allSystemPrompts).not.toContain("Write the output in");
  }, 30_000);
});
