/**
 * @file test/workflow-projection-confine.test.ts
 * @description Defensive confinement test for the projection write path. Even
 * though the profile validator confines `projectionFile` under `wiki/` at load,
 * `writeProjection` RE-CONFINES the resolved real path AND routes the write through
 * the confined `atomicWrite` (which owns the parent-dir creation + symlink
 * hardening — there is NO raw `mkdir`). This file unit-tests the re-confinement
 * helper directly (a target under `wiki/` resolves; an escaping target is
 * rejected) AND exercises the REAL write path: a `projectionFile` whose parent dir
 * is a SYMLINK to an out-of-tree dir fails CLOSED, creating nothing at the victim.
 */

import { describe, it, expect } from "vitest";
import { mkdir, symlink, readdir } from "node:fs/promises";
import path from "node:path";
import { makeTempRoot } from "./fixtures/temp-root.js";
import { makeOutsideDir } from "./fixtures/outside-dir.js";
import {
  buildWorkflowProfile,
  installWorkflowProfile,
  ADAPT_BUILD_STAGES as STAGES,
} from "./fixtures/workflow-profile.js";
import { startWorkflow } from "../src/workflows/start.js";
import { confineProjectionPath, writeProjection } from "../src/workflows/projection.js";
import type { ProfilePack } from "../src/profile/types.js";

describe("confineProjectionPath", () => {
  it("resolves a projectionFile under wiki/", async () => {
    const root = await makeTempRoot("wf-proj-confine-ok");
    const resolved = await confineProjectionPath(root, "wiki/outputs/workflows/build.md");
    expect(resolved).toBe(path.join(await realRoot(root), "wiki/outputs/workflows/build.md"));
  });

  it("rejects a projectionFile that escapes wiki/", async () => {
    const root = await makeTempRoot("wf-proj-confine-escape");
    await expect(confineProjectionPath(root, "outputs/escape.md")).rejects.toThrow(/escapes/);
    await expect(confineProjectionPath(root, "../escape.md")).rejects.toThrow();
  });
});

describe("writeProjection — symlinked projection parent fails closed", () => {
  it("refuses to write through a symlinked parent and creates nothing out-of-tree", async () => {
    const root = await makeTempRoot("wf-proj-symlink");
    const victim = await makeOutsideDir();
    // Plant `wiki/outputs` as a symlink to an out-of-tree dir; the projection
    // target `wiki/outputs/workflows/build.md` would resolve THROUGH it.
    await mkdir(path.join(root, "wiki"), { recursive: true });
    await symlink(victim, path.join(root, "wiki/outputs"));
    const pack = buildWorkflowProfile(STAGES) as ProfilePack;
    pack.workflows!.build.projectionFile = "wiki/outputs/workflows/build.md";
    await installWorkflowProfile(root, pack);
    const run = await startWorkflow(root, "build", {});

    const result = await writeProjection(root, run.runId);
    expect(result.status).toBe("unavailable");
    // The victim dir is untouched — no `workflows/` dir or `build.md` was created.
    expect(await readdir(victim)).toEqual([]);
  });
});

/** Realpath the root (macOS /var → /private/var) so the expected path matches. */
async function realRoot(root: string): Promise<string> {
  const { realpath } = await import("node:fs/promises");
  return realpath(root);
}
