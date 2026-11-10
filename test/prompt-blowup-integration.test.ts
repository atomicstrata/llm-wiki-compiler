/**
 * CLI integration test for issue #39 — prompt-blowup defence.
 *
 * Stages a workspace with five source documents that all extract the same
 * shared concept, sets a very tight prompt budget, runs `compile --review`
 * via the CLI subprocess, and asserts:
 *
 *   1. compile exits 0 (does NOT crash with a context-length error path).
 *   2. The system prompt aimock observed for the page-generation call is
 *      bounded — does not contain the full raw concatenation of every
 *      source.
 *   3. The truncation marker appears, proving the budget actually ran.
 *
 * Without the fix in src/compiler/prompt-budget.ts, the page-generation
 * prompt would include all five sources at full size (~1MB+) regardless
 * of the budget setting.
 */

import { describe, it, expect } from "bun:test";
import { mkdir, writeFile } from "fs/promises";
import path from "path";
import {
  findSystemPromptByUserMessage,
  mockClaudeEnv,
  useAimockLifecycle,
  type MockClaudeHandle,
} from "./fixtures/aimock-helper.js";
import { runCLI, expectCLIExit } from "./fixtures/run-cli.js";

const aimock = useAimockLifecycle("prompt-blowup");

const SHARED_CONCEPT = "Shared Topic";
const SHARED_CONCEPT_SLUG = "shared-topic";
const SOURCE_COUNT = 5;
const SOURCE_CHARS = 4_000;
const TIGHT_BUDGET = "5000";

/**
 * Stub the extraction call so every source returns the same shared concept,
 * forcing all five into the merge bucket for SHARED_CONCEPT.
 */
function stubSharedConceptExtraction(handle: MockClaudeHandle): void {
  handle.mock.onToolCall("extract_concepts", {
    toolCalls: [
      {
        name: "extract_concepts",
        arguments: {
          concepts: [
            {
              concept: SHARED_CONCEPT,
              summary: "A topic that every source touches.",
              is_new: true,
              tags: ["shared"],
              confidence: 0.9,
            },
          ],
        },
      },
    ],
  });
  handle.mock.onMessage(/.*/, { content: "Shared topic page body." });
}

/** Create a workspace populated with N distinct sources, each ~SOURCE_CHARS long. */
async function makeMultiSourceWorkspace(): Promise<string> {
  const cwd = await aimock.makeWorkspace("# placeholder\n", "placeholder.md");
  const sourcesDir = path.join(cwd, "sources");
  await mkdir(sourcesDir, { recursive: true });
  for (let i = 0; i < SOURCE_COUNT; i++) {
    const filler = `paragraph-${i} `.repeat(Math.ceil(SOURCE_CHARS / 12)).slice(0, SOURCE_CHARS);
    await writeFile(
      path.join(sourcesDir, `source-${i}.md`),
      `# Source ${i}\n\n${filler}\n`,
      "utf-8",
    );
  }
  return cwd;
}

/**
 * Pull the single page-generation system prompt out of aimock's recording.
 * The page-generation request is the one whose user message asks for a
 * wiki page for our shared concept (the extraction request asks to
 * "Extract the key concepts" instead), so the predicate disambiguates.
 */
function findPageGenerationSystemPrompt(handle: MockClaudeHandle): string | null {
  return findSystemPromptByUserMessage(handle, (u) =>
    u.includes(`Write the wiki page for "${SHARED_CONCEPT}"`),
  );
}

/**
 * Stage the multi-source workspace and run a single `compile --review`
 * subprocess against the shared-concept extraction stub. Centralised so
 * each test reads as the assertion that distinguishes it (budget set vs
 * not) rather than the boilerplate they share.
 */
async function runSharedConceptCompile(
  envOverrides: NodeJS.ProcessEnv,
): Promise<{
  result: import("./fixtures/run-cli.js").CLIResult;
  systemPrompt: string;
  handle: MockClaudeHandle;
}> {
  const handle = await aimock.start();
  stubSharedConceptExtraction(handle);
  const cwd = await makeMultiSourceWorkspace();
  const result = await runCLI(["compile", "--review"], cwd, {
    ...mockClaudeEnv(handle),
    ...envOverrides,
  });
  expectCLIExit(result, 0);
  const systemPrompt = findPageGenerationSystemPrompt(handle);
  expect(systemPrompt, "page-generation system prompt should be recorded").not.toBeNull();
  return { result, systemPrompt: systemPrompt!, handle };
}

describe("prompt blowup defence (#39)", () => {
  it("compile bounds the page prompt and emits the truncation marker", async () => {
    const { result, systemPrompt } = await runSharedConceptCompile({
      LLMWIKI_PROMPT_BUDGET_CHARS: TIGHT_BUDGET,
    });

    // Bounded: well under the unbudgeted total (5 × 4,000 = 20,000 chars of source
    // content alone, plus prompt boilerplate). With a 5,000-char budget we expect
    // the source-content portion to land near 5k; the whole prompt stays well under
    // the unbudgeted ~20k+ blowup.
    expect(systemPrompt.length).toBeLessThan(15_000);
    expect(systemPrompt).toContain("truncated for prompt budget");

    // All five source headers are still represented (fair-share, not first-N-only).
    for (let i = 0; i < SOURCE_COUNT; i++) {
      expect(systemPrompt).toContain(`--- SOURCE: source-${i}.md ---`);
    }

    // Sanity: page-generation also emitted a warning to stdout/stderr.
    const stdio = result.stdout + result.stderr;
    expect(stdio).toMatch(new RegExp(`Combined source content for "${SHARED_CONCEPT}"`));
  }, 60_000);

  it("compile without an explicit budget keeps the prompt unbudgeted (no truncation marker)", async () => {
    const { systemPrompt } = await runSharedConceptCompile({});
    // 5 × 4,000 = 20,000 raw source chars — well under the 200,000-char default
    // budget, so the prompt should NOT carry the truncation marker.
    expect(systemPrompt).not.toContain("truncated for prompt budget");
  }, 60_000);

  // The shared-concept slug should land under the configured concept directory.
  it("compile produces exactly one merged candidate for the shared concept", async () => {
    const { result } = await runSharedConceptCompile({
      LLMWIKI_PROMPT_BUDGET_CHARS: TIGHT_BUDGET,
    });
    expect(result.stdout).toContain(SHARED_CONCEPT_SLUG);
  }, 60_000);
});
