/**
 * @file test/capability-providers/package-install.test.ts
 * @description Immutable provider-install path and state tests. Installation
 * records live in owner-private operator state, never in a project.
 */
import os from "node:os";
import path from "node:path";
import { execFile as execFileCallback } from "node:child_process";
import { Readable } from "node:stream";
import { promisify } from "node:util";
import {
  chmod, mkdir, mkdtemp, readFile, realpath, rename, symlink, truncate, writeFile,
} from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { authorizeProviderPathsForTest } from "../../src/capability-providers/packages/paths.js";
import { authorizedProviderRoots } from "./provider-roots.js";
import { addProviderSource, installRemoteProvider, refreshProviderSource } from "../../src/capability-providers/packages/remote-install.js";
import { approveLocalProviderExecution, installLocalProvider } from "../../src/capability-providers/packages/local-install.js";
import {
  installBuiltinProvider, publishArchiveProviderLocked,
} from "../../src/capability-providers/packages/builtin.js";
import { authorizeBuiltinProviderReleaseForTest } from "../../src/capability-providers/packages/builtin-release.js";
import { readProviderInstallState } from "../../src/capability-providers/packages/state-store.js";
import { canonicalDigest } from "../../src/profile/templates/signing/canonical.js";
import { MAX_PACKAGE_ENTRY_BYTES } from "../../src/capability-providers/constants.js";
import {
  COORDINATE, distributionSeams, providerDistribution, providerIndex,
  payloadWithDuplicateHostArtifact, removeProviderFixtureRoot, TAP,
} from "../fixtures/capability-provider-package.js";

const roots: string[] = [];
const execFile = promisify(execFileCallback);
type InvalidCacheLeaf = "fifo" | "regular" | "symlink";
const invalidCacheLeaves: readonly InvalidCacheLeaf[] = process.platform === "win32"
  ? ["regular", "symlink"] : ["regular", "symlink", "fifo"];

afterEach(async () => Promise.all(roots.splice(0).map(removeProviderFixtureRoot)));

describe("provider package installation", () => {
  it("authorizes distinct owner-private config and cache roots", async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "llmwiki-provider-install-")));
    roots.push(root);
    await mkdir(path.join(root, "config"), { mode: 0o700 });
    await mkdir(path.join(root, "cache"), { mode: 0o700 });
    const paths = await authorizeProviderPathsForTest({
      configRoot: path.join(root, "config"), cacheRoot: path.join(root, "cache"),
    });
    expect(paths.verification).toBe("authorized-provider-roots");
    expect(Object.isFrozen(paths)).toBe(true);
  });

  it("installs verified remote bytes without executing them", async () => {
    const fixture = providerDistribution();
    const paths = await isolatedPaths();
    await addProviderSource(paths, {
      name: "official", indexUrl: "https://tap.example/v1/index.json", trustedKey: TAP.publicKey,
    });
    await refreshProviderSource(paths, "official", {
      seams: distributionSeams(fixture),
    });
    const installed = await installRemoteProvider(paths, {
      coordinate: COORDINATE, confirmedPackageDigest: fixture.envelope.payloadDigest as string,
      confirmedIndexDigest: canonicalDigest(fixture.index), seams: distributionSeams(fixture),
    });
    expect(installed.sourceType).toBe("signed-remote");
    expect(await readFile(path.join(installed.treePath, "bin/provider"), "utf8")).toBe("provider-bytes");
    expect(Object.values((await readProviderInstallState(paths)).installs)).toHaveLength(1);
  });
});

describe("provider builtin package installation", () => {
  it("installs builtin release bytes without granting or executing them", async () => {
    const fixture = providerDistribution();
    const paths = await isolatedPaths();
    const release = await authorizeBuiltinProviderReleaseForTest(paths, {
      payload: fixture.payload, archive: fixture.archive,
    });
    const result = await installBuiltinProvider(paths, release);
    expect(result.sourceType).toBe("builtin");
  });
});

describe("provider builtin provenance boundaries", () => {
  it("does not let raw caller bytes claim builtin provenance", async () => {
    const fixture = providerDistribution();
    await expect(installBuiltinProvider(await isolatedPaths(), {
      payload: fixture.payload, artifactId: String(fixture.artifact.artifactId), archive: fixture.archive,
    } as never)).rejects.toThrow(/host-owned builtin release/);
  });

  it("does not let the generic publisher mint builtin provenance", async () => {
    const fixture = providerDistribution();
    await expect(publishArchiveProviderLocked(await isolatedPaths(), {
      payload: fixture.payload, artifact: fixture.artifact, archive: fixture.archive,
      packageDigest: canonicalDigest(fixture.payload), coordinate: "builtin/atomicstrata/research@1.0.0",
      sourceType: "builtin", packageEvidenceText: `${JSON.stringify(fixture.payload)}\n`,
      tapSequence: null, publisherKeyId: null, acceptedIndexDigest: null,
      installedAt: new Date("2026-07-17T12:00:00Z"),
    } as never)).rejects.toThrow(/host-owned builtin release/);
  });

  it("rejects ambiguous builtin host artifacts", async () => {
    const fixture = providerDistribution();
    await expect(authorizeBuiltinProviderReleaseForTest(await isolatedPaths(), {
      payload: payloadWithDuplicateHostArtifact(fixture),
      archive: fixture.archive,
    })).rejects.toThrow(/artifact.*platform|platform.*artifact|exactly one|duplicate/);
  });
});

describe("provider local package installation", () => {
  it("snapshots local development bytes and marks them local-unverified", async () => {
    const fixture = providerDistribution();
    const paths = await isolatedPaths();
    const sourceRoot = await temporaryRoot("llmwiki-provider-local-");
    await mkdir(path.join(sourceRoot, "bin"));
    await writeFile(path.join(sourceRoot, "bin/provider"), "provider-bytes");
    const result = await installLocalProvider(paths, {
      sourceRoot, payload: fixture.payload,
      confirmedPackageDigest: fixture.envelope.payloadDigest as string,
    });
    await writeFile(path.join(sourceRoot, "bin/provider"), "local-v2");
    expect(result.sourceType).toBe("local-development");
    expect(await readFile(path.join(result.treePath, "bin/provider"), "utf8")).toBe("provider-bytes");
    expect(Object.keys((await readProviderInstallState(paths)).localApprovals)).toHaveLength(0);
    await approveLocalProviderExecution(paths, { packageDigest: result.packageDigest, confirmed: true });
    expect((await readProviderInstallState(paths)).localApprovals[result.packageDigest]?.packageDigest).toBe(result.packageDigest);
    await expect(approveLocalProviderExecution(paths, {
      packageDigest: result.packageDigest, confirmed: false,
    })).rejects.toThrow(/confirmation/);
  });

  it("preflights a sparse oversized local file before reading it", async () => {
    const fixture = providerDistribution();
    const sourceRoot = await temporaryRoot("llmwiki-provider-local-cap-");
    await mkdir(path.join(sourceRoot, "bin"));
    const source = path.join(sourceRoot, "bin/provider");
    await writeFile(source, ""); await truncate(source, MAX_PACKAGE_ENTRY_BYTES + 1);
    await expect(installLocalProvider(await isolatedPaths(), {
      sourceRoot, payload: fixture.payload,
      confirmedPackageDigest: fixture.envelope.payloadDigest as string,
    })).rejects.toThrow(/file.*byte cap/);
  });
});

describe("provider local platform selection", () => {
  it("rejects ambiguous local host artifacts", async () => {
    const fixture = providerDistribution();
    const payload = payloadWithDuplicateHostArtifact(fixture);
    await expect(installLocalProvider(await isolatedPaths(), {
      sourceRoot: await temporaryRoot("llmwiki-provider-local-ambiguous-"), payload,
      confirmedPackageDigest: canonicalDigest(payload),
    })).rejects.toThrow(/artifact.*platform|platform.*artifact|exactly one|duplicate/);
  });
});

describe("provider remote package defenses", () => {
  it("requires fresh accepted index evidence bound to the confirmation", async () => {
    const fixture = providerDistribution();
    let now = new Date("2026-07-17T12:00:00Z");
    const stalePaths = await refreshedPaths(fixture, () => now);
    now = new Date("2026-07-19T00:00:00Z");
    await expect(installRemoteProvider(
      stalePaths, remoteRequest(fixture, distributionSeams(fixture)),
    )).rejects.toThrow(/fresh|expired/);
    const paths = await refreshedPaths(fixture);
    await expect(installRemoteProvider(paths, {
      ...remoteRequest(fixture, distributionSeams(fixture)), confirmedIndexDigest: `sha256:${"0".repeat(64)}`,
    })).rejects.toThrow(/index.*confirmation/);
    const newer = {
      ...fixture,
      index: providerIndex(String(fixture.envelope.payloadDigest), { sequence: 2 }),
    };
    await expect(installRemoteProvider(paths, {
      ...remoteRequest(fixture, distributionSeams(newer)),
    })).rejects.toThrow(/index.*confirmation/);
  });
});

describe("provider remote origin defenses", () => {
  it("refuses a package redirect that leaves the configured origin", async () => {
    const fixture = providerDistribution();
    const paths = await refreshedPaths(fixture);
    const seams = distributionSeams(fixture);
    const redirected = { ...seams, request: async (request: Parameters<NonNullable<typeof seams.request>>[0]) => (
      request.path.includes("/packages/")
        ? { statusCode: 302, headers: { location: "https://evil.example/package.json" }, body: Readable.from([]) }
        : seams.request!(request)
    ) };
    await expect(installRemoteProvider(paths, remoteRequest(fixture, redirected))).rejects.toThrow(/origin|allowlisted/);
  });

  it("detects a published cache swap before recording installation", async () => {
    const fixture = providerDistribution();
    const paths = await refreshedPaths(fixture);
    await expect(installRemoteProvider(paths, {
      ...remoteRequest(fixture, distributionSeams(fixture)),
      afterPublicationForTest: async (tree) => {
        const leaf = path.join(tree, "bin/provider");
        await chmod(path.dirname(leaf), 0o700); await chmod(leaf, 0o600); await writeFile(leaf, "swapped");
      },
    })).rejects.toThrow(/tree differs/);
    expect(Object.keys((await readProviderInstallState(paths)).installs)).toHaveLength(0);
    const repaired = await installRemoteProvider(paths, remoteRequest(fixture, distributionSeams(fixture)));
    expect(await readFile(path.join(repaired.treePath, "bin/provider"), "utf8")).toBe("provider-bytes");
  });
});

describe("provider published digest binding", () => {
  it("rejects a digest directory moved outside and replaced by a symlink", async () => {
    const fixture = providerDistribution();
    const paths = await refreshedPaths(fixture);
    const outside = await temporaryRoot("llmwiki-provider-digest-swap-");
    const moved = path.join(outside, "moved-digest");
    await expect(installRemoteProvider(paths, {
      ...remoteRequest(fixture, distributionSeams(fixture)),
      afterPublicationForTest: async (tree) => {
        const digestDirectory = path.dirname(tree);
        await chmod(digestDirectory, 0o700);
        await rename(digestDirectory, moved);
        await symlink(moved, digestDirectory, process.platform === "win32" ? "junction" : "dir");
      },
    })).rejects.toThrow(/directory|root|changed|unauthorized|unavailable/);
    expect(Object.keys((await readProviderInstallState(paths)).installs)).toHaveLength(0);
    expect(await readFile(path.join(moved, "tree/bin/provider"), "utf8")).toBe("provider-bytes");
  });
});

describe("provider install-state binding", () => {
  it("rolls back install state when the digest binding changes during commit", async () => {
    const fixture = providerDistribution();
    const paths = await refreshedPaths(fixture);
    const outside = await temporaryRoot("llmwiki-provider-commit-swap-");
    const moved = path.join(outside, "moved-digest");
    await expectRejectedInstallLeavesNoState(paths, fixture, async (directory) => {
      await chmod(directory, 0o700); await rename(directory, moved);
      await symlink(moved, directory, process.platform === "win32" ? "junction" : "dir");
    });
  });

  it("rolls back install state when the verified tree changes during commit", async () => {
    const fixture = providerDistribution();
    const paths = await refreshedPaths(fixture);
    const outside = await temporaryRoot("llmwiki-provider-tree-swap-");
    const moved = path.join(outside, "moved-tree");
    await expectRejectedInstallLeavesNoState(paths, fixture, async (directory) => {
      const tree = path.join(directory, "tree");
      await chmod(directory, 0o700); await chmod(tree, 0o700); await rename(tree, moved);
      await symlink(moved, tree, process.platform === "win32" ? "junction" : "dir");
    });
  });
});

describe("provider digest-cache repair", () => {
  it.each(invalidCacheLeaves)("repairs an invalid %s digest-cache leaf", async (kind) => {
    const fixture = providerDistribution();
    const paths = await refreshedPaths(fixture);
    await mkdir(paths.packagesRoot, { recursive: true, mode: 0o700 });
    const digestLeaf = path.join(paths.packagesRoot, String(fixture.envelope.payloadDigest).slice(7));
    await plantInvalidCacheLeaf(kind, digestLeaf);
    const installed = await installRemoteProvider(paths, remoteRequest(fixture, distributionSeams(fixture)));
    expect(await readFile(path.join(installed.treePath, "bin/provider"), "utf8")).toBe("provider-bytes");
  });
});

describe("provider evidence and clock defenses", () => {
  it("repairs corrupt package evidence and ignores a caller backdated clock", async () => {
    const fixture = providerDistribution();
    let now = new Date("2026-07-17T12:00:00Z");
    const paths = await refreshedPaths(fixture, () => now);
    await expect(installRemoteProvider(paths, {
      ...remoteRequest(fixture, distributionSeams(fixture)),
      afterPublicationForTest: async (tree) => {
        const directory = path.dirname(tree); const evidence = path.join(directory, "package.json");
        await chmod(directory, 0o700); await chmod(evidence, 0o600); await writeFile(evidence, "{}\n");
      },
    })).rejects.toThrow(/evidence/);
    const repaired = await installRemoteProvider(paths, remoteRequest(fixture, distributionSeams(fixture)));
    expect(await readFile(path.join(path.dirname(repaired.treePath), "package.json"), "utf8")).toContain("payloadDigest");
    now = new Date("2026-07-19T00:00:00Z");
    await expect(installRemoteProvider(paths, remoteRequest(fixture, distributionSeams(fixture)) as never)).rejects.toThrow(/expired/);
  });
});

describe("provider installation evidence replacement", () => {
  it("replaces local-unverified evidence when the same bytes gain signed provenance", async () => {
    const fixture = providerDistribution();
    const paths = await isolatedPaths();
    const sourceRoot = await temporaryRoot("llmwiki-provider-upgrade-");
    await mkdir(path.join(sourceRoot, "bin"));
    await writeFile(path.join(sourceRoot, "bin/provider"), "provider-bytes");
    const local = await installLocalProvider(paths, {
      sourceRoot, payload: fixture.payload,
      confirmedPackageDigest: String(fixture.envelope.payloadDigest),
    });
    await approveLocalProviderExecution(paths, { packageDigest: local.packageDigest, confirmed: true });
    await addProviderSource(paths, { name: "official", indexUrl: "https://tap.example/index.json", trustedKey: TAP.publicKey });
    await refreshProviderSource(paths, "official", { seams: distributionSeams(fixture) });
    const installed = await installRemoteProvider(paths, remoteRequest(fixture, distributionSeams(fixture)));
    expect(installed.sourceType).toBe("signed-remote");
    expect((await readProviderInstallState(paths)).localApprovals[local.packageDigest]).toBeUndefined();
  });
});

async function plantInvalidCacheLeaf(kind: InvalidCacheLeaf, leaf: string): Promise<void> {
  if (kind === "regular") {
    await writeFile(leaf, "poison");
    return;
  }
  if (kind === "fifo") {
    await execFile("mkfifo", [leaf]);
    return;
  }
  const outside = await temporaryRoot("llmwiki-provider-cache-symlink-");
  await symlink(outside, leaf, process.platform === "win32" ? "junction" : "dir");
}

async function expectRejectedInstallLeavesNoState(
  paths: Awaited<ReturnType<typeof isolatedPaths>>,
  fixture: ReturnType<typeof providerDistribution>,
  afterCommit: (directory: string) => Promise<void>,
): Promise<void> {
  await expect(installRemoteProvider(paths, {
    ...remoteRequest(fixture, distributionSeams(fixture)),
    afterInstallStateCommitForTest: afterCommit,
  })).rejects.toThrow(/root|directory|unauthorized|unavailable/);
  expect(Object.keys((await readProviderInstallState(paths)).installs)).toHaveLength(0);
}

async function refreshedPaths(fixture: ReturnType<typeof providerDistribution>, nowForTest?: () => Date) {
  const paths = await isolatedPaths(nowForTest);
  await addProviderSource(paths, { name: "official", indexUrl: "https://tap.example/index.json", trustedKey: TAP.publicKey });
  await refreshProviderSource(paths, "official", {
    seams: distributionSeams(fixture),
  });
  return paths;
}

function remoteRequest(fixture: ReturnType<typeof providerDistribution>, seams: ReturnType<typeof distributionSeams>) {
  return {
    coordinate: COORDINATE, confirmedPackageDigest: String(fixture.envelope.payloadDigest),
    confirmedIndexDigest: canonicalDigest(fixture.index), seams,
  };
}

async function isolatedPaths(nowForTest = () => new Date("2026-07-17T12:00:00Z")) {
  return authorizedProviderRoots(await temporaryRoot("llmwiki-provider-state-"), nowForTest);
}

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), prefix)));
  roots.push(root);
  return root;
}
