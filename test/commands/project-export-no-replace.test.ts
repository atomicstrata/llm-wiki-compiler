/**
 * @file test/commands/project-export-no-replace.test.ts
 * @description Regresses replacement of an occupied export directory name.
 */

import { expect, it } from "bun:test";
import { lstat, mkdtemp, readlink, rm, symlink } from "node:fs/promises";
import path from "node:path";
import { exportToDirectory } from "../../src/commands/project/export-command.js";
import type { ExportItem, WikiProject } from "../../src/portable/project/api.js";

/** A completed empty export stream that isolates final-name handling. */
async function* completed(): AsyncGenerator<ExportItem> {
  yield { kind: "completed", count: 0 };
}

it("preserves an existing dangling symlink at the export target", async () => {
  const root = await mkdtemp(path.join(process.env.TMPDIR!, "project-export-"));
  const out = path.join(root, "wiki");
  const target = path.join(root, "missing");
  try {
    await symlink(target, out);
    const project = { export: completed } as unknown as WikiProject;
    await expect(exportToDirectory(project, out)).rejects.toThrow("already exists");
    expect((await lstat(out)).isSymbolicLink()).toBe(true);
    expect(await readlink(out)).toBe(target);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
