/** Confirms the environment budget reaches both phases of the real compile CLI. */
import { expect, it } from "vitest";
import { useAimockLifecycle, mockOpenAIEnv, stubCannedCompile } from "./fixtures/aimock-helper.js";
import { expectCLIExit, runCLI } from "./fixtures/run-cli.js";

const aimock = useAimockLifecycle("compile-token-budget");

it("sends the selected output budget for concept extraction and page generation", async () => {
  const handle = await aimock.start();
  stubCannedCompile(handle, "Budget Concept");
  const cwd = await aimock.makeWorkspace("# A source\n\nAn important concept.\n");
  const result = await runCLI(["compile"], cwd, { ...mockOpenAIEnv(handle), LLMWIKI_MAX_TOKENS: "8192" });
  expectCLIExit(result, 0);
  // Anthropic normalization in aimock omits max_tokens; inspect the OpenAI wire shape.
  const requests = handle.mock.getRequests().filter((request) => request.path === "/v1/chat/completions");
  expect(requests.some((request) => Array.isArray(request.body?.tools))).toBe(true);
  expect(requests.some((request) => !request.body?.tools)).toBe(true);
  expect(requests.every((request) => request.body?.max_tokens === 8192)).toBe(true);
});
