/**
 * @file test/products/product-install.test.ts
 * @description The inert local install stores content-addressed bytes under
 * `.llmwiki/product-packages/sha256/<hex>/`, resolves them via an offline read,
 * and writes an advisory `local-unverified` receipt — while NEVER writing
 * `active-product.json`. A second install of the same package converges rather
 * than installing a duplicate.
 */

import { stat } from "node:fs/promises";
import { readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { useTempRoot } from "../fixtures/temp-root.js";
import { installLocalProductPackage } from "../../src/products/packages/install.js";
import { readProductInstallReceipt } from "../../src/products/packages/receipts.js";
import { readInstalledProductPackage } from "../../src/products/packages/store.js";
import { digestDirectoryName } from "../../src/products/ids.js";
import { productStorePaths } from "../../src/products/paths.js";
import { buildProductPackage, writeSourcePackage } from "./product-package-fixture.js";

const root = useTempRoot();

/** Whether a path exists at all. */
async function exists(target: string): Promise<boolean> {
  return stat(target).then(() => true, () => false);
}

/** Write the demo package to a source directory the installer will consume. */
async function source(version?: string): Promise<{ dir: string; hex: string }> {
  const pkg = buildProductPackage(version === undefined ? {} : { productVersion: version });
  const dir = await writeSourcePackage(path.join(root.dir, `incoming-${version ?? "default"}`), pkg);
  return { dir, hex: digestDirectoryName(pkg.manifest.packageDigest) };
}

describe("inert local product install", () => {
  it("installs content-addressed bytes and resolves them offline", async () => {
    const { dir, hex } = await source();
    const result = await installLocalProductPackage(root.dir, dir);
    expect(result.status).toBe("installed");
    expect(result.provenance).toBe("local-unverified");
    expect(await exists(productStorePaths(root.dir).manifestFile(hex))).toBe(true);
    const read = await readInstalledProductPackage(root.dir, result.packageDigest);
    expect(read.status).toBe("ok");
  });

  it("writes an advisory receipt but never active-product.json", async () => {
    const { dir } = await source();
    const result = await installLocalProductPackage(root.dir, dir);
    expect(result.receiptWritten).toBe(true);
    const receipt = await readProductInstallReceipt(root.dir, result.packageDigest);
    expect(receipt).toMatchObject({ status: "ok", receipt: { provenance: "local-unverified" } });
    expect(await exists(path.join(root.dir, ".llmwiki", "active-product.json"))).toBe(false);
  });

  it("rejects a corrupt source member before committing any bytes to the store", async () => {
    const pkg = buildProductPackage();
    const dir = await writeSourcePackage(path.join(root.dir, "incoming-corrupt"), pkg);
    const [memberHex, memberBytes] = [...pkg.bytesByHex][0]!;
    const tampered = Buffer.from(memberBytes);
    tampered[0] ^= 0xff; // same length, different content
    await writeFile(path.join(dir, "members", memberHex), tampered);
    await expect(installLocalProductPackage(root.dir, dir)).rejects.toThrow(/bytes disagree with its digest/);
    // fail-fast: the pre-commit check refuses before any bytes reach the store
    expect(await readdir(productStorePaths(root.dir).sha256Root).catch(() => [])).toHaveLength(0);
  });

  it("writes the receipt under product-package-receipts, a sibling of the package store", async () => {
    const { dir } = await source();
    await installLocalProductPackage(root.dir, dir);
    expect(await exists(path.join(root.dir, ".llmwiki", "product-package-receipts"))).toBe(true);
    // never nested inside the measured package store, so it escapes capacity accounting
    expect(await exists(path.join(root.dir, ".llmwiki", "product-packages", "receipts"))).toBe(false);
  });

  it("converges on a second install of the same package", async () => {
    const { dir, hex } = await source();
    await installLocalProductPackage(root.dir, dir);
    const second = await installLocalProductPackage(root.dir, dir);
    expect(second.status).toBe("already-present");
    expect((await readdir(productStorePaths(root.dir).sha256Root)).filter((name) => name === hex)).toHaveLength(1);
    expect(await readdir(productStorePaths(root.dir).sha256Root)).toHaveLength(1);
  });
});
