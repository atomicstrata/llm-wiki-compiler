/**
 * @file test/capability-providers/launch-snapshot.test.ts
 * @description Anti-swap fixtures for the invocation-private verified launch
 * snapshot (CP-INV-03 / D6.2). The install-pinned expanded-tree digest compare,
 * not copy-consistency, is the gate: a wholesale cache-tree swap and a
 * hard-link-swapped leaf are refused because the recomputed digest differs, a
 * parent swapped mid-enumerate is refused by the held handles, and the happy
 * path produces a sealed private launch root that re-verifies.
 */
import path from "node:path";
import { link, mkdir, readFile, realpath, rename, symlink, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { buildVerifiedLaunchSnapshot } from "../../src/capability-providers/runtime/launch-snapshot.js";
import type { PlatformArtifactV1 } from "../../src/capability-providers/packages/protocol.js";
import { useTreeFixtures } from "./provider-tree-fixture.js";

const { scratch, extractedSourceTree: sourceTree } = useTreeFixtures();

async function build(sourceTreeReal: string, artifact: PlatformArtifactV1, readOptions = {}) {
  return buildVerifiedLaunchSnapshot({
    sourceTreeReal, artifact, launchParentDir: await scratch("llmwiki-launch-parent-"), readOptions,
  });
}

describe("invocation-private launch snapshot", () => {
  it("builds a sealed private launch root that re-verifies the pinned digest", async () => {
    const { sourceTreeReal, artifact } = await sourceTree();
    const snapshot = await build(sourceTreeReal, artifact);
    expect(snapshot.expandedTreeDigest).toBe(artifact.expandedTreeDigest);
    expect(snapshot.launchRoot).not.toBe(sourceTreeReal);
    expect(await readFile(path.join(snapshot.launchRoot, "bin/provider"), "utf8")).toBe("provider-bytes");
    await snapshot.dispose();
  });

  it("refuses a wholesale cache-tree swap to a self-consistent different tree", async () => {
    const { artifact } = await sourceTree();
    const swapped = path.join(await scratch("llmwiki-launch-swap-"), "tree");
    await mkdir(path.join(swapped, "bin"), { recursive: true });
    await writeFile(path.join(swapped, "bin", "provider"), "different-provider-bytes");
    await expect(build(await realpath(swapped), artifact)).rejects.toThrow(/signed metadata/);
  });

  it("refuses a hard-link-swapped leaf whose content differs from the pin", async () => {
    const { artifact } = await sourceTree();
    const base = await scratch("llmwiki-launch-link-");
    const outside = path.join(base, "outside-bytes");
    await writeFile(outside, "attacker-controlled");
    const tree = path.join(base, "tree");
    await mkdir(path.join(tree, "bin"), { recursive: true });
    await link(outside, path.join(tree, "bin", "provider"));
    await expect(build(await realpath(tree), artifact)).rejects.toThrow(/signed metadata/);
  });

  it("refuses a parent directory swapped mid-enumerate via the held handles", async () => {
    const { sourceTreeReal, artifact } = await sourceTree();
    let swapped = false;
    const readOptions = { afterFileStatForTest: async (leaf: string) => {
      if (swapped) return;
      swapped = true;
      const parent = path.dirname(leaf);
      await rename(parent, `${parent}.moved`);
      await symlink(await scratch("llmwiki-launch-evil-"), parent);
    } };
    await expect(build(sourceTreeReal, artifact, readOptions)).rejects.toThrow();
  });
});
