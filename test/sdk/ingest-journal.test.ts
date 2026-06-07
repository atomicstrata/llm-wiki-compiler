/**
 * Regression test for the SDK ingest activity-journal contract.
 *
 * The #85 activity journal lives inside `ingestSource`, which the SDK's
 * `wiki.ingest()` calls. After the root-explicit ingest change, the journal
 * must be written under the bound project `root` (not `process.cwd()`) and
 * record a root-relative `Saved:` path. The CLI activity-log test cannot catch
 * a root-vs-cwd regression because there cwd === root; this test drives the SDK
 * with cwd deliberately set ELSEWHERE so the distinction is exercised.
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createWiki } from "../../src/sdk/wiki.js";
import { LOG_FILE } from "../../src/utils/constants.js";

describe("SDK ingest journaling is root-bound", () => {
  const originalCwd = process.cwd();
  afterEach(() => process.chdir(originalCwd));

  it("wiki.ingest writes log.md under root (not cwd) with a relative Saved path", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "wiki-jrnl-root-"));
    const foreignCwd = await mkdtemp(path.join(tmpdir(), "wiki-jrnl-cwd-"));
    const srcFile = path.join(root, "note.md");
    // >= MIN_SOURCE_CHARS (50) so ingest doesn't reject the content.
    await writeFile(srcFile, "Source body content for the SDK journaling regression test.", "utf-8");

    process.chdir(foreignCwd); // cwd != root — the case the CLI test can't cover
    await createWiki({ root }).ingest({ source: srcFile });

    // Journal lands under ROOT, never under the foreign cwd.
    expect(existsSync(path.join(root, LOG_FILE))).toBe(true);
    expect(existsSync(path.join(foreignCwd, LOG_FILE))).toBe(false);

    const log = await readFile(path.join(root, LOG_FILE), "utf-8");
    expect(log).toMatch(/^## \[.+Z\] ingest \| /m);
    expect(log).toContain("- Saved: sources/"); // root-relative, not an absolute path
    expect(log).not.toMatch(/- Saved: \//); // never an absolute /... path

    await rm(root, { recursive: true, force: true });
    await rm(foreignCwd, { recursive: true, force: true });
  });
});
