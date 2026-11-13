/**
 * Shared temp-workspace lifecycle for ingest CLI integration tests.
 *
 * Multiple ingest tests need the same pattern: spin up a temp dir, drop
 * a fixture file inside it, run `llmwiki ingest` against the path, and
 * tear down the temp dir at the end of the test. Centralising the
 * tempDirs array + afterEach cleanup avoids the duplicate-code findings
 * fallow's CI mode flagged when the boilerplate appeared in two
 * sibling test files.
 */

import { mkdtemp, rm, writeFile } from "fs/promises";
import path from "path";
import { tmpdir } from "os";
import { afterEach } from "bun:test";

/** Public API of the workspace lifecycle returned by useIngestWorkspaces. */
export interface IngestWorkspaceContext {
  /**
   * Create a temp workspace and write a single fixture file at the given
   * name relative to the workspace root.
   */
  makeWorkspace(
    fixtureName: string,
    content: string,
  ): Promise<{ cwd: string; fixturePath: string }>;
  /** Create an empty temp workspace; caller is responsible for populating it. */
  makeEmptyWorkspace(): Promise<string>;
}

/**
 * Vitest composable: registers an afterEach that removes any workspace
 * created via the returned helpers. Each caller gets its own tempDirs
 * array, so concurrent test files do not interfere.
 *
 * @param prefix - Inserted into the temp-dir name for easier debugging.
 */
export function useIngestWorkspaces(prefix: string): IngestWorkspaceContext {
  const tempDirs: string[] = [];
  afterEach(async () => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) await rm(dir, { recursive: true, force: true });
    }
  });
  return {
    async makeWorkspace(fixtureName, content) {
      const cwd = await mkdtemp(path.join(tmpdir(), `llmwiki-${prefix}-`));
      tempDirs.push(cwd);
      const fixturePath = path.join(cwd, fixtureName);
      await writeFile(fixturePath, content, "utf-8");
      return { cwd, fixturePath };
    },
    async makeEmptyWorkspace() {
      const cwd = await mkdtemp(path.join(tmpdir(), `llmwiki-${prefix}-`));
      tempDirs.push(cwd);
      return cwd;
    },
  };
}
