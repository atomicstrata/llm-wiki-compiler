/**
 * Stage timing through the real built CLI, offline against the aimock provider:
 * with `LLMWIKI_STAGE_TIMING_FILE` set, `compile` and `query` append their fixed
 * stage records and nothing drawn from the corpus, prompts, answers, or paths;
 * with it unset, no log appears.
 */
import { describe, expect, it } from "vitest";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { mockClaudeEnv, useAimockLifecycle } from "./fixtures/aimock-helper.js";
import { runCLI, expectCLIExit } from "./fixtures/run-cli.js";

const aimock = useAimockLifecycle("stage-timing");
const SOURCE_TEXT = "Distinctive corpus sentence about Zyxwv lattices.";
const CONCEPT = "Zyxwv Lattice";

/** Start the mock with one extracted concept and a canned body/answer. */
async function startMock() {
  const handle = await aimock.start();
  handle.mock.onToolCall("extract_concepts", { toolCalls: [{ name: "extract_concepts", arguments: {
    concepts: [{ concept: CONCEPT, summary: "Canned summary.", is_new: true, tags: [], confidence: 0.9 }],
  } }] });
  handle.mock.onToolCall("select_pages", {
    toolCalls: [{ name: "select_pages", arguments: { pages: ["concepts/zyxwv-lattice"], reasoning: "Canned selection." } }],
  });
  handle.mock.onMessage(/.*/, { content: `Canned ${CONCEPT} body and answer.` });
  return handle;
}

/** Stage names recorded in the log, in order. */
async function stages(file: string): Promise<string[]> {
  return (await readFile(file, "utf8")).trim().split("\n").map((line) => (JSON.parse(line) as { stage: string }).stage);
}

describe("stage timing through the CLI", () => {
  it("records compile and query stages without any corpus or answer content", async () => {
    const handle = await startMock();
    const cwd = await aimock.makeWorkspace(`# Source\n\n${SOURCE_TEXT}\n`);
    const file = path.join(cwd, "timing.jsonl");
    const env = { ...mockClaudeEnv(handle), LLMWIKI_STAGE_TIMING_FILE: file };
    expectCLIExit(await runCLI(["compile"], cwd, env), 0);
    expect(await stages(file)).toEqual(expect.arrayContaining([
      "compile.detect-changes", "compile.extraction", "compile.page-generation", "compile.finalize",
    ]));
    expectCLIExit(await runCLI(["query", "What is a Zyxwv lattice?"], cwd, env), 0);
    expect(await stages(file)).toEqual(expect.arrayContaining(["query.retrieval", "query.answer"]));
    const log = await readFile(file, "utf8");
    for (const secret of [SOURCE_TEXT, "Zyxwv", "Canned", cwd, "mock-key-for-aimock"]) expect(log).not.toContain(secret);
  }, 60_000);

  it("writes no log when the variable is unset", async () => {
    const handle = await startMock();
    const cwd = await aimock.makeWorkspace(`# Source\n\n${SOURCE_TEXT}\n`);
    expectCLIExit(await runCLI(["compile"], cwd, mockClaudeEnv(handle)), 0);
    expect((await readdir(cwd)).filter((name) => name.endsWith(".jsonl"))).toEqual([]);
  }, 60_000);
});
