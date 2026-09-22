/**
 * @file test/products/product-package-store.test.ts
 * @description The immutable content-addressed store commits a verified package
 * and resolves it by an offline confined read, and refuses every tampered store:
 * a symlinked manifest leaf, a symlinked members parent, a foreign hard link, a
 * FIFO leaf, a swapped manifest, and a partial tree. Capacity is enforced under
 * the lock before the final rename — the count ceiling blocks a 33rd package and
 * the byte ceiling rejects an oversize incoming package — and measurement counts
 * partial and orphan bytes.
 */

import { execFileSync } from "node:child_process";
import { chmod, link, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { useTempRoot } from "../fixtures/temp-root.js";
import {
  assertProductStoreCapacity, commitProductPackage, measureProductPackageStore,
  readInstalledProductPackage,
} from "../../src/products/packages/store.js";
import { MAX_INSTALLED_PACKAGES_PER_PROJECT, MAX_PRODUCT_PACKAGE_STORE_BYTES } from "../../src/products/constants.js";
import { digestDirectoryName } from "../../src/products/ids.js";
import { ProductBoundsError, ProductPackageError } from "../../src/products/problems.js";
import { productStorePaths } from "../../src/products/paths.js";
import { buildProductPackage } from "./product-package-fixture.js";

const root = useTempRoot();

/** Commit the demo package and return its digest hex, store paths, and members. */
async function install() {
  const pkg = buildProductPackage();
  const result = await commitProductPackage(root.dir, pkg.manifest, pkg.bytesByHex);
  const hex = digestDirectoryName(pkg.manifest.packageDigest);
  const [memberHex, memberBytes] = [...pkg.bytesByHex][0]!;
  return { pkg, result, hex, memberHex, memberBytes, paths: productStorePaths(root.dir) };
}

/** Whether the installed package resolves on an offline confined read. */
async function reads(pkg: Awaited<ReturnType<typeof install>>["pkg"]): Promise<string> {
  return (await readInstalledProductPackage(root.dir, pkg.manifest.packageDigest)).status;
}

describe("product package store", () => {
  it("commits a verified package and resolves it offline", async () => {
    const { pkg, result } = await install();
    expect(result.status).toBe("committed");
    expect(await reads(pkg)).toBe("ok");
  });

  it("refuses a symlinked manifest leaf", async () => {
    const { pkg, hex, paths } = await install();
    await writeFile(path.join(root.dir, "outside.json"), "{}", "utf8");
    await rm(paths.manifestFile(hex));
    await symlink(path.join(root.dir, "outside.json"), paths.manifestFile(hex));
    expect(await reads(pkg)).toBe("unavailable");
  });

  it("refuses a symlinked members parent directory", async () => {
    const { pkg, hex, paths } = await install();
    const decoy = path.join(root.dir, "decoy");
    await mkdir(decoy, { recursive: true });
    await rm(paths.membersRoot(hex), { recursive: true });
    await symlink(decoy, paths.membersRoot(hex));
    expect(await reads(pkg)).toBe("unavailable");
  });

  it("refuses a foreign hard link member", async () => {
    const { pkg, hex, memberHex, memberBytes, paths } = await install();
    const foreign = path.join(root.dir, "foreign");
    await writeFile(foreign, memberBytes);
    await rm(paths.memberFile(hex, memberHex));
    await link(foreign, paths.memberFile(hex, memberHex));
    expect(await reads(pkg)).toBe("unavailable");
  });

  it("refuses a FIFO member leaf", async () => {
    const { pkg, hex, memberHex, paths } = await install();
    await rm(paths.memberFile(hex, memberHex));
    execFileSync("mkfifo", [paths.memberFile(hex, memberHex)]);
    expect(await reads(pkg)).toBe("unavailable");
  });

  it("refuses a swapped manifest and a partial tree", async () => {
    const { pkg, hex, paths } = await install();
    const other = buildProductPackage({ productVersion: "9.9.9" });
    await writeFile(paths.manifestFile(hex), Buffer.from(other.manifestText, "utf8"));
    expect(await reads(pkg)).toBe("invalid");
    await writeFile(paths.manifestFile(hex), Buffer.from(pkg.manifestText, "utf8"));
    await rm(paths.memberFile(hex, [...pkg.bytesByHex][0]![0]));
    expect(await reads(pkg)).toBe("invalid");
  });

  it("refuses a member whose bytes were replaced at the same byte length", async () => {
    const { pkg, hex, memberHex, memberBytes, paths } = await install();
    const tampered = Buffer.from(memberBytes);
    tampered[0] ^= 0xff; // same length, different content — the content-addressed digest must catch it
    await writeFile(paths.memberFile(hex, memberHex), tampered);
    expect(await reads(pkg)).toBe("invalid");
  });

  it("refuses an installed package carrying an undeclared root leaf", async () => {
    const { pkg, hex, paths } = await install();
    await writeFile(path.join(paths.packageDir(hex), "surprise.txt"), "planted");
    expect(await reads(pkg)).toBe("invalid");
  });

  it("refuses an installed members directory carrying an undeclared member file", async () => {
    const { pkg, hex, paths } = await install();
    await writeFile(paths.memberFile(hex, "b".repeat(64)), "planted");
    expect(await reads(pkg)).toBe("invalid");
  });

  it("returns unavailable when the package directory cannot be enumerated", async () => {
    const { pkg, hex, paths } = await install();
    await chmod(paths.packageDir(hex), 0o100); // execute-only: declared leaves open, enumeration denied (EACCES)
    try {
      expect(await reads(pkg)).toBe("unavailable");
    } finally {
      await chmod(paths.packageDir(hex), 0o700); // restore so the temp root can be removed
    }
  });

  it("refuses to converge on a colliding invalid digest directory", async () => {
    const pkg = buildProductPackage();
    const paths = productStorePaths(root.dir);
    const hex = digestDirectoryName(pkg.manifest.packageDigest);
    await mkdir(paths.packageDir(hex), { recursive: true });
    await writeFile(path.join(paths.packageDir(hex), "junk"), "not a package");
    await expect(commitProductPackage(root.dir, pkg.manifest, pkg.bytesByHex)).rejects.toThrow(ProductPackageError);
  });

  it("measures partial and orphan bytes in the store", async () => {
    const paths = productStorePaths(root.dir);
    await mkdir(paths.tmpRoot, { recursive: true });
    await writeFile(path.join(paths.tmpRoot, "orphan"), Buffer.alloc(128));
    expect((await measureProductPackageStore(root.dir)).totalBytes).toBeGreaterThanOrEqual(128);
  });

  it("rejects an oversize incoming package at the byte ceiling", async () => {
    await expect(assertProductStoreCapacity(root.dir, MAX_PRODUCT_PACKAGE_STORE_BYTES + 1))
      .rejects.toThrow(ProductBoundsError);
    await expect(assertProductStoreCapacity(root.dir, 0)).resolves.toBeUndefined();
  });

  it("blocks a package beyond the installed-count ceiling", async () => {
    const paths = productStorePaths(root.dir);
    for (let index = 0; index < MAX_INSTALLED_PACKAGES_PER_PROJECT; index += 1) {
      await mkdir(path.join(paths.sha256Root, `d${index}`), { recursive: true });
    }
    const pkg = buildProductPackage();
    await expect(commitProductPackage(root.dir, pkg.manifest, pkg.bytesByHex)).rejects.toThrow(ProductBoundsError);
  });
});
