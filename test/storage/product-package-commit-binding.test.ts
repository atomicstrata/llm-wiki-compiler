/**
 * @file test/storage/product-package-commit-binding.test.ts
 * @description The product-package project-storage writes, each as ONE body over
 * its own steps, with the root forms delegating over per-call local-disk steps:
 * the immutable-store commit (`ProductPackageCommitStore` + per-token
 * `ProductPackageStaging`), the advisory receipts (`ProductReceiptLeaves`), the
 * install's project commit leg (`ProductInstallCommitSteps`) and the
 * active-binding write (`ActiveBindingWrite`).
 *
 * HOW IT IS BUILT. Memory cases hand each body a scripted double that logs every
 * call, over a REAL fixture package (`product-package-fixture.ts`), to pin order,
 * convergence, the ceilings, cleanup, refusals and the exact bytes handed down.
 * A double proves only the body's decisions; the real install, commit, receipt and
 * activation journeys stay covered by their existing suites, which run alongside.
 */

import { afterAll, afterEach, describe, expect, it, vi } from "bun:test";
import { canonicalBytes } from "../../src/profile/templates/signing/canonical.js";
import { MAX_INSTALLED_PACKAGES_PER_PROJECT } from "../../src/products/constants.js";
import { digestDirectoryName } from "../../src/products/ids.js";
import { ProductBoundsError, ProductPackageError } from "../../src/products/problems.js";
import * as packageStore from "../../src/products/packages/store.js";
import {
  commitProductPackageWith, type ProductPackageCommitStore, type ProductPackageStaging,
} from "../../src/products/packages/store.js";
import * as receipts from "../../src/products/packages/receipts.js";
import {
  buildProductInstallReceipt, readProductInstallReceiptFrom, writeProductInstallReceiptTo, type ProductReceiptLeaves,
} from "../../src/products/packages/receipts.js";
import { commitInstalledPackageWith, localProductInstallCommitSteps, type ProductInstallCommitSteps } from "../../src/products/packages/install.js";
import { writeActiveProductBindingTo } from "../../src/products/binding/store.js";
import type { ActiveProductBindingV1 } from "../../src/products/binding/types.js";
import { buildProductPackage } from "../products/product-package-fixture.js";
import { tempRootTracker } from "../temp-roots.js";

const roots = tempRootTracker();
/** A fresh canonical temporary project root, removed after the file. */
const freshRoot = (): Promise<string> => roots.create("product-commit-", { real: true });
afterEach(() => { vi.restoreAllMocks(); });
afterAll(() => roots.cleanup());

const pkg = buildProductPackage();
const hexes = pkg.manifest.members.map((member) => digestDirectoryName(member.digest));

describe("immutable-store commit: one body over the commit store", () => {
  interface Script { installed?: ("ok" | "absent")[]; count?: number; manifestEcho?: Buffer; rename?: boolean }
  function store(script: Script, log: string[]): ProductPackageCommitStore {
    const installed = [...(script.installed ?? ["absent"])];
    const staging = (token: string): ProductPackageStaging => {
      log.push(`staging ${token.length}`);
      return {
        writeManifest: async (bytes) => { log.push(`manifest ${bytes.equals(canonicalBytes(pkg.manifest))}`); },
        writeMember: async (hex) => { log.push(`member ${hexes.indexOf(hex)}`); },
        readManifest: async () => ({ kind: "ok", body: script.manifestEcho ?? canonicalBytes(pkg.manifest) }),
        checkMember: async (hex) => { log.push(`check ${hexes.indexOf(hex)}`); return "matches"; },
        sync: async () => { log.push("sync"); },
        renameInto: async (hex) => { log.push(`rename ${hex === digestDirectoryName(pkg.manifest.packageDigest)}`); return script.rename ?? true; },
        cleanup: async () => { log.push("cleanup"); },
      };
    };
    return {
      readInstalled: async () => { const status = installed.shift() ?? "absent"; log.push(`read ${status}`); return (status === "ok" ? { status, manifest: pkg.manifest } : { status }) as never; },
      measure: async () => { log.push("measure"); return { installedCount: script.count ?? 0, totalBytes: 0 }; },
      staging,
    };
  }
  const members = (prefix: string) => hexes.map((_hex, index) => `${prefix} ${index}`);

  it("C1 converges before capacity; otherwise measures, stages canonical bytes in manifest order, re-verifies, syncs, renames and cleans up", async () => {
    const log: string[] = [];
    expect(await commitProductPackageWith(store({ installed: ["ok"] }, log), pkg.manifest, pkg.bytesByHex)).toEqual({ status: "converged" });
    expect(log).toEqual(["read ok"]);
    log.length = 0;
    expect(await commitProductPackageWith(store({}, log), pkg.manifest, pkg.bytesByHex)).toEqual({ status: "committed" });
    expect(log).toEqual(["read absent", "measure", "staging 32", "manifest true", ...members("member"), ...members("check"), "sync", "rename true", "cleanup"]);
  });

  it("C2 refuses the count ceiling before any staging, and fails a missing member, a changed manifest or an invalid collision with cleanup", async () => {
    const log: string[] = [];
    const full = commitProductPackageWith(store({ count: MAX_INSTALLED_PACKAGES_PER_PROJECT }, log), pkg.manifest, pkg.bytesByHex);
    await expect(full).rejects.toBeInstanceOf(ProductBoundsError);
    expect(log).toEqual(["read absent", "measure"]);
    const outcomes: string[][] = [];
    const cases: [Script, ReadonlyMap<string, Buffer>][] = [
      [{}, new Map()], [{ manifestEcho: Buffer.from("{}") }, pkg.bytesByHex], [{ rename: false, installed: ["absent", "absent"] }, pkg.bytesByHex],
    ];
    for (const [script, bytes] of cases) {
      const run: string[] = [];
      await expect(commitProductPackageWith(store(script, run), pkg.manifest, bytes)).rejects.toBeInstanceOf(ProductPackageError);
      outcomes.push([run.at(-2)!, run.at(-1)!]);
    }
    expect(outcomes).toEqual([["manifest true", "cleanup"], [`member ${hexes.length - 1}`, "cleanup"], ["read absent", "cleanup"]]);
    const converged: string[] = [];
    expect(await commitProductPackageWith(store({ rename: false, installed: ["absent", "ok"] }, converged), pkg.manifest, pkg.bytesByHex)).toEqual({ status: "converged" });
    expect(converged.slice(-3)).toEqual(["rename true", "read ok", "cleanup"]);
  });
});

describe("advisory receipts and the install's project commit leg", () => {
  it("R1 writes canonical bytes under the digest name after the cap; reads absent, unavailable, invalid and ok distinctly", async () => {
    const written: [string, Buffer][] = [];
    const leaves = (read: Awaited<ReturnType<ProductReceiptLeaves["readReceipt"]>>): ProductReceiptLeaves => ({
      readReceipt: async () => read, replaceReceipt: async (hex, bytes) => { written.push([hex, bytes]); },
    });
    const receipt = buildProductInstallReceipt(pkg.manifest);
    await writeProductInstallReceiptTo(leaves({ kind: "absent" }), receipt);
    expect(written).toEqual([[digestDirectoryName(pkg.manifest.packageDigest), canonicalBytes(receipt)]]);
    const read = (answer: Awaited<ReturnType<ProductReceiptLeaves["readReceipt"]>>) => readProductInstallReceiptFrom(leaves(answer), pkg.manifest.packageDigest);
    expect(await Promise.all([read({ kind: "absent" }), read({ kind: "unavailable" }), read({ kind: "ok", body: "{}" })]))
      .toEqual([{ status: "absent" }, { status: "unavailable" }, { status: "invalid" }]);
    expect(await read({ kind: "ok", body: canonicalBytes(receipt).toString("utf8") })).toEqual({ status: "ok", receipt });
  });

  it("I1 commits, requires the offline read, then writes the receipt; a receipt failure is provenance-unavailable, not a failed install", async () => {
    const log: string[] = [];
    const steps = (installed: string, receiptFails: boolean): ProductInstallCommitSteps => ({
      commit: async () => { log.push("commit"); return { status: "committed" }; },
      readInstalled: async () => { log.push(`read ${installed}`); return { status: installed } as never; },
      writeReceipt: async () => { log.push("receipt"); if (receiptFails) throw new Error("disk full"); },
    });
    expect(await commitInstalledPackageWith(steps("ok", true), pkg)).toMatchObject({ status: "installed", receiptWritten: false, provenance: "local-unverified" });
    expect(log).toEqual(["commit", "read ok", "receipt"]);
    log.length = 0;
    await expect(commitInstalledPackageWith(steps("absent", false), pkg)).rejects.toThrow("did not resolve on an offline read");
    expect(log).toEqual(["commit", "read absent"]);
  });
});

describe("active-binding write: fault seams around the one durable replace", () => {
  it("B1 runs before, then the replace with canonical bytes and both seams, then after", async () => {
    const log: string[] = [];
    const binding = { schemaVersion: 1, productId: "p" } as unknown as ActiveProductBindingV1;
    const seam = (name: string) => async () => { log.push(name); };
    await writeActiveProductBindingTo({
      replaceBinding: async (bytes, seams) => { log.push(`replace ${bytes.equals(canonicalBytes(binding))} ${typeof seams.afterParentCheck} ${typeof seams.beforeParentSync}`); },
    }, binding, { beforeWrite: seam("before"), afterParentCheck: seam("check"), beforeParentSync: async () => {}, afterWrite: seam("after") });
    expect(log).toEqual(["before", "replace true function function", "after"]);
  });
});

describe("no ambient I/O from the bodies; the local steps reach their incumbents with this root", () => {
  it("Z1 the install leg over doubles reaches no incumbent, while the local steps call each with this root", async () => {
    const readInstalled = vi.spyOn(packageStore, "readInstalledProductPackage");
    const writeReceipt = vi.spyOn(receipts, "writeProductInstallReceipt");
    await commitInstalledPackageWith({
      commit: async () => ({ status: "converged" }), readInstalled: async () => ({ status: "ok", manifest: pkg.manifest, verifiedMembers: new Map() }), writeReceipt: async () => {},
    }, pkg);
    expect([readInstalled.mock.calls.length, writeReceipt.mock.calls.length]).toEqual([0, 0]);
    const root = await freshRoot();
    const local = localProductInstallCommitSteps(root);
    expect((await local.readInstalled(pkg.manifest.packageDigest)).status).toBe("absent");
    const receipt = buildProductInstallReceipt(pkg.manifest);
    await local.writeReceipt(receipt).catch(() => undefined); // only the call and its arguments are the witness here
    expect([readInstalled.mock.calls, writeReceipt.mock.calls]).toEqual([[[root, pkg.manifest.packageDigest]], [[root, receipt]]]);
  });
});
