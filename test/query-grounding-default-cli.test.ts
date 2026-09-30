/**
 * @file test/query-grounding-default-cli.test.ts
 * @description Built-CLI witness for the embedding fallback default: with a live
 * page-level store but no embedding credentials, `llmwiki query` answers through
 * fallback selection instead of failing, and prints the `embedding-degraded`
 * warning so the fallback is visible in the terminal. Losing either the default
 * or the CLI's warning output must fail this.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { mockClaudeEnv, useAimockLifecycle } from "./fixtures/aimock-helper.js";
import { expectCLIExit, runCLI } from "./fixtures/run-cli.js";
import { pageEntryOf, writePageStore } from "./fixtures/typed-grounding.js";
import { writePage } from "./fixtures/write-page.js";

const aimock = useAimockLifecycle("query-grounding-default");
const ANSWER = "Alpha is the first concept.";
const savedProvider = process.env.LLMWIKI_PROVIDER;

afterEach(() => {
  if (savedProvider === undefined) delete process.env.LLMWIKI_PROVIDER;
  else process.env.LLMWIKI_PROVIDER = savedProvider;
});

/** A compiled wiki with one concept and a page store stamped for the Anthropic provider's embedder. */
async function workspace(): Promise<string> {
  const root = await aimock.makeWorkspace("# Source\n");
  await mkdir(path.join(root, "wiki", "concepts"), { recursive: true });
  await writeFile(path.join(root, "wiki", "index.md"), "# Index\n");
  await writePage(path.join(root, "wiki/concepts"), "alpha", { title: "Alpha", summary: "a" }, "ALPHA_BODY fact.");
  await mkdir(path.join(root, ".llmwiki"), { recursive: true });
  process.env.LLMWIKI_PROVIDER = "anthropic";
  await writePageStore(root, [pageEntryOf("concepts/alpha", "Alpha", "a", [1, 0])]);
  return root;
}

it("answers through fallback and prints the embedding-degraded warning", async () => {
  const handle = await aimock.start();
  handle.mock.onToolCall("select_pages", {
    toolCalls: [{ name: "select_pages", arguments: { pages: ["concepts/alpha"], reasoning: "Selected alpha" } }],
  });
  handle.mock.onMessage(/.*/, { content: ANSWER });
  const result = await runCLI(["query", "Explain alpha"], await workspace(), { ...mockClaudeEnv(handle), VOYAGE_API_KEY: "" });
  expectCLIExit(result, 0);
  expect(result.stdout).toContain(ANSWER);
  // Only the page-level catch emits this text, so it also pins that the store
  // loaded and the failing embedder was reached.
  expect(result.stdout).toMatch(/Page-level embedding failed \(.+\); degraded to LLM\/index fallback selection\./);
  expect(result.stdout.indexOf("degraded to LLM/index")).toBeGreaterThan(result.stdout.indexOf(ANSWER));
}, 30_000);
