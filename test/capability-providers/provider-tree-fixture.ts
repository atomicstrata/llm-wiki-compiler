/**
 * @file test/capability-providers/provider-tree-fixture.ts
 * @description Shared installed-tree fixture for the enumerate-with-bodies
 * reader and the launch-snapshot suites: extract the signed fixture archive
 * into a tracked temp tree and hand back its realpath and pinned artifact.
 */
import os from "node:os";
import path from "node:path";
import { mkdtemp, realpath } from "node:fs/promises";
import { afterEach } from "vitest";
import { extractProviderArchive } from "../../src/capability-providers/packages/archive.js";
import type { PlatformArtifactV1 } from "../../src/capability-providers/packages/protocol.js";
import { providerDistribution, removeProviderFixtureRoot } from "../fixtures/capability-provider-package.js";

interface ExtractedTreeV1 {
  readonly sourceTreeReal: string;
  readonly artifact: PlatformArtifactV1;
}

/** Register tree cleanup and return tracked scratch + extract helpers. */
export function useTreeFixtures() {
  const roots: string[] = [];
  afterEach(async () => { await Promise.all(roots.splice(0).map(removeProviderFixtureRoot)); });
  const scratch = async (prefix: string): Promise<string> => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), prefix)));
    roots.push(root);
    return root;
  };
  const extractedSourceTree = async (): Promise<ExtractedTreeV1> => {
    const fixture = providerDistribution();
    const source = path.join(await scratch("llmwiki-tree-src-"), "tree");
    await extractProviderArchive(fixture.archive, fixture.artifact as never, source);
    return { sourceTreeReal: await realpath(source), artifact: fixture.artifact as unknown as PlatformArtifactV1 };
  };
  return { scratch, extractedSourceTree };
}
