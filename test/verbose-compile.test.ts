/**
 * Subprocess test for --verbose mode in `llmwiki compile`.
 *
 * Runs compile twice in the same aimock-backed workspace:
 *   1. Without --verbose  → stdout must NOT contain the `  · ` marker.
 *   2. With --verbose     → stdout MUST contain the `  · ` marker.
 *
 * Relies on the existing aimock/runCLI infrastructure to avoid a live LLM.
 */

import { describe, it, expect } from "vitest";
import {
  mockOpenAIEnv,
  useAimockLifecycle,
  type MockClaudeHandle,
} from "./fixtures/aimock-helper.js";
import {
  runCLI,
  expectCLIExit,
  formatCLIFailure,
} from "./fixtures/run-cli.js";

const aimock = useAimockLifecycle("verbose-compile");

/** Marker emitted by verbose() calls. */
const VERBOSE_MARKER = "  · ";

const SOURCE = "# Verbose Test\n\nA short source to verify verbose compile output.\n";
const PAGE_BODY =
  "Verbose mode adds per-step detail lines to compilation output for debugging.";

/** Register minimal aimock responses for a single-source compile. */
function registerMocks(handle: MockClaudeHandle): void {
  handle.mock.onToolCall("extract_concepts", {
    toolCalls: [
      {
        name: "extract_concepts",
        arguments: {
          concepts: [
            {
              concept: "Verbose Mode",
              summary: "Per-step detail lines for debugging.",
              is_new: true,
              tags: ["cli"],
              confidence: 0.9,
            },
          ],
        },
      },
    ],
  });
  handle.mock.onMessage(/.*/, { content: PAGE_BODY });
  handle.mock.onEmbedding(/.*/, { embedding: Array.from({ length: 8 }, (_, i) => i / 10) });
}

describe("--verbose flag in compile", () => {
  it("plain compile produces no verbose marker; --verbose compile does", async () => {
    const handle = await aimock.start();
    registerMocks(handle);
    const cwd = await aimock.makeWorkspace(SOURCE);
    const env = mockOpenAIEnv(handle);

    // Run without --verbose first.
    const plain = await runCLI(["compile"], cwd, env);
    expectCLIExit(plain, 0);
    expect(plain.stdout, formatCLIFailure(plain)).not.toContain(VERBOSE_MARKER);

    // Register mocks again for the second run (aimock queues are consumed).
    registerMocks(handle);

    // Run with --verbose.
    const loud = await runCLI(["compile", "--verbose"], cwd, env);
    expectCLIExit(loud, 0);
    expect(loud.stdout, formatCLIFailure(loud)).toContain(VERBOSE_MARKER);
  }, 30_000);
});
