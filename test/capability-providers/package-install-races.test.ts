/**
 * @file test/capability-providers/package-install-races.test.ts
 * @description Root-authorization race tests for provider package state. A
 * checked operator parent cannot be replaced before authorization completes.
 */
import os from "node:os";
import path from "node:path";
import { lstat, mkdir, mkdtemp, realpath, rename, symlink, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { authorizeProviderPathsForTest } from "../../src/capability-providers/packages/paths.js";
import { authorizedProviderRoots } from "./provider-roots.js";
import { addProviderSource, installRemoteProvider, refreshProviderSource } from "../../src/capability-providers/packages/remote-install.js";
import { readProviderInstallState } from "../../src/capability-providers/packages/state-store.js";
import { installBuiltinProvider } from "../../src/capability-providers/packages/builtin.js";
import { installLocalProvider } from "../../src/capability-providers/packages/local-install.js";
import type { LocalProviderSnapshotOptions } from "../../src/capability-providers/packages/local-snapshot.js";
import {
  authorizeBuiltinProviderReleaseForTest, type BuiltinProviderReleaseTestRequest,
} from "../../src/capability-providers/packages/builtin-release.js";
import { canonicalDigest } from "../../src/profile/templates/signing/canonical.js";
import {
  COORDINATE, distributionSeams, providerDistribution, removeProviderFixtureRoot, TAP,
} from "../fixtures/capability-provider-package.js";

const roots: string[] = [];

afterEach(async () => Promise.all(roots.splice(0).map(removeProviderFixtureRoot)));

describe("provider package install races", () => {
  it("rejects a config-root parent swapped to a symlink", async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "llmwiki-provider-race-")));
    roots.push(root);
    const parent = path.join(root, "operator");
    const moved = path.join(root, "operator-moved");
    const outside = path.join(root, "outside");
    await mkdir(parent);
    await mkdir(outside);
    const authorization = authorizeProviderPathsForTest({
      configRoot: path.join(parent, "config"), cacheRoot: path.join(parent, "cache"),
      afterAncestorCheckForTest: async () => {
        await rename(parent, moved);
        await symlink(outside, parent, process.platform === "win32" ? "junction" : "dir");
      },
    });
    await expect(authorization).rejects.toThrow(/operator root/);
  });
});

describe("provider package installer serialization", () => {
  it("serializes two installers into one immutable installation record", async () => {
    const fixture = providerDistribution();
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "llmwiki-provider-install-race-")));
    roots.push(root);
    const paths = await authorizedProviderRoots(root, () => new Date("2026-07-17T12:00:00Z"));
    await addProviderSource(paths, {
      name: "official", indexUrl: "https://tap.example/index.json", trustedKey: TAP.publicKey,
    });
    await refreshProviderSource(paths, "official", {
      seams: distributionSeams(fixture),
    });
    const request = {
      coordinate: COORDINATE, confirmedPackageDigest: fixture.envelope.payloadDigest as string,
      confirmedIndexDigest: canonicalDigest(fixture.index), seams: distributionSeams(fixture),
    };
    const [first, second] = await Promise.all([
      installRemoteProvider(paths, request), installRemoteProvider(paths, request),
    ]);
    expect(first.packageDigest).toBe(second.packageDigest);
    expect(Object.keys((await readProviderInstallState(paths)).installs)).toHaveLength(1);
  });
});

describe("provider package-cache confinement", () => {
  it("rejects a planted package-cache parent symlink", async () => {
    const fixture = providerDistribution();
    const { paths, root } = await racePaths();
    const outside = path.join(root, "outside"); await mkdir(outside);
    await symlink(outside, path.join(paths.providerCacheRoot, "packages"), process.platform === "win32" ? "junction" : "dir");
    await expect(installBuiltinFixture(paths, fixture)).rejects.toThrow(/root|unauthorized/);
  });

  // Each race fixture retains the mutation at the exact security boundary it exercises.
  // fallow-ignore-next-line code-duplication
  it("rejects a package parent swapped after its binding check", async () => {
    const fixture = providerDistribution();
    const { paths, root } = await racePaths();
    const outside = path.join(root, "outside"); await mkdir(outside);
    await expect(installBuiltinFixture(paths, fixture, {
      afterPackageParentCheckForTest: async (directory) => {
        await rename(directory, `${directory}-moved`); await symlink(outside, directory);
      },
    })).rejects.toThrow(/changed|unauthorized/);
  });

  // This second boundary check intentionally keeps the race setup visible.
  // fallow-ignore-next-line code-duplication
  it("rechecks the package parent after staging opens", async () => {
    const fixture = providerDistribution();
    const { paths, root } = await racePaths();
    const outside = path.join(root, "outside"); await mkdir(outside);
    await expect(installBuiltinFixture(paths, fixture, {
      afterPackageStagingOpenForTest: async (staging: string) => {
        const directory = path.dirname(staging);
        await rename(directory, `${directory}-moved`); await symlink(outside, directory);
      },
    } as never)).rejects.toThrow(/changed|unauthorized/);
  });
});

describe("provider package staging confinement", () => {
  it("writes no bytes after the authorized staging directory is swapped", async () => {
    const fixture = providerDistribution();
    const { paths, root } = await racePaths();
    const outside = path.join(root, "outside"); await mkdir(outside);
    await expect(installBuiltinFixture(paths, fixture, {
      afterStagingCheckBeforeTreeForTest: async (staging: string) => {
        await rename(staging, `${staging}-moved`); await symlink(outside, staging);
      },
    } as never)).rejects.toThrow(/changed|escaped|unauthorized|unavailable/);
    await expect(lstat(path.join(outside, "tree"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("provider local snapshot confinement", () => {
  it("rejects a selected source root swapped before traversal reads a file", async () => {
    const fixture = await localRaceFixture();
    await expectLocalRaceRefusal(fixture, {
      afterDirectoryStreamOpenForTest: async (_directory, relative) => {
        if (relative !== "") return;
        await rename(fixture.sourceRoot, fixture.movedRoot);
        await symlink(fixture.outsideRoot, fixture.sourceRoot, directoryLinkType());
      },
    });
  });

  it("rejects a nested source parent swapped before its file opens", async () => {
    const fixture = await localRaceFixture();
    await expectLocalRaceRefusal(fixture, {
      beforeFileOpenForTest: async () => {
        await rename(path.join(fixture.sourceRoot, "bin"), path.join(fixture.sourceRoot, "bin-moved"));
        await symlink(path.join(fixture.outsideRoot, "bin"), path.join(fixture.sourceRoot, "bin"), directoryLinkType());
      },
    });
  });
});

describe("provider download confinement", () => {
  it("rejects a download parent swapped after its binding check", async () => {
    const fixture = providerDistribution();
    const { paths, root } = await racePaths();
    await addProviderSource(paths, { name: "official", indexUrl: "https://tap.example/index.json", trustedKey: TAP.publicKey });
    await refreshProviderSource(paths, "official", { seams: distributionSeams(fixture) });
    const outside = path.join(root, "outside"); await mkdir(outside);
    await expect(installRemoteProvider(paths, {
      coordinate: COORDINATE, confirmedPackageDigest: String(fixture.envelope.payloadDigest),
      confirmedIndexDigest: canonicalDigest(fixture.index), seams: distributionSeams(fixture),
      afterDownloadParentCheckForTest: async (directory) => {
        await rename(directory, `${directory}-moved`); await symlink(outside, directory);
      },
    })).rejects.toThrow(/changed|unauthorized/);
  });

  // Parent-swap fixtures stay explicit so their callback timing remains reviewable.
  // fallow-ignore-next-line code-duplication
  it("rechecks the download parent after the temporary leaf opens", async () => {
    const fixture = providerDistribution();
    const { paths, root } = await racePaths();
    await addProviderSource(paths, { name: "official", indexUrl: "https://tap.example/index.json", trustedKey: TAP.publicKey });
    await refreshProviderSource(paths, "official", { seams: distributionSeams(fixture) });
    const outside = path.join(root, "outside"); await mkdir(outside);
    await expect(installRemoteProvider(paths, {
      coordinate: COORDINATE, confirmedPackageDigest: String(fixture.envelope.payloadDigest),
      confirmedIndexDigest: canonicalDigest(fixture.index), seams: distributionSeams(fixture),
      afterDownloadOpenForTest: async (leaf: string) => {
        const directory = path.dirname(leaf);
        await rename(directory, `${directory}-moved`); await symlink(outside, directory);
      },
    } as never)).rejects.toThrow(/changed|unauthorized/);
  });
});

async function racePaths() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "llmwiki-provider-parent-race-")));
  roots.push(root); await mkdir(path.join(root, "config")); await mkdir(path.join(root, "cache"));
  const paths = await authorizeProviderPathsForTest({
    configRoot: path.join(root, "config"), cacheRoot: path.join(root, "cache"),
    nowForTest: () => new Date("2026-07-17T12:00:00Z"),
  } as never);
  return { paths, root };
}

async function localRaceFixture() {
  const fixture = providerDistribution();
  const { paths, root } = await racePaths();
  const sourceRoot = path.join(root, "source");
  const movedRoot = path.join(root, "source-moved");
  const outsideRoot = path.join(root, "outside-source");
  await mkdir(path.join(sourceRoot, "bin"), { recursive: true });
  await mkdir(path.join(outsideRoot, "bin"), { recursive: true });
  await writeFile(path.join(sourceRoot, "bin/provider"), "provider-bytes");
  await writeFile(path.join(outsideRoot, "bin/provider"), "provider-bytes");
  return { fixture, paths, sourceRoot, movedRoot, outsideRoot };
}

function localRequest(fixture: Awaited<ReturnType<typeof localRaceFixture>>) {
  return {
    sourceRoot: fixture.sourceRoot,
    payload: fixture.fixture.payload,
    confirmedPackageDigest: String(fixture.fixture.envelope.payloadDigest),
  };
}

async function expectLocalRaceRefusal(
  fixture: Awaited<ReturnType<typeof localRaceFixture>>,
  options: LocalProviderSnapshotOptions,
): Promise<void> {
  let reads = 0;
  await expect(installLocalProvider(fixture.paths, {
    ...localRequest(fixture),
    snapshotOptionsForTest: {
      ...options,
      beforeFileReadForTest: async () => { reads += 1; },
    },
  })).rejects.toThrow(/source|directory|changed|escaped/);
  expect(reads).toBe(0);
  expect(Object.keys((await readProviderInstallState(fixture.paths)).installs)).toHaveLength(0);
}

function directoryLinkType(): "junction" | "dir" {
  return process.platform === "win32" ? "junction" : "dir";
}

async function installBuiltinFixture(
  paths: Awaited<ReturnType<typeof racePaths>>["paths"],
  fixture: ReturnType<typeof providerDistribution>,
  options: Omit<BuiltinProviderReleaseTestRequest, "archive" | "payload"> = {},
) {
  const release = await authorizeBuiltinProviderReleaseForTest(paths, {
    payload: fixture.payload, archive: fixture.archive, ...options,
  });
  return installBuiltinProvider(paths, release);
}
