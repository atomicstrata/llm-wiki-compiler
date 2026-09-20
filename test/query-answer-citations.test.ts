/**
 * Public SDK and query-pipeline tests keep provider traffic stubbed at the LLM
 * boundary while exercising real selection, admission, reports, and saving.
 */
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createWiki } from "../src/index.js";
import type { QueryResult } from "../src/index.js";
import { generateAnswer } from "../src/commands/query.js";
import { callClaude } from "../src/utils/llm.js";
import { parseFrontmatter } from "../src/utils/markdown.js";
import { useTempRoot } from "./fixtures/temp-root.js";
import { CITED_ANSWER, EXPECTED_REPORT, stageCitationWorkspace, citationWorkspaceBytes } from "./fixtures/query-answer-citations.js";

vi.mock("../src/utils/llm.js", () => ({ callClaude: vi.fn() }));
vi.mock("../src/utils/embeddings.js", async (original) => ({
  ...await original<typeof import("../src/utils/embeddings.js")>(),
  updateEmbeddingsLockedCore: vi.fn().mockResolvedValue(undefined),
}));
const ctx = useTempRoot();
beforeEach(async () => {
  vi.stubEnv("LLMWIKI_PROVIDER", "anthropic");
  vi.stubEnv("ANTHROPIC_API_KEY", "offline-test-key");
  await stageCitationWorkspace(ctx.dir);
});
afterEach(() => vi.unstubAllEnvs());

/** Stub only external LLM calls, preserving the streaming callback contract. */
function answerWith(answer: string, pages = ["concepts/alpha"]): void {
  vi.mocked(callClaude).mockReset().mockImplementation(async (options) => {
    if (options.tools) return JSON.stringify({ pages, reasoning: "Selected alpha" });
    options.onToken?.(answer);
    return answer;
  });
}

it("SDK returns serializable citations silently without changing page or candidate bytes", async () => {
  answerWith(CITED_ANSWER);
  const before = await citationWorkspaceBytes(ctx.dir);
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const result = await createWiki({ root: ctx.dir }).query("Explain [[title-only]]");
  expect(result.answerCitations).toEqual(EXPECTED_REPORT);
  expect(JSON.parse(JSON.stringify(result)).answerCitations).toEqual(EXPECTED_REPORT);
  expect(result.answer).toBe(CITED_ANSWER);
  expect(result.selectedPages).toEqual(["alpha"]);
  expect(result.pageIds).toEqual(["concepts/alpha"]);
  expect(await citationWorkspaceBytes(ctx.dir)).toEqual(before);
  expect(callClaude).toHaveBeenCalledTimes(2);
  expect(log).not.toHaveBeenCalled();
  expect(warn).not.toHaveBeenCalled();
});

it.each(["", "Plain answer.", "`[[summary-only]]`\r\n\r\nPlain answer."])(
  "always supplies an empty report when the answer has no recognized links: %s", async (answer) => {
    answerWith(answer);
    const result = await createWiki({ root: ctx.dir }).query("[[title-only]]");
    expect(result.answerCitations).toEqual({ version: 1, citations: [] });
    expect(result.answer).toBe(answer);
  },
);

it("supplies an empty report when selection yields no grounding and makes no answer request", async () => {
  answerWith("unused", []);
  const result = await createWiki({ root: ctx.dir }).query("No matches");
  expect(result.answer).toBe("");
  expect(result.answerCitations).toEqual({ version: 1, citations: [] });
  expect(callClaude).toHaveBeenCalledTimes(1);
});

it("reports the canonical leading-fence body while retaining streamed and saved bytes", async () => {
  const answer = "---\r\n[[Alpha]]\r\n---\r\n[[alpha|label]]";
  answerWith(answer);
  const streamed: string[] = [];
  const result = await generateAnswer(ctx.dir, "[[title-only]]", { save: true, onToken: (s) => streamed.push(s) });
  expect(streamed.join("")).toBe(answer);
  expect(result.answer).toBe(answer);
  expect(result.answerCitations?.citations).toEqual([
    { target: "alpha", status: "resolved", pageId: "concepts/alpha" },
  ]);
  const saved = await readFile(path.join(ctx.dir, `wiki/queries/${result.saved}.md`), "utf8");
  expect(parseFrontmatter(saved).body).toBe(`\n${answer}\n`);
});

it("keeps older QueryResult producers source-compatible", () => {
  const legacy: QueryResult = { answer: "", selectedPages: [], pageIds: [], refs: [], reasoning: "" };
  expect(legacy.answerCitations).toBeUndefined();
});
