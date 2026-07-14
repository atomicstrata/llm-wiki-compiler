/**
 * Subprocess integration tests for `llmwiki status`.
 *
 * Exercises the built CLI end-to-end so the documented surface is pinned at
 * the level real users hit: the command exists, needs no provider
 * credentials, prints a human summary by default, and emits the WikiStatus
 * JSON envelope with --json.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runCLI, expectCLIExit } from "../fixtures/run-cli.js";

/** Env that guarantees no provider credentials leak in from the host. */
const NO_CREDS = {
  ANTHROPIC_API_KEY: "",
  ANTHROPIC_AUTH_TOKEN: "",
  OPENAI_API_KEY: "",
  LLMWIKI_PROVIDER: "",
};

describe("llmwiki status (CLI)", () => {
  let cwd = "";

  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "llmwiki-status-cli-"));
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it("status --help shows the command and the --json flag", async () => {
    const result = await runCLI(["status", "--help"], cwd);
    expectCLIExit(result, 0);
    expect(result.stdout).toContain("--json");
    expect(result.stdout).toContain("state health");
  });

  it("runs credential-free on an empty project and reports missing state", async () => {
    const result = await runCLI(["status"], cwd, NO_CREDS);
    expectCLIExit(result, 0);
    expect(result.stdout).toMatch(/State: missing/);
  });

  it("--json emits a parseable WikiStatus envelope for a compiled project", async () => {
    await mkdir(path.join(cwd, "sources"), { recursive: true });
    await mkdir(path.join(cwd, "wiki", "concepts"), { recursive: true });
    await mkdir(path.join(cwd, ".llmwiki"), { recursive: true });
    await writeFile(path.join(cwd, "sources", "a.md"), "# A\n\nBody.", "utf-8");
    await writeFile(
      path.join(cwd, "wiki", "concepts", "topic.md"),
      "---\ntitle: Topic\nsummary: S.\nsources: [a.md]\n---\n\nBody.\n",
      "utf-8",
    );
    await writeFile(
      path.join(cwd, ".llmwiki", "state.json"),
      JSON.stringify({ version: 1, indexHash: "", sources: {} }),
      "utf-8",
    );

    const result = await runCLI(["status", "--json"], cwd, NO_CREDS);

    expectCLIExit(result, 0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.pages.concepts).toBe(1);
    expect(parsed.stateStatus).toBe("ok");
    expect(typeof parsed.pendingChangesCount).toBe("number");
  });
});
