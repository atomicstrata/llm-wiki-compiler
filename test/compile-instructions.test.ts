/**
 * Exercises explicit project instructions through the real CLI. Dropping the
 * flag-to-policy binding must fail the prompt and incremental-state assertions;
 * instruction files are never discovered implicitly.
 */
import { describe, expect, it } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { mockClaudeEnv, stubCannedCompile, useAimockLifecycle } from "./fixtures/aimock-helper.js";
import { expectCLIExit, runCLI } from "./fixtures/run-cli.js";

const aimock = useAimockLifecycle("compile-instructions");

describe("compile instruction files", () => {
  it.each([false, true])("applies changed instructions and clears them on omission (review=%s)", async (review) => {
    const handle = await aimock.start();
    stubCannedCompile(handle, "Policy Concept");
    const cwd = await aimock.makeWorkspace("# Source\n\nA documented concept.\n");
    const env = { ...mockClaudeEnv(handle), LLMWIKI_OUTPUT_LANG: "", LLMWIKI_SOURCES_SECTION: "" };
    const args = review ? ["compile", "--review"] : ["compile"];
    for (const policy of ["Prefer marine terminology.", "Prefer botanical terminology.", undefined]) {
      await writeFile(path.join(cwd, "SOUL.md"), policy ?? "Do not discover this automatically.");
      const before = handle.mock.getRequests().length;
      const flags = policy ? ["--instructions", "SOUL.md"] : [];
      const result = await runCLI([...args, ...flags], cwd, env);
      expectCLIExit(result, 0);
      expect(handle.mock.getRequests().length).toBeGreaterThan(before);
      const transmitted = JSON.stringify(handle.mock.getRequests().slice(before));
      if (policy) expect(transmitted).toContain(policy);
      else expect(transmitted).not.toContain("Do not discover this automatically.");
      if (!review) {
        const page = await readFile(path.join(cwd, "wiki/concepts/policy-concept.md"), "utf8");
        expect(page.includes("policy=")).toBe(Boolean(policy));
      }
      const after = handle.mock.getRequests().length;
      expectCLIExit(await runCLI([...args, ...flags], cwd, env), 0);
      expect(handle.mock.getRequests().length).toBe(after);
    }
  }, 180_000);

  it.each(["missing", "oversized"])("rejects a %s instruction file before contacting a provider", async (kind) => {
    const handle = await aimock.start();
    const cwd = await aimock.makeWorkspace("# Source\n\nDo not compile.\n");
    if (kind === "oversized") await writeFile(path.join(cwd, "policy.md"), "x".repeat(65_537));
    const result = await runCLI(["compile", "--instructions", "policy.md"], cwd, mockClaudeEnv(handle));
    expectCLIExit(result, 1);
    expect(result.stderr).toMatch(/instruction/i);
    expect(result.stderr).not.toContain("unknown option");
    expect(handle.mock.getRequests()).toHaveLength(0);
  });
});
