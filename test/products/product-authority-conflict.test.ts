/**
 * @file test/products/product-authority-conflict.test.ts
 * @description When an active-product binding and a legacy `profile.json` are BOTH
 * present, loading fails closed with a product-authority conflict (design section
 * 8.2). Neither silently wins — not the healthy binding, not the profile. A
 * `profile.json` present with NO binding stays legacy mode, so the conflict is
 * specifically the co-presence, not the profile alone.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { useTempRoot } from "../fixtures/temp-root.js";
import { loadProfile } from "../../src/profile/load.js";
import { ProductAuthorityConflictError } from "../../src/products/binding/problems.js";
import { resolveActiveProduct } from "../../src/products/binding/resolve.js";
import { writeActiveProductBinding } from "../../src/products/binding/store.js";
import { PROFILE_FILE } from "../../src/utils/constants.js";
import { bindingFor, buildProfileOnlyProduct, commitBuilt } from "./binding-fixture.js";

const root = useTempRoot();

/** Write a valid legacy `.llmwiki/profile.json`. */
async function writeLegacyProfile(): Promise<void> {
  const file = path.join(root.dir, PROFILE_FILE);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({ schemaVersion: 1, profileId: "legacy", entities: {} }), "utf8");
}

/** Commit and activate a healthy binding alongside the given legacy state. */
async function activateHealthyBinding(): Promise<void> {
  const product = buildProfileOnlyProduct();
  await commitBuilt(root.dir, product);
  await writeActiveProductBinding(root.dir, bindingFor(product.manifest));
}

describe("product-authority conflict", () => {
  it("resolves to conflict when a binding and profile.json coexist", async () => {
    await activateHealthyBinding();
    await writeLegacyProfile();
    expect(await resolveActiveProduct(root.dir)).toEqual({ mode: "conflict" });
  });

  it("fails closed loading the effective profile under the conflict", async () => {
    await activateHealthyBinding();
    await writeLegacyProfile();
    await expect(loadProfile(root.dir)).rejects.toBeInstanceOf(ProductAuthorityConflictError);
  });

  it("stays legacy mode when profile.json is present with no binding", async () => {
    await writeLegacyProfile();
    expect(await resolveActiveProduct(root.dir)).toEqual({ mode: "legacy" });
  });
});
