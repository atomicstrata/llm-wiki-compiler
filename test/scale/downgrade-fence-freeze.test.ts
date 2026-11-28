/**
 * @file test/scale/downgrade-fence-freeze.test.ts
 * @description Witness that a content change made UNDER the fence of an
 * indexed scale-down is refused before anything is moved.
 *
 * The fence stops this build's writers, not an editor. A scale-down is killed
 * after staging (the fence and a complete staging attempt exist, nothing is
 * installed), a source file is then edited by hand, and the same plan is
 * applied again. The resume must refuse `scale_downgrade_stale_plan` while
 * the indexed stores are still in place, no prior file was retired, no
 * archive was recorded and the installed paths are exactly as they were.
 */

import { createHash } from "node:crypto";
import { appendFile, lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import { CASE_TIMEOUT_MS, crashAt, downgradeMode, ok, planFileFor, useDowngradeProjects } from "./downgrade-helpers.js";

const projects = useDowngradeProjects();

/** Capture identity and bytes of the installed graph file; a missing file fails the test. */
async function objectAt(file: string): Promise<{ ino: number; size: number; sha256: string }> {
  const stat = await lstat(file);
  const sha256 = createHash("sha256").update(await readFile(file)).digest("hex");
  return { ino: stat.ino, size: stat.size, sha256 };
}

describe("a frozen file edited under the scale-down fence", () => {
  it("refuses the resume before any move, with the indexed stores in place", async () => {
    const root = await projects.build("build");
    await ok("preview", root, "local-standard", "100", planFileFor(root));
    await crashAt(root, planFileFor(root), "after-stage");
    const installedPath = path.join(root, "wiki", "graph", "events.jsonl");
    const before = await objectAt(installedPath);
    await appendFile(path.join(root, "sources", "src-00000.md"), "\nAn edit made outside llmwiki.\n");

    const refused = await downgradeMode("apply", root, planFileFor(root));

    expect(refused.outcome).toBe("scale_downgrade_stale_plan");
    expect(await readdir(path.join(root, ".llmwiki"))).toEqual(expect.arrayContaining(["indexed", "scale-downgrade.json"]));
    const [evidence] = await readdir(path.join(root, ".llmwiki", "scale-downgrade"));
    const kept = await readdir(path.join(root, ".llmwiki", "scale-downgrade", evidence!));
    expect(kept).toEqual(expect.arrayContaining(["plan.json", "attempt-1"]));
    for (const moved of ["prior", "archive.json", "indexed", "receipt.json"]) expect(kept).not.toContain(moved);
    expect(await objectAt(installedPath)).toEqual(before);
  }, CASE_TIMEOUT_MS);
});
