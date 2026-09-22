/**
 * @file test/operation-bundles/projection-confinement.test.ts
 * @description Adversarial namespace tests for recipe-private projections.
 * Loader-equivalent lexical checks and adapter-time parent binding must both
 * reject paths that could write live or foreign authority state.
 */

import { createHash } from "node:crypto";
import path from "node:path";
import { lstat, mkdir, readdir, rename, symlink } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { MAX_PROJECTION_BYTES } from "../../src/operation-bundles/constants.js";
import { operationPaths } from "../../src/operation-bundles/paths.js";
import {
  observeProjection,
  projectionOutputPath,
  writeProjectionLocked,
  type ProjectionTarget,
} from "../../src/operation-bundles/projection-store.js";
import { makeOutsideDir } from "../fixtures/outside-dir.js";
import { useTempRoot } from "../fixtures/temp-root.js";

const root = useTempRoot();

/** Build a projection target whose digest binds the supplied bytes. */
function target(output: string, bytes: Buffer): ProjectionTarget {
  return {
    workspaceId: "research", recipeId: "daily-brief",
    recipeDigest: `sha256:${"b".repeat(64)}`,
    output, outputDigest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    criticality: "required",
  };
}

describe("projection confinement", () => {
  it.each([
    "../wiki/injected.md", "/tmp/injected.md", "nested\\injected.md",
    ".hidden/brief.md", "brief.md.llmwiki-projection.json",
    "nested/brief.md.LLMWIKI-PROJECTION.JSON",
    "nested.llmwiki-projection.json/brief.md",
    "nested.LLMWIKI-PROJECTION.JSON/brief.md",
    "con.md", "nested/prn.json", "aux.bin", "nul",
    "com1.md", "com9.md", "lpt1.md", "lpt9.md",
    "Nested/brief.md", "nested/café.md", "nested/café.md",
  ])("rejects unsafe recipe-relative output %s before writing", async (output) => {
    const bytes = Buffer.from("brief"), location = target(output, bytes);
    await expect(writeProjectionLocked(root.dir, location, bytes)).rejects.toThrow(/output|recipe root/i);
    await expect(lstat(path.join(root.dir, ".llmwiki"))).rejects.toThrow(/ENOENT/i);
  });

  it("rejects digest mismatch and oversized bytes before creating a namespace", async () => {
    const bytes = Buffer.from("brief"), mismatch = { ...target("brief.md", bytes), outputDigest: `sha256:${"0".repeat(64)}` as const };
    await expect(writeProjectionLocked(root.dir, mismatch, bytes)).rejects.toThrow(/digest/i);

    const oversized = Buffer.alloc(MAX_PROJECTION_BYTES + 1);
    await expect(writeProjectionLocked(root.dir, target("large.bin", oversized), oversized)).rejects.toThrow(/cap/i);
    await expect(lstat(path.join(root.dir, ".llmwiki"))).rejects.toThrow(/ENOENT/i);
  });

  it("fails closed when the recipe root is a symlink", async () => {
    const bytes = Buffer.from("brief"), location = target("brief.md", bytes);
    const paths = operationPaths(root.dir, location.workspaceId), victim = await makeOutsideDir();
    await mkdir(paths.projectionsRoot, { recursive: true });
    await symlink(victim, paths.projectionRoot(location.recipeId), "dir");

    await expect(writeProjectionLocked(root.dir, location, bytes)).rejects.toThrow(/unavailable|redirect|symlink|escape/i);
    expect(await readdir(victim)).toEqual([]);
  });

  it("detects a parent swap between sidecar and output publication", async () => {
    const bytes = Buffer.from("brief"), location = target("nested/brief.md", bytes);
    const recipeRoot = operationPaths(root.dir, location.workspaceId).projectionRoot(location.recipeId);
    const moved = `${recipeRoot}-moved`, victim = await makeOutsideDir();

    await expect(writeProjectionLocked(root.dir, location, bytes, {
      afterMarkerWriteForTest: async () => {
        await rename(recipeRoot, moved);
        await symlink(victim, recipeRoot, "dir");
      },
    })).rejects.toThrow(/redirect|symlink|escape|changed|ownership|unavailable/i);
    expect(await readdir(victim)).toEqual([]);
  });

  it("reports a symlinked output as unavailable rather than absent", async () => {
    const bytes = Buffer.from("brief"), location = target("nested/brief.md", bytes);
    const output = projectionOutputPath(root.dir, location), victim = await makeOutsideDir();
    await mkdir(path.dirname(output), { recursive: true });
    await symlink(path.join(victim, "outside"), output);

    await expect(observeProjection(root.dir, location)).resolves.toMatchObject({ status: "unavailable" });
  });
});
