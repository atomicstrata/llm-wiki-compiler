/**
 * Drive the real CLI against a local mock provider: opting in accepts empty
 * extraction, switching modes regenerates unchanged sources, and refresh
 * preserves the chosen mode without widening its source selection.
 */
import { describe, expect, it } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { readState } from "../src/utils/state.js";
import { findSystemPromptByUserMessage, mockClaudeEnv, stubCannedCompile, useAimockLifecycle } from "./fixtures/aimock-helper.js";
import { expectCLIExit, runCLI } from "./fixtures/run-cli.js";

const aimock = useAimockLifecycle("no-pages-limit");
const FLAG = "--no-pages-limit";

describe("compile --no-pages-limit", () => {
  it.each([false, true])("treats empty extraction as success only when selected: %s", enabled => {
    return checkEmptyResult(enabled);
  });

  it("recompiles unchanged sources when the flag is enabled or removed", async () => {
    const handle = await aimock.start();
    stubCannedCompile(handle, "Documented Topic");
    const cwd = await aimock.makeWorkspace("# Notes\n\nDocumented facts.\n");
    const env = { ...mockClaudeEnv(handle), LLMWIKI_EMBEDDINGS: "off" };
    for (const flags of [[], [FLAG], []]) {
      const before = handle.mock.getRequests().length;
      expectCLIExit(await runCLI(["compile", ...flags], cwd, env), 0);
      expect(handle.mock.getRequests().length).toBeGreaterThan(before);
      const page = await readFile(path.join(cwd, "wiki/concepts/documented-topic.md"), "utf8");
      expect(page.includes("pagesLimit=off")).toBe(flags.length > 0);
    }
    const before = handle.mock.getRequests().length;
    expectCLIExit(await runCLI(["compile"], cwd, env), 0);
    expect(handle.mock.getRequests()).toHaveLength(before);
  });

  it("forwards the mode to refresh while keeping unrelated new sources out of scope", async () => {
    const handle = await aimock.start();
    stubCannedCompile(handle, "Documented Topic");
    const cwd = await aimock.makeWorkspace("# Original\n\nInitial facts.\n");
    const env = { ...mockClaudeEnv(handle), LLMWIKI_EMBEDDINGS: "off" };
    expectCLIExit(await runCLI(["compile"], cwd, env), 0);
    await writeFile(path.join(cwd, "sources/intro.md"), "# Updated\n\nRevised facts.\n");
    await writeFile(path.join(cwd, "sources/unrelated.md"), "Unrelated new source.");
    expectCLIExit(await runCLI(["refresh", "--stale", FLAG], cwd, env), 0);
    const page = await readFile(path.join(cwd, "wiki/concepts/documented-topic.md"), "utf8");
    expect(page).toContain("pagesLimit=off");
    const state = await readState(cwd);
    expect(state.sources["unrelated.md"]).toBeUndefined();
    expect(state.promptModifiers).toBe("");
  });
});

/** Exercise both the failure/retry default and the explicit empty-success path. */
async function checkEmptyResult(enabled: boolean): Promise<void> {
  const handle = await aimock.start();
  handle.mock.onToolCall("extract_concepts", {
    toolCalls: [{ name: "extract_concepts", arguments: { concepts: [] } }],
  });
  const cwd = await aimock.makeWorkspace("# Note\n\nNo supported topics.\n");
  const env = { ...mockClaudeEnv(handle), LLMWIKI_EMBEDDINGS: "off" };
  const args = enabled ? ["compile", FLAG] : ["compile"];
  const first = await runCLI(args, cwd, env);
  expectCLIExit(first, 0);
  expect(first.stdout.includes("no concepts — will retry")).toBe(!enabled);
  const prompt = findSystemPromptByUserMessage(handle, message => message.includes("Extract the key concepts"));
  expect(prompt?.includes("identify 3-8")).toBe(!enabled);
  const state = await readState(cwd);
  expect(Boolean(state.sources["intro.md"].hash)).toBe(enabled);
  const before = handle.mock.getRequests().length;
  const second = await runCLI(args, cwd, env);
  expectCLIExit(second, 0);
  expect(handle.mock.getRequests().length > before).toBe(!enabled);
}
