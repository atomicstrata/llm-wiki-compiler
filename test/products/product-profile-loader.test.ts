/**
 * @file test/products/product-profile-loader.test.ts
 * @description The runtime-mode resolver and the universal effective-authority
 * loader `loadProfile` (design section 8.2). An ABSENT binding is legacy mode —
 * `loadProfile` yields the legacy default unchanged. A PRESENT, healthy binding is
 * product mode and a DIRECT `loadProfile` call yields the package's knowledge
 * profile, not the default. A present-but-unhealthy binding — component-digest
 * mismatch or an uninstalled package — is `unavailable` and NEVER falls back to
 * legacy.
 */

import { rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { useTempRoot } from "../fixtures/temp-root.js";
import { loadProfile } from "../../src/profile/load.js";
import { DEFAULT_PROFILE } from "../../src/profile/default.js";
import { ActiveProductUnavailableError } from "../../src/products/binding/problems.js";
import { resolveActiveProduct } from "../../src/products/binding/resolve.js";
import { activeProductBindingPath, writeActiveProductBinding } from "../../src/products/binding/store.js";
import type { Sha256Digest } from "../../src/products/ids.js";
import { bindingFor, buildProfileOnlyProduct, commitBuilt, serializeBinding } from "./binding-fixture.js";

const root = useTempRoot();

/** Commit a profile-only product and activate a (possibly perturbed) binding. */
async function withBinding(overrides: Parameters<typeof bindingFor>[1] = {}) {
  const product = buildProfileOnlyProduct();
  await commitBuilt(root.dir, product);
  await writeActiveProductBinding(root.dir, bindingFor(product.manifest, overrides));
  return product;
}

describe("resolveActiveProduct", () => {
  it("reports legacy mode when no binding is present", async () => {
    expect(await resolveActiveProduct(root.dir)).toEqual({ mode: "legacy" });
  });

  it("resolves a healthy binding to product mode with the package profile", async () => {
    await withBinding();
    const resolution = await resolveActiveProduct(root.dir);
    expect(resolution.mode).toBe("product");
    expect(resolution.mode === "product" && resolution.loaded.profile.profileId).toBe("custom");
  });

  it("reports unavailable (never legacy) on a component-digest mismatch", async () => {
    await withBinding({ knowledgeProfileDigest: `sha256:${"b".repeat(64)}` as Sha256Digest });
    const resolution = await resolveActiveProduct(root.dir);
    expect(resolution.mode).toBe("unavailable");
    expect(resolution.mode === "unavailable" && resolution.detail).toMatch(/component-mismatch/);
  });

  it("reports unavailable when the binding's package is not installed", async () => {
    const product = buildProfileOnlyProduct();
    await writeActiveProductBinding(root.dir, bindingFor(product.manifest));
    const resolution = await resolveActiveProduct(root.dir);
    expect(resolution.mode === "unavailable" && resolution.detail).toBe("package-absent");
  });
});

describe("loadProfile (universal effective authority)", () => {
  it("returns the legacy default profile when no binding is present", async () => {
    const loaded = await loadProfile(root.dir);
    expect(loaded.profile).toBe(DEFAULT_PROFILE);
    expect(loaded.loadedFrom).toBeNull();
  });

  // P1-C: a DIRECT loadProfile call in product mode must authorize against the
  // product's knowledge profile, not the default — every reader shares this entry.
  it("a direct loadProfile call yields the product profile (not the default) in product mode", async () => {
    await withBinding();
    const loaded = await loadProfile(root.dir);
    expect(loaded.profile.profileId).toBe("custom");
    expect(loaded.profile.profileId).not.toBe(DEFAULT_PROFILE.profileId);
    expect(loaded.loadedFrom).not.toBeNull();
  });

  it("throws unavailable (never legacy) for an unhealthy binding", async () => {
    await withBinding({ knowledgeProfileDigest: `sha256:${"c".repeat(64)}` as Sha256Digest });
    await expect(loadProfile(root.dir)).rejects.toBeInstanceOf(ActiveProductUnavailableError);
  });
});

// Both probes install a valid package and a valid binding, then break ONLY the
// binding leaf — so they measure the resolver's fail-closed translation of an
// unsafe leaf, not an incidental "package-absent". A regression that let a broken
// binding fall back to legacy/default (returning the default profile) must fail here.
describe("fail-closed for an unsafe binding leaf", () => {
  it("reports unavailable (never legacy) for a corrupt-JSON binding leaf", async () => {
    await withBinding();
    await writeFile(activeProductBindingPath(root.dir), "}{ not json", "utf8");
    expect((await resolveActiveProduct(root.dir)).mode).toBe("unavailable");
    await expect(loadProfile(root.dir)).rejects.toBeInstanceOf(ActiveProductUnavailableError);
  });

  it("reports unavailable (never legacy) for a symlinked binding leaf", async () => {
    const product = await withBinding();
    const leaf = activeProductBindingPath(root.dir);
    const outside = path.join(root.dir, "outside-binding.json");
    // The symlink target is a VALID binding OUTSIDE .llmwiki: the leaf must fail
    // closed on the symlink itself, never following it to read out-of-tree bytes.
    await writeFile(outside, serializeBinding(bindingFor(product.manifest)), "utf8");
    await rm(leaf);
    await symlink(outside, leaf);
    expect((await resolveActiveProduct(root.dir)).mode).toBe("unavailable");
    await expect(loadProfile(root.dir)).rejects.toBeInstanceOf(ActiveProductUnavailableError);
  });
});
