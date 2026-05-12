/**
 * Tests for `buildViewerSnapshot`.
 *
 * Focused on the security-sensitive corners that the per-endpoint tests
 * cannot easily reach: symlinked `wiki/index.md` (must be treated as
 * unavailable, not served), and the index outgoing-link resolution that
 * Slice 2 wires through `resolveBareSlugList`.
 */

import { describe, it, expect } from "vitest";
import { symlink, writeFile } from "fs/promises";
import path from "path";
import { makeTempRoot } from "./fixtures/temp-root.js";
import { writePage } from "./fixtures/write-page.js";
import { makeOutsideDir } from "./fixtures/outside-dir.js";
import { buildViewerSnapshot } from "../src/viewer/snapshot.js";

/** Build the snapshot for `root` and assert the index renders as unavailable. */
async function expectIndexUnavailable(root: string): Promise<void> {
  const snapshot = await buildViewerSnapshot(root);
  expect(snapshot.index.available).toBe(false);
  expect(snapshot.index.body).toBe("");
}

describe("buildViewerSnapshot — wiki/index.md handling", () => {
  it("reports available=false when wiki/index.md is absent", async () => {
    const root = await makeTempRoot("snapshot-no-index");
    await expectIndexUnavailable(root);
  });

  it("reads wiki/index.md when it is a regular file inside root", async () => {
    const root = await makeTempRoot("snapshot-index-regular");
    await writePage(path.join(root, "wiki/concepts"), "alpha", { title: "Alpha" }, "B.");
    await writeFile(path.join(root, "wiki/index.md"), "# Index\nLinks to [[alpha]].");
    const snapshot = await buildViewerSnapshot(root);
    expect(snapshot.index.available).toBe(true);
    expect(snapshot.index.body).toContain("Links to [[alpha]].");
    expect(snapshot.index.outgoingLinks).toEqual(["concepts/alpha"]);
  });

  it("treats a symlinked wiki/index.md pointing outside the project as unavailable", async () => {
    const root = await makeTempRoot("snapshot-index-symlink");
    const outside = await makeOutsideDir();
    const outsideIndex = path.join(outside, "leaked-index.md");
    await writeFile(outsideIndex, "# Outside\nLeak.");
    await symlink(outsideIndex, path.join(root, "wiki/index.md"));
    await expectIndexUnavailable(root);
  });

  it("treats a symlinked wiki/index.md pointing at an in-root file as unavailable", async () => {
    const root = await makeTempRoot("snapshot-index-symlink-inroot");
    // The link target is a regular in-root file; the weaker "under root"
    // check would have served README contents through /api/index.
    await writeFile(
      path.join(root, "README.md"),
      "# README\nProject readme, not the compiled index.",
    );
    await symlink(path.join(root, "README.md"), path.join(root, "wiki/index.md"));
    await expectIndexUnavailable(root);
  });
});
