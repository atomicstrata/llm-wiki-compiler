/**
 * @file test/products/product-install-races.test.ts
 * @description Concurrent installs behave as the protocol requires (design
 * section 7.6): two installers racing for the same digest serialize under the
 * project lock and converge after byte verification to exactly one stored
 * package, while two distinct installs each settle to their own content-addressed
 * package.
 */

import { readdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { useTempRoot } from "../fixtures/temp-root.js";
import { installLocalProductPackage } from "../../src/products/packages/install.js";
import { readInstalledProductPackage } from "../../src/products/packages/store.js";
import { productStorePaths } from "../../src/products/paths.js";
import { buildProductPackage, writeSourcePackage } from "./product-package-fixture.js";

const root = useTempRoot();

/** Write the demo package at one version to its own source directory. */
async function source(version: string): Promise<string> {
  const pkg = buildProductPackage({ productVersion: version });
  return writeSourcePackage(path.join(root.dir, `incoming-${version}`), pkg);
}

describe("concurrent product installs", () => {
  it("converges two same-digest installers to one stored package", async () => {
    const dir = await source("1.0.0");
    const results = await Promise.all([
      installLocalProductPackage(root.dir, dir),
      installLocalProductPackage(root.dir, dir),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual(["already-present", "installed"]);
    expect(await readInstalledProductPackage(root.dir, results[0]!.packageDigest)).toMatchObject({ status: "ok" });
    expect(await readdir(productStorePaths(root.dir).sha256Root)).toHaveLength(1);
  });

  it("serializes two distinct installs into two stored packages", async () => {
    const [first, second] = await Promise.all([
      installLocalProductPackage(root.dir, await source("1.0.0")),
      installLocalProductPackage(root.dir, await source("2.0.0")),
    ]);
    expect(first.status).toBe("installed");
    expect(second.status).toBe("installed");
    expect(await readdir(productStorePaths(root.dir).sha256Root)).toHaveLength(2);
  });
});
