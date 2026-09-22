/**
 * @file test/capability-providers/provider-tree-reader.test.ts
 * @description Bounded enumerate-with-bodies reader used by the launch snapshot.
 * It walks an installed tree through held root/parent handles, returns each
 * regular file's bytes, and refuses when the recomputed expanded-tree digest,
 * byte count, entry count, or entrypoint disagrees with the pinned artifact.
 */
import { describe, expect, it } from "vitest";
import { readProviderTreeEntriesOnDisk } from "../../src/capability-providers/packages/archive-filesystem.js";
import type { PlatformArtifactV1 } from "../../src/capability-providers/packages/protocol.js";
import { useTreeFixtures } from "./provider-tree-fixture.js";

const { extractedSourceTree } = useTreeFixtures();

describe("provider tree enumerate-with-bodies reader", () => {
  it("returns each regular file's exact bytes and a matching summary", async () => {
    const { sourceTreeReal, artifact } = await extractedSourceTree();
    const { entries, summary } = await readProviderTreeEntriesOnDisk(sourceTreeReal, artifact);
    expect(summary.expandedTreeDigest).toBe(artifact.expandedTreeDigest);
    const provider = entries.find((entry) => entry.relative === "bin/provider");
    expect(provider?.body.toString("utf8")).toBe("provider-bytes");
  });

  it("refuses when the pinned entry count disagrees with the tree", async () => {
    const { sourceTreeReal, artifact } = await extractedSourceTree();
    const tampered = { ...artifact, entryCount: artifact.entryCount + 1 };
    await expect(readProviderTreeEntriesOnDisk(sourceTreeReal, tampered)).rejects.toThrow(/signed metadata/);
  });

  it("refuses when the pinned expanded-tree digest disagrees with the tree", async () => {
    const { sourceTreeReal, artifact } = await extractedSourceTree();
    const tampered = { ...artifact, expandedTreeDigest: `sha256:${"0".repeat(64)}` as PlatformArtifactV1["expandedTreeDigest"] };
    await expect(readProviderTreeEntriesOnDisk(sourceTreeReal, tampered)).rejects.toThrow(/signed metadata/);
  });
});
