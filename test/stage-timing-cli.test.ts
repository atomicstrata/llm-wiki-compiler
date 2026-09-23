/**
 * Stage timing through the real built CLI, offline against the aimock provider:
 * with `LLMWIKI_STAGE_TIMING_FILE` set, `compile` and `query` append their fixed
 * stage records and nothing drawn from the corpus, prompts, answers, or paths;
 * with it unset, no log appears.
 */
import { describe, expect, it } from "vitest";
import { readdir, readFile, symlink, writeFile } from "node:fs/promises";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { mockClaudeEnv, useAimockLifecycle } from "./fixtures/aimock-helper.js";
import { CLI, runCLI, expectCLIExit } from "./fixtures/run-cli.js";

const aimock = useAimockLifecycle("stage-timing");
const SOURCE_TEXT = "Distinctive corpus sentence about Zyxwv lattices.";
const CONCEPT = "Zyxwv Lattice";
/** A hung CLI must fail this test, not the whole run: bound the subprocess. */
const HANG_BOUND_MS = 20_000;
const execBounded = promisify(execFile);

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
    const finalizes = (await stages(file)).filter((stage) => stage === "compile.finalize").length;
    expectCLIExit(await runCLI(["compile"], cwd, env), 0);
    // The nothing-changed path finalizes too, so it records its own finalize stage.
    expect((await stages(file)).filter((stage) => stage === "compile.finalize")).toHaveLength(finalizes + 1);
    expectCLIExit(await runCLI(["query", "What is a Zyxwv lattice?"], cwd, env), 0);
    expect(await stages(file)).toEqual(expect.arrayContaining(["query.retrieval", "query.answer"]));
    const log = await readFile(file, "utf8");
    for (const secret of [SOURCE_TEXT, "Zyxwv", "Canned", cwd, "mock-key-for-aimock"]) expect(log).not.toContain(secret);
  }, 60_000);

  it.runIf(process.platform !== "win32")("finishes compile promptly when the log path is a FIFO nobody reads", async () => {
    const handle = await startMock();
    const cwd = await aimock.makeWorkspace(`# Source\n\n${SOURCE_TEXT}\n`);
    const fifo = path.join(cwd, "timing.fifo");
    execFileSync("mkfifo", [fifo]);
    const env = { ...process.env, ...mockClaudeEnv(handle), LLMWIKI_STAGE_TIMING_FILE: fifo };
    // Before the fix the first stage's append blocked forever opening the FIFO,
    // holding the project lock; the bound turns that hang into a failure here.
    const run = await execBounded(process.execPath, [CLI, "compile"], { cwd, env, timeout: HANG_BOUND_MS, killSignal: "SIGKILL" });
    expect(run.stderr).not.toContain("Error");
    expect((await readdir(path.join(cwd, "wiki", "concepts"))).length).toBeGreaterThan(0);
  }, 60_000);

  it("skips a log path that is a symlink instead of following it", async () => {
    const handle = await startMock();
    const cwd = await aimock.makeWorkspace(`# Source\n\n${SOURCE_TEXT}\n`);
    const target = path.join(cwd, "real-target.jsonl");
    await writeFile(target, "");
    const link = path.join(cwd, "timing-link.jsonl");
    await symlink(target, link);
    expectCLIExit(await runCLI(["compile"], cwd, { ...mockClaudeEnv(handle), LLMWIKI_STAGE_TIMING_FILE: link }), 0);
    expect(await readFile(target, "utf8")).toBe("");
  }, 60_000);

  it("writes no log when the variable is unset", async () => {
    const handle = await startMock();
    const cwd = await aimock.makeWorkspace(`# Source\n\n${SOURCE_TEXT}\n`);
    expectCLIExit(await runCLI(["compile"], cwd, mockClaudeEnv(handle)), 0);
    expect((await readdir(cwd)).filter((name) => name.endsWith(".jsonl"))).toEqual([]);
  }, 60_000);
});
