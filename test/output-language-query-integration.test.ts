/**
 * CLI integration test for #37 query path.
 *
 * Companion to test/output-language-integration.test.ts which only
 * exercises compile. Codex flagged that query --lang and the answer
 * system prompt path lacked subprocess coverage. This test stages a
 * minimal wiki, stubs both the page-selection tool call and the answer
 * generation, runs `query --lang Spanish` via the CLI subprocess, and
 * asserts the directive lands in the system prompt aimock observed for
 * the answer call.
 */

import { describe, it, expect } from "vitest";
import { mkdir, writeFile } from "fs/promises";
import path from "path";
import {
  findSystemPromptByUserMessage,
  mockClaudeEnv,
  useAimockLifecycle,
  type MockClaudeHandle,
} from "./fixtures/aimock-helper.js";
import { runCLI, expectCLIExit } from "./fixtures/run-cli.js";

const aimock = useAimockLifecycle("output-language-query");

const PAGE_SLUG = "lang-test-page";
/** Qualified pageId the embeddings-unavailable fallback selector echoes for the pick. */
const PAGE_ID = `concepts/${PAGE_SLUG}`;
const PAGE_TITLE = "Lang Test Page";
const ANSWER_TEXT = "Stubbed answer body for the lang test.";

/** Stage a workspace with a wiki/index.md and one concept page. */
async function makeQueryWorkspace(): Promise<string> {
  const cwd = await aimock.makeWorkspace("# placeholder\n", "placeholder.md");
  const conceptsDir = path.join(cwd, "wiki", "concepts");
  await mkdir(conceptsDir, { recursive: true });
  await writeFile(
    path.join(conceptsDir, `${PAGE_SLUG}.md`),
    "---\n" +
      `title: "${PAGE_TITLE}"\n` +
      'summary: "Page used by the query --lang integration test."\n' +
      "sources: []\n" +
      "---\n\n" +
      "Body content for the lang test page.\n",
    "utf-8",
  );
  await mkdir(path.join(cwd, "wiki"), { recursive: true });
  await writeFile(
    path.join(cwd, "wiki", "index.md"),
    `# Wiki\n\n- **${PAGE_SLUG}**: ${PAGE_TITLE} — Page used by the query --lang integration test.\n`,
    "utf-8",
  );
  return cwd;
}

/** Stub the two LLM calls query makes: page selection, then answer generation. */
function stubQueryResponses(handle: MockClaudeHandle): void {
  handle.mock.onToolCall("select_pages", {
    toolCalls: [
      {
        name: "select_pages",
        arguments: {
          pages: [PAGE_ID],
          reasoning: "Stubbed selection for the lang test.",
        },
      },
    ],
  });
  handle.mock.onMessage(/.*/, { content: ANSWER_TEXT });
}

/**
 * Pull the system prompt for the answer-generation request out of aimock's
 * recording. The answer-generation request includes "Relevant wiki pages:"
 * in the user message; the page-selection request includes "Wiki Index:"
 * instead, so the predicate disambiguates the two.
 */
function findAnswerSystemPrompt(handle: MockClaudeHandle): string | null {
  return findSystemPromptByUserMessage(handle, (u) => u.includes("Relevant wiki pages:"));
}

describe("query --lang CLI integration (#37 query path)", () => {
  it("query --lang Spanish injects the directive into the answer system prompt", async () => {
    const handle = await aimock.start();
    stubQueryResponses(handle);
    const cwd = await makeQueryWorkspace();

    const result = await runCLI(
      ["query", "--lang", "Spanish", "What is the lang test?"],
      cwd,
      mockClaudeEnv(handle),
    );
    expectCLIExit(result, 0);
    expect(result.stdout).toContain(ANSWER_TEXT);

    const answerPrompt = findAnswerSystemPrompt(handle);
    expect(answerPrompt, "answer system prompt should be recorded").not.toBeNull();
    expect(answerPrompt).toContain("Write the output in Spanish.");
  }, 30_000);

  it("query without --lang leaves the answer system prompt unchanged", async () => {
    const handle = await aimock.start();
    stubQueryResponses(handle);
    const cwd = await makeQueryWorkspace();

    const result = await runCLI(
      ["query", "What is the lang test?"],
      cwd,
      mockClaudeEnv(handle),
    );
    expectCLIExit(result, 0);

    const answerPrompt = findAnswerSystemPrompt(handle);
    expect(answerPrompt).not.toBeNull();
    expect(answerPrompt).not.toContain("Write the output in");
  }, 30_000);
});
