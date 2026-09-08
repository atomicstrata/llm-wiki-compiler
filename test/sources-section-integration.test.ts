/**
 * Exercises the Sources preference through the compiled CLI and incremental
 * pipeline. A removed CLI binding or missing modifier registration must fail
 * these tests even though the prompt helper still passes its unit tests.
 */
import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { mockClaudeEnv, stubCannedCompile, useAimockLifecycle } from "./fixtures/aimock-helper.js";
import { expectCLIExit, runCLI } from "./fixtures/run-cli.js";

const aimock = useAimockLifecycle("sources-section");
const sectionRequest = "Include a ## Sources section";

describe("Sources preference through the CLI", () => {
  it.each([false, true])("recompiles when setting and clearing the preference (review=%s)", async (review) => {
    const handle = await aimock.start();
    stubCannedCompile(handle, "Sources Concept");
    const cwd = await aimock.makeWorkspace("# Source\n\nSource attribution matters.\n");
    const env = { ...mockClaudeEnv(handle), LLMWIKI_SOURCES_SECTION: "", LLMWIKI_OUTPUT_LANG: "" };
    const args = review ? ["compile", "--review"] : ["compile"];
    const selections = [[], ["--no-sources-section"], []];
    for (const [index, flags] of selections.entries()) {
      const before = handle.mock.getRequests().length;
      expectCLIExit(await runCLI([...args, ...flags], cwd, env), 0);
      const requests = handle.mock.getRequests().slice(before);
      expect(requests.length).toBeGreaterThan(0);
      const transmitted = JSON.stringify(requests);
      expect(transmitted.includes(sectionRequest)).toBe(index !== 1);
      if (!review) {
        const page = await readFile(path.join(cwd, "wiki/concepts/sources-concept.md"), "utf8");
        expect(page.includes("sourcesSection=off")).toBe(index === 1);
      }
    }
    const before = handle.mock.getRequests().length;
    expectCLIExit(await runCLI(args, cwd, env), 0);
    expect(handle.mock.getRequests().length).toBe(before);
  }, 180_000);

  it("honours an environment opt-out without a CLI flag", async () => {
    const handle = await aimock.start();
    stubCannedCompile(handle, "Sources Concept");
    const cwd = await aimock.makeWorkspace("# Source\n\nEnvironment preference.\n");
    const env = { ...mockClaudeEnv(handle), LLMWIKI_SOURCES_SECTION: "OFF" };
    expectCLIExit(await runCLI(["compile"], cwd, env), 0);
    expect(handle.mock.getRequests().length).toBeGreaterThan(0);
    expect(JSON.stringify(handle.mock.getRequests())).not.toContain(sectionRequest);
    const page = await readFile(path.join(cwd, "wiki/concepts/sources-concept.md"), "utf8");
    expect(page).toContain("sourcesSection=off");
  }, 180_000);
});
