/**
 * Quickstart forwards the --concurrency option into its compile step.
 *
 * Quickstart is the first-run ingest-then-compile wrapper, so it must honour
 * the same concurrency cap as `compile`/`refresh`/`watch`. This mocks
 * compileAndReport to capture the CompileOptions it receives while running a
 * real local-file ingest (no provider calls reach the network).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm } from "fs/promises";
import { tmpdir } from "os";
import path from "path";

const compileSpy = vi.hoisted(() => vi.fn());
vi.mock("../src/compiler/index.js", async (importActual) => ({
  ...(await importActual<typeof import("../src/compiler/index.js")>()),
  compileAndReport: compileSpy,
}));

import quickstartCommand from "../src/commands/quickstart.js";

describe("quickstart concurrency forwarding", () => {
  let cwd = "";
  let savedCwd = "";

  beforeEach(async () => {
    process.env.LLMWIKI_PROVIDER = "anthropic";
    process.env.ANTHROPIC_API_KEY = "test-key";
    delete process.env.LLMWIKI_COMPILE_CONCURRENCY;
    cwd = await mkdtemp(path.join(tmpdir(), "llmwiki-qs-conc-"));
    savedCwd = process.cwd();
    process.chdir(cwd);
    compileSpy.mockResolvedValue({
      compiled: 1, skipped: 0, deleted: 0, concepts: [], pages: [], errors: [],
    });
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(async () => {
    process.chdir(savedCwd);
    vi.restoreAllMocks();
    compileSpy.mockReset();
    delete process.env.LLMWIKI_PROVIDER;
    delete process.env.ANTHROPIC_API_KEY;
    await rm(cwd, { recursive: true, force: true });
  });

  it("passes the concurrency option through to compileAndReport", async () => {
    const src = path.join(cwd, "note.md");
    await writeFile(src, "# Note\n\nA local source for quickstart.\n", "utf-8");

    await quickstartCommand(src, { concurrency: 7, json: true, open: false });

    expect(compileSpy).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ concurrency: 7 }),
    );
  });
});
