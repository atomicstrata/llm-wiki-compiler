/**
 * @file test/fixtures/project-files.ts
 * @description Helpers for asserting exact project file trees in tests.
 */
import { readdir } from "node:fs/promises";
import path from "node:path";

/** Return every file under a project root as sorted, forward-slash relative paths. */
export async function listProjectFiles(root: string): Promise<string[]> {
  const files: string[] = [];

  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        files.push(path.relative(root, full).split(path.sep).join("/"));
      }
    }
  }

  await walk(root);
  return files.sort();
}
