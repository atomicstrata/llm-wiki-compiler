/**
 * CLI integration tests for issue #35 — non-ASCII filenames must not be
 * silently dropped on ingest.
 *
 * Before the fix, `slugify` used `\w` without the `/u` flag, which only
 * matches `[A-Za-z0-9_]`. A title like `测试文档` slugified to the empty
 * string and ingest wrote `sources/.md` — a dotfile that's easy to miss
 * and that every subsequent CJK ingest would overwrite.
 *
 * These tests exercise the full CLI subprocess so the assertion is on
 * what the user actually observes after running `llmwiki ingest`.
 */

import { describe, it, expect } from "bun:test";
import path from "path";
import { readdir, writeFile } from "fs/promises";
import { runCLI, expectCLIExit, expectCLIFailure } from "./fixtures/run-cli.js";
import { useIngestWorkspaces } from "./fixtures/ingest-workspace.js";

const workspaces = useIngestWorkspaces("unicode-ingest");
const makeWorkspace = workspaces.makeWorkspace;

/**
 * Run a single non-ASCII ingest and assert the output filename in
 * sources/ matches what the Unicode-aware slugifier should produce. The
 * shared helper exists to keep the per-script test cases byte-light and
 * to avoid duplicate-code findings from the per-script smoke tests.
 */
async function expectIngestProducesUnicodeFilename(
  fixtureName: string,
  fixtureContent: string,
  expectedSourcesEntry: string,
): Promise<void> {
  const { cwd, fixturePath } = await makeWorkspace(fixtureName, fixtureContent);
  const result = await runCLI(["ingest", fixturePath], cwd);
  expectCLIExit(result, 0);
  const files = await readdir(path.join(cwd, "sources"));
  expect(files).toEqual([expectedSourcesEntry]);
}

describe("ingest — non-ASCII filenames (#35)", () => {
  it("CJK-named file is written under sources/ with a Unicode slug", async () => {
    // Exactly one file, named after the CJK title — not the silent ".md" dotfile.
    await expectIngestProducesUnicodeFilename(
      "测试文档.md",
      "# 测试\n\nThis is a Chinese-titled document.",
      "测试文档.md",
    );
  });

  it("Japanese-named file is written under sources/ with the original characters", async () => {
    await expectIngestProducesUnicodeFilename(
      "こんにちは.md",
      "# こんにちは\n\nA Japanese-titled document.",
      "こんにちは.md",
    );
  });

  it("two distinct CJK-named files do not collide on sources/.md", async () => {
    const { cwd: cwdA, fixturePath: pathA } = await makeWorkspace(
      "测试文档.md",
      "# A\n\nFirst Chinese doc.",
    );
    const result1 = await runCLI(["ingest", pathA], cwdA);
    expectCLIExit(result1, 0);

    // Re-use the workspace by writing a second CJK file alongside the first
    // and ingest it in the same cwd so we can assert they end up under
    // distinct filenames in the same sources/ directory.
    const pathB = path.join(cwdA, "另一个文档.md");
    await writeFile(pathB, "# B\n\nSecond Chinese doc.", "utf-8");
    const result2 = await runCLI(["ingest", pathB], cwdA);
    expectCLIExit(result2, 0);

    const files = (await readdir(path.join(cwdA, "sources"))).sort();
    expect(files).toEqual(["另一个文档.md", "测试文档.md"]);
  });

  it("title with no letters or numbers fails loudly with an actionable error", async () => {
    const { cwd, fixturePath } = await makeWorkspace(
      "🎉🎊.md",
      "# 🎉🎊\n\nA file whose title is purely emoji.",
    );

    const result = await runCLI(["ingest", fixturePath], cwd);
    expectCLIFailure(result);
    expect(result.stderr).toContain("Could not derive a filename");
    // Critically: no .md dotfile was written — the ingest aborted.
    let files: string[] = [];
    try {
      files = await readdir(path.join(cwd, "sources"));
    } catch {
      // sources/ may not have been created; either outcome is acceptable.
    }
    expect(files).not.toContain(".md");
  });
});
