/**
 * @file test/capability-providers/package-archive.test.ts
 * @description Safe provider-archive admission tests. Archive names are
 * untrusted and may never escape or alias the package root.
 */
import os from "node:os";
import path from "node:path";
import {
  appendFile, chmod, lstat, mkdir, mkdtemp, readFile, rename, symlink,
} from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  extractProviderArchive, validateProviderArchivePath, verifyProviderTree,
} from "../../src/capability-providers/packages/archive.js";
import {
  MAX_EXPANDED_PACKAGE_TREE_BYTES, MAX_PACKAGE_ENTRIES, MAX_PACKAGE_ENTRY_BYTES,
} from "../../src/capability-providers/constants.js";
import {
  artifactForArchive, providerDistribution, removeProviderFixtureRoot, tarArchive,
  zipArchive, zipMetadataArchive,
} from "../fixtures/capability-provider-package.js";

const roots: string[] = [];

afterEach(async () => Promise.all(roots.splice(0).map(removeProviderFixtureRoot)));

describe("provider package archives", () => {
  it.each(["../escape", "/absolute", "root\\alternate", "root/../escape"])(
    "rejects unsafe archive path %s",
    (entry) => expect(() => validateProviderArchivePath(entry)).toThrow(/archive path/),
  );

  it("extracts one declared tar tree and sets only its entrypoint executable", async () => {
    const fixture = providerDistribution();
    const destination = await temporaryRoot();
    const result = await extractProviderArchive(fixture.archive, fixture.artifact as never, destination);
    expect(result.entryCount).toBe(1);
    expect(await readFile(path.join(destination, "bin/provider"), "utf8")).toBe("provider-bytes");
  });

  it("accepts ordinary explicit root and subdirectory records", async () => {
    const fixture = providerDistribution();
    const archive = tarArchive([
      { name: "package/", type: "5" }, { name: "package/bin/", type: "5" },
      { name: "package/bin/provider", body: "provider-bytes" },
    ]);
    const destination = await temporaryRoot();
    await extractProviderArchive(archive, artifactForArchive(fixture, archive) as never, destination);
    expect(await readFile(path.join(destination, "bin/provider"), "utf8")).toBe("provider-bytes");
  });

  it("extracts the same declared tree from a bounded zip artifact", async () => {
    const fixture = providerDistribution();
    const archive = zipArchive("package/bin/provider", "provider-bytes");
    const artifact = artifactForArchive(fixture, archive, { archiveFormat: "zip" });
    const destination = await temporaryRoot();
    const result = await extractProviderArchive(archive, artifact as never, destination);
    expect(result.expandedTreeDigest).toBe(fixture.artifact.expandedTreeDigest);
  });
});

describe("provider archive hostile leaves", () => {
  it.each([
    { name: "package/../escape", type: "0" },
    { name: "package/bin/provider", type: "1" },
    { name: "package/bin/provider", type: "2" },
    { name: "package/bin/provider", type: "3" },
    { name: "package/bin/provider", type: "4" },
    { name: "package/bin/provider", type: "6" },
    { name: "package/bin/provider", type: "S" },
  ])("rejects hostile tar entry $type", async ({ name, type }) => {
    const fixture = providerDistribution();
    const archive = tarArchive([{ name, body: "x", type }]);
    const artifact = artifactForArchive(fixture, archive);
    await expect(extractProviderArchive(archive, artifact as never, await temporaryRoot())).rejects.toThrow();
  });
});

describe("provider archive duplicate and ZIP leaves", () => {
  it("rejects case-fold collisions before writing either alias", async () => {
    const fixture = providerDistribution();
    const archive = tarArchive([
      { name: "package/bin/provider", body: "one" },
      { name: "package/bin/Provider", body: "two" },
    ]);
    const artifact = artifactForArchive(fixture, archive, { entryCount: 2 });
    await expect(extractProviderArchive(archive, artifact as never, await temporaryRoot())).rejects.toThrow(/collision/);
  });

  it("rejects duplicate entries and duplicate package roots", async () => {
    const fixture = providerDistribution();
    const duplicate = tarArchive([
      { name: "package/bin/provider", body: "one" },
      { name: "package/bin/provider", body: "two" },
    ]);
    await expect(extractProviderArchive(
      duplicate, artifactForArchive(fixture, duplicate, { entryCount: 2 }) as never, await temporaryRoot(),
    )).rejects.toThrow(/collision/);
    const rootsArchive = tarArchive([{ name: "package/", type: "5" }, { name: "package/", type: "5" }]);
    await expect(extractProviderArchive(
      rootsArchive, artifactForArchive(fixture, rootsArchive, { entryCount: 0 }) as never, await temporaryRoot(),
    )).rejects.toThrow(/collision/);
  });

  it.each([0o120777, 0o060600, 0o020600, 0o010600, 0o140600])(
    "rejects hostile ZIP leaf mode %s",
    async (mode) => {
      const fixture = providerDistribution();
      const archive = zipArchive("package/bin/provider", "target", (mode << 16) >>> 0);
      await expect(extractProviderArchive(
        archive, artifactForArchive(fixture, archive, { archiveFormat: "zip" }) as never, await temporaryRoot(),
      )).rejects.toThrow(/unsupported leaf/);
    },
  );
});

describe("provider archive identity", () => {
  it("rejects Unicode-normalization aliases and undeclared entrypoints", async () => {
    const fixture = providerDistribution();
    const archive = tarArchive([
      { name: "package/bin/café", body: "one" },
      { name: "package/bin/café", body: "two" },
    ]);
    await expect(extractProviderArchive(
      archive, artifactForArchive(fixture, archive, { entryCount: 2 }) as never, await temporaryRoot(),
    )).rejects.toThrow(/collision|unsafe/);
    await expect(extractProviderArchive(
      fixture.archive, { ...fixture.artifact, entrypointRelativePath: "bin/missing" } as never, await temporaryRoot(),
    )).rejects.toThrow(/entrypoint/);
  });
});

describe("provider archive portable paths", () => {
  it.each(["package/bin/file.", "package/bin/file:stream", "package/con/file"]) (
    "rejects non-portable Windows alias %s", async (name) => {
      const fixture = providerDistribution();
      const archive = tarArchive([{ name, body: "x" }]);
      await expect(extractProviderArchive(
        archive, artifactForArchive(fixture, archive) as never, await temporaryRoot(),
      )).rejects.toThrow(/unsafe/);
    },
  );

  it("binds extraction to the checked destination parent", async () => {
    const fixture = providerDistribution();
    const destination = await temporaryRoot();
    const moved = `${destination}-moved`; roots.push(moved);
    const outside = await temporaryRoot();
    await expect(extractProviderArchive(fixture.archive, fixture.artifact as never, destination, {
      afterParentCheckForTest: async () => {
        await rename(destination, moved); await symlink(outside, destination);
      },
    })).rejects.toThrow(/changed|unavailable/);
  });
});

describe("provider archive root binding", () => {
  it("rejects a root symlink and a root swapped after a leaf opens", async () => {
    const fixture = providerDistribution();
    const outside = await temporaryRoot();
    await extractProviderArchive(fixture.archive, fixture.artifact as never, outside);
    const parent = await temporaryRoot();
    const alias = path.join(parent, "alias");
    await symlink(outside, alias);
    await expect(verifyProviderTree(alias, fixture.artifact as never)).rejects.toThrow(/root|link|changed/);
    const destination = await temporaryRoot();
    const moved = `${destination}-moved`; roots.push(moved);
    await expect(extractProviderArchive(fixture.archive, fixture.artifact as never, destination, {
      afterLeafOpenForTest: async () => {
        await rename(destination, moved); await symlink(parent, destination);
      },
    } as never)).rejects.toThrow(/changed|unavailable/);
  });

  it("creates no outside directory through a planted nested-parent symlink", async () => {
    const fixture = providerDistribution({
      "package/bin/provider": "provider-bytes",
      "package/lib/sub/data": "evidence",
    });
    const destination = await temporaryRoot();
    const outside = await temporaryRoot();
    await expect(extractProviderArchive(
      fixture.archive,
      fixture.artifact as never,
      destination,
      {
        afterParentCheckForTest: async () => {
          await symlink(outside, path.join(destination, "lib"), process.platform === "win32" ? "junction" : "dir");
        },
      },
    )).rejects.toThrow(/directory|root|link|unavailable/);
    await expect(lstat(path.join(outside, "sub"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("installed provider tree budgets", () => {
  it("reserves aggregate file bytes before bounded reads", async () => {
    const fixture = providerDistribution({
      "package/bin/provider": "provider-bytes", "package/data/evidence": "evidence",
    });
    const destination = await temporaryRoot();
    await extractProviderArchive(fixture.archive, fixture.artifact as never, destination);
    await expect(verifyProviderTree(destination, fixture.artifact as never, {
      maximumExpandedBytesForTest: Number(fixture.artifact.expandedByteCount) - 1,
    } as never)).rejects.toThrow(/expanded|byte cap/);
  });

  it("counts directories and files against one filesystem-entry budget", async () => {
    const fixture = providerDistribution({
      "package/bin/provider": "provider-bytes", "package/a/b/data": "evidence",
    });
    const destination = await temporaryRoot();
    await extractProviderArchive(fixture.archive, fixture.artifact as never, destination);
    await expect(verifyProviderTree(destination, fixture.artifact as never, {
      maximumFilesystemEntriesForTest: Number(fixture.artifact.entryCount),
    } as never)).rejects.toThrow(/entry cap/);
  });
});

describe("installed provider tree shape", () => {
  it("rejects an extra empty directory absent from the implied tree", async () => {
    const fixture = providerDistribution();
    const destination = await temporaryRoot();
    await extractProviderArchive(fixture.archive, fixture.artifact as never, destination);
    if (process.platform !== "win32") await chmod(destination, 0o700);
    await mkdir(path.join(destination, "empty"));
    await expect(verifyProviderTree(destination, fixture.artifact as never)).rejects.toThrow(/tree differs/);
  });

  it("rejects a file that grows after its size is reserved", async () => {
    const fixture = providerDistribution();
    const destination = await temporaryRoot();
    await extractProviderArchive(fixture.archive, fixture.artifact as never, destination);
    await expect(verifyProviderTree(destination, fixture.artifact as never, {
      afterFileStatForTest: async (leaf: string) => {
        if (process.platform !== "win32") await chmod(leaf, 0o600);
        await appendFile(leaf, "growth");
      },
    } as never)).rejects.toThrow(/changed|byte cap/);
  });
});

describe("provider archive preflight early exit", () => {
  it("stops counting implied directories when the cap is exhausted", async () => {
    const fixture = providerDistribution({ "package/a/b/c/d/e/provider": "provider-bytes" });
    const slice = vi.spyOn(Array.prototype, "slice");
    try {
      await expect(extractProviderArchive(
        fixture.archive, fixture.artifact as never, await temporaryRoot(),
        { maximumMaterializedEntriesForTest: 2 } as never,
      )).rejects.toThrow(/entry cap/);
      const matching = slice.mock.instances.filter((value) => (
        Array.isArray(value) && value[0] === "a" && value.at(-1) === "provider"
      ));
      expect(matching).toHaveLength(2);
    } finally {
      slice.mockRestore();
    }
  });
});

describe("provider archive preflight budgets", () => {
  it("counts implied directories before materializing the tree", async () => {
    const fixture = providerDistribution({
      "package/bin/provider": "provider-bytes", "package/data/evidence": "evidence",
    });
    const destination = await temporaryRoot();
    await expect(extractProviderArchive(
      fixture.archive, fixture.artifact as never, destination,
      { maximumMaterializedEntriesForTest: 3 } as never,
    )).rejects.toThrow(/entry cap/);
    await expect(lstat(path.join(destination, "bin"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    ["entry", [MAX_PACKAGE_ENTRY_BYTES + 1], 1, /entry.*byte cap/],
    ["aggregate", [MAX_PACKAGE_ENTRY_BYTES, MAX_PACKAGE_ENTRY_BYTES,
      MAX_PACKAGE_ENTRY_BYTES, MAX_PACKAGE_ENTRY_BYTES, 1], 5, /expanded.*cap/],
    ["count", [], MAX_PACKAGE_ENTRIES + 1, /entry cap/],
  ] as const)("rejects the %s ceiling before materialization", async (_name, sizes, count, message) => {
    const fixture = providerDistribution();
    const archive = zipMetadataArchive(sizes, count);
    await expect(extractProviderArchive(
      archive, artifactForArchive(fixture, archive, {
        archiveFormat: "zip", expandedByteCount: MAX_EXPANDED_PACKAGE_TREE_BYTES,
      }) as never, await temporaryRoot(),
    )).rejects.toThrow(message);
  });

  it("rejects tar count overflow before inspecting the overflow body", async () => {
    const fixture = providerDistribution();
    const entries = Array.from({ length: MAX_PACKAGE_ENTRIES }, (_, index) => ({
      name: `package/d${index}/`, type: "5",
    }));
    const archive = tarArchive([...entries, { name: "package/overflow", type: "2" }]);
    await expect(extractProviderArchive(
      archive, artifactForArchive(fixture, archive) as never, await temporaryRoot(),
    )).rejects.toThrow(/entry cap/);
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "llmwiki-provider-archive-"));
  roots.push(root);
  return root;
}
