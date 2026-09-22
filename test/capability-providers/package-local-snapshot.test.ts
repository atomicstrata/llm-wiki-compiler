/**
 * @file test/capability-providers/package-local-snapshot.test.ts
 * @description Bounded local-development provider snapshot regression tests.
 * Counts and bytes are reserved before traversal materializes provider files.
 */
import os from "node:os";
import path from "node:path";
import {
  appendFile, link, mkdir, mkdtemp, realpath, writeFile,
} from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { installLocalProvider } from "../../src/capability-providers/packages/local-install.js";
import type { LocalProviderSnapshotOptions } from "../../src/capability-providers/packages/local-snapshot.js";
import { authorizeProviderPathsForTest } from "../../src/capability-providers/packages/paths.js";
import { readProviderInstallState } from "../../src/capability-providers/packages/state-store.js";
import {
  providerDistribution, removeProviderFixtureRoot,
} from "../fixtures/capability-provider-package.js";

const roots: string[] = [];

afterEach(async () => Promise.all(roots.splice(0).map(removeProviderFixtureRoot)));

describe("provider local snapshot ceilings", () => {
  it("rejects filesystem entry overflow before reading the overflowing entry", async () => {
    const fixture = await localFixture();
    await expectCapRefusal(fixture, { maximumFilesystemEntriesForTest: 0 }, /entry cap/);
  });

  it("rejects directory overflow before descending into the directory", async () => {
    const fixture = await localFixture();
    await expectCapRefusal(fixture, { maximumDirectoriesForTest: 0 }, /directory cap/);
  });

  it("rejects a file that grows after its bounded size reservation", async () => {
    const fixture = await localFixture();
    let grew = false;
    await expect(installLocalProvider(fixture.paths, {
      ...localRequest(fixture),
      snapshotOptionsForTest: {
        afterFileStatForTest: async (leaf: string) => {
          await appendFile(leaf, "!");
          grew = true;
        },
      },
    })).rejects.toThrow(/changed while snapshotting/);
    expect(grew).toBe(true);
    await expectNoInstalls(fixture.paths);
  });
});

describe("provider local snapshot link defenses", () => {
  it("rejects a source file hard-linked outside after its opening stat", async () => {
    const fixture = await localFixture();
    let reads = 0;
    await expect(installLocalProvider(fixture.paths, {
      ...localRequest(fixture),
      snapshotOptionsForTest: {
        afterFileStatForTest: async (leaf) => {
          await link(leaf, path.join(fixture.root, "outside-provider"));
        },
        beforeFileReadForTest: async () => { reads += 1; },
      },
    })).rejects.toThrow(/changed while snapshotting/);
    expect(reads).toBe(0);
    await expectNoInstalls(fixture.paths);
  });
});

async function localFixture() {
  const fixture = providerDistribution();
  const root = await temporaryRoot();
  const sourceRoot = path.join(root, "source");
  await mkdir(path.join(root, "config"));
  await mkdir(path.join(root, "cache"));
  await mkdir(path.join(sourceRoot, "bin"), { recursive: true });
  await writeFile(path.join(sourceRoot, "bin/provider"), "provider-bytes");
  const paths = await authorizeProviderPathsForTest({
    configRoot: path.join(root, "config"), cacheRoot: path.join(root, "cache"),
    nowForTest: () => new Date("2026-07-17T12:00:00Z"),
  } as never);
  return { fixture, paths, sourceRoot, root };
}

function localRequest(fixture: Awaited<ReturnType<typeof localFixture>>) {
  return {
    sourceRoot: fixture.sourceRoot,
    payload: fixture.fixture.payload,
    confirmedPackageDigest: String(fixture.fixture.envelope.payloadDigest),
  };
}

async function expectCapRefusal(
  fixture: Awaited<ReturnType<typeof localFixture>>,
  options: LocalProviderSnapshotOptions,
  expected: RegExp,
): Promise<void> {
  let reads = 0;
  await expect(installLocalProvider(fixture.paths, {
    ...localRequest(fixture),
    snapshotOptionsForTest: {
      ...options, beforeFileReadForTest: async () => { reads += 1; },
    },
  })).rejects.toThrow(expected);
  expect(reads).toBe(0);
  await expectNoInstalls(fixture.paths);
}

async function expectNoInstalls(
  paths: Awaited<ReturnType<typeof authorizeProviderPathsForTest>>,
): Promise<void> {
  expect(Object.keys((await readProviderInstallState(paths)).installs)).toHaveLength(0);
}

async function temporaryRoot(): Promise<string> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "llmwiki-provider-local-bounds-")));
  roots.push(root);
  return root;
}
