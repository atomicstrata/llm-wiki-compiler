/** Per-test working directory and console isolation for in-process CLI commands. */
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { beforeEach, afterEach, vi } from "vitest";

/** Register lifecycle hooks before caller setup, and expose the current project root. */
export function useCommandProject(prefix: string): { root: string } {
  const project = { root: "" };
  let originalCwd = "";
  beforeEach(async () => {
    project.root = await mkdtemp(path.join(os.tmpdir(), prefix));
    originalCwd = process.cwd();
    process.chdir(project.root);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    process.exitCode = 0;
  });
  afterEach(async () => {
    process.chdir(originalCwd);
    await rm(project.root, { recursive: true, force: true });
    vi.restoreAllMocks();
    process.exitCode = 0;
  });
  return project;
}
