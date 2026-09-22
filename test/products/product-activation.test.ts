/**
 * @file test/products/product-activation.test.ts
 * @description Activation under the project lock (design section 8.3). The happy
 * path binds exactly the manifest's component digests, writes `active-product.json`
 * only, and reports success only after a fresh load resolves the product. Known
 * operational unreadiness (no providers, credentials, or grants configured) does
 * NOT block. A structurally-incompatible (non-composable) package, OR one whose
 * pack requires a contract the host does not declare (design section 8.3 step 2,
 * 10.2), is refused. The caller's audit identity and audit options are snapshot
 * before the first await so a later mutation cannot change the written `activatedBy`,
 * `activatedAt`, or `parityCertificateDigest`. Activation never rewrites a page or a
 * settings file.
 */

import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { useTempRoot } from "../fixtures/temp-root.js";
import { activateProductLocked } from "../../src/products/binding/activate.js";
import { ProductActivationError } from "../../src/products/binding/problems.js";
import { resolveActiveProduct } from "../../src/products/binding/resolve.js";
import { readActiveProductBinding } from "../../src/products/binding/store.js";
import { bindingComponentMismatch } from "../../src/products/binding/manifest-authority.js";
import type { PrincipalRefV1 } from "../../src/products/binding/types.js";
import { LLMWIKI_DIR } from "../../src/utils/constants.js";
import {
  bindingFor, buildActivatableProduct, buildContractMismatchedProduct, buildProfileOnlyProduct,
  commitBuilt, FIXTURE_PRINCIPAL,
} from "./binding-fixture.js";
import { dg } from "../operations-packs/pack-fixture.js";

const root = useTempRoot();

/** The `.llmwiki` entries activation is permitted to add: the binding plus the transient project-lock artifacts. */
const ALLOWED_NEW_ENTRIES = new Set(["active-product.json", "lock", "lock.reclaim"]);

/** Whether a path exists at all. */
async function exists(target: string): Promise<boolean> {
  return stat(target).then(() => true, () => false);
}

/** The sorted top-level `.llmwiki` entry names, or `[]` when the dir is absent. */
async function privateDirEntries(dir: string): Promise<string[]> {
  return readdir(path.join(dir, LLMWIKI_DIR)).then((names) => names.sort(), () => []);
}

describe("activateProductLocked", () => {
  it("activates an installed product and resolves it on readback", async () => {
    const product = buildActivatableProduct();
    const digest = await commitBuilt(root.dir, product);
    const result = await activateProductLocked(root.dir, digest, FIXTURE_PRINCIPAL);
    expect(result.status).toBe("activated");
    expect(result.packageDigest).toBe(digest);
    expect((await resolveActiveProduct(root.dir)).mode).toBe("product");
  });

  it("binds exactly the product's manifest component digests", async () => {
    const product = buildActivatableProduct();
    const digest = await commitBuilt(root.dir, product);
    const result = await activateProductLocked(root.dir, digest, FIXTURE_PRINCIPAL, { activatedAt: "2026-01-01T00:00:00.000Z" });
    expect(result.binding).toEqual(bindingFor(product.manifest));
  });

  it("repeats an optional process-definition digest in active authority", async () => {
    const product = buildActivatableProduct("Process Product", '{"processId":"demo/v1"}');
    const digest = await commitBuilt(root.dir, product);
    const result = await activateProductLocked(root.dir, digest, FIXTURE_PRINCIPAL);
    expect(result.binding.processDefinitionDigest).toBe(product.manifest.processDefinition?.digest);
  });

  it("rejects a process digest grafted onto a package that declares none", () => {
    const product = buildActivatableProduct();
    const forged = bindingFor(product.manifest, { processDefinitionDigest: dg("forged-process") });
    expect(bindingComponentMismatch(forged, product.manifest)).toBe("processDefinitionDigest");
  });

  it("does not block on missing operational readiness (no providers/credentials/grants)", async () => {
    const product = buildActivatableProduct();
    const digest = await commitBuilt(root.dir, product);
    await expect(activateProductLocked(root.dir, digest, FIXTURE_PRINCIPAL)).resolves.toMatchObject({ status: "activated" });
  });

  it("refuses a structurally-incompatible (non-composable) package", async () => {
    const product = buildProfileOnlyProduct();
    const digest = await commitBuilt(root.dir, product);
    await expect(activateProductLocked(root.dir, digest, FIXTURE_PRINCIPAL)).rejects.toBeInstanceOf(ProductActivationError);
  });

  it("refuses a pack requiring a contract digest the host does not declare (P1-B)", async () => {
    const product = buildContractMismatchedProduct();
    const digest = await commitBuilt(root.dir, product);
    await expect(activateProductLocked(root.dir, digest, FIXTURE_PRINCIPAL)).rejects.toBeInstanceOf(ProductActivationError);
  });

  it("retains the caller's audit identity across awaits (snapshot before first await)", async () => {
    const product = buildActivatableProduct();
    const digest = await commitBuilt(root.dir, product);
    const principal: PrincipalRefV1 = { id: "operator-1", surface: "cli" };
    const activation = activateProductLocked(root.dir, digest, principal);
    principal.id = "attacker"; // mutate AFTER invocation, before the promise settles
    await activation;
    const read = await readActiveProductBinding(root.dir);
    expect(read.kind === "present" && read.binding.activatedBy.id).toBe("operator-1");
  });

  it("retains the caller's audit options across awaits (snapshot before first await)", async () => {
    const product = buildActivatableProduct();
    const digest = await commitBuilt(root.dir, product);
    const originalAt = "2026-02-02T00:00:00.000Z";
    const originalCert = dg("parity-cert");
    const options = { activatedAt: originalAt, parityCertificateDigest: originalCert };
    const activation = activateProductLocked(root.dir, digest, FIXTURE_PRINCIPAL, options);
    options.activatedAt = "2099-12-31T00:00:00.000Z"; // mutate AFTER invocation, before settle
    options.parityCertificateDigest = dg("attacker-cert");
    await activation;
    const read = await readActiveProductBinding(root.dir);
    expect(read.kind === "present" && read.binding.activatedAt).toBe(originalAt);
    expect(read.kind === "present" && read.binding.parityCertificateDigest).toBe(originalCert);
  });

  it("adds only active-product.json (allowlist) to .llmwiki and no page", async () => {
    const product = buildActivatableProduct();
    const digest = await commitBuilt(root.dir, product);
    const before = new Set(await privateDirEntries(root.dir));
    await activateProductLocked(root.dir, digest, FIXTURE_PRINCIPAL);
    const added = (await privateDirEntries(root.dir)).filter((name) => !before.has(name));
    // Allowlist: the ONLY new .llmwiki entries may be the binding + lock artifacts,
    // so an unexpected settings.json/grants/provider-cache write would fail here.
    expect(added).toContain("active-product.json");
    expect(added.filter((name) => !ALLOWED_NEW_ENTRIES.has(name))).toEqual([]);
    expect(await exists(path.join(root.dir, "wiki/docs"))).toBe(false);
  });
});
