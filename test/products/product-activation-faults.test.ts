/**
 * @file test/products/product-activation-faults.test.ts
 * @description The durable binding write is crash-atomic (design section 8.3): a
 * fault injected before the temp write, after the parent check but before the
 * atomic rename, after the rename but before the parent fsync, or after the write
 * fully settles ALWAYS leaves exactly one COMPLETE authority on disk — the
 * complete-old binding before the rename commits, the complete-new one after — and
 * a leftover temp from a crashed write is ignored. A baseline product A is
 * activated first, then activating a distinct product B is faulted at each stage
 * so complete-old (A) is observably distinct from complete-new (B).
 */

import { writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { useTempRoot } from "../fixtures/temp-root.js";
import { activateProductLocked } from "../../src/products/binding/activate.js";
import type { ActiveBindingWriteFaultsV1 } from "../../src/products/binding/store.js";
import { activeProductBindingPath, readActiveProductBinding } from "../../src/products/binding/store.js";
import type { Sha256Digest } from "../../src/products/ids.js";
import { buildActivatableProduct, commitBuilt, FIXTURE_PRINCIPAL } from "./binding-fixture.js";

const root = useTempRoot();

/** Commit products A and B, then activate A as the complete-old baseline. */
async function setup(): Promise<{ digestA: Sha256Digest; digestB: Sha256Digest }> {
  const digestA = await commitBuilt(root.dir, buildActivatableProduct("Product A"));
  const digestB = await commitBuilt(root.dir, buildActivatableProduct("Product B"));
  await activateProductLocked(root.dir, digestA, FIXTURE_PRINCIPAL);
  return { digestA, digestB };
}

/** The packageDigest of the one complete binding on disk (or its non-present kind). */
async function onDiskDigest(): Promise<string> {
  const read = await readActiveProductBinding(root.dir);
  return read.kind === "present" ? read.binding.packageDigest : read.kind;
}

/** Fault activating B at one stage and require it to reject. */
async function faultActivateB(digestB: Sha256Digest, faults: ActiveBindingWriteFaultsV1): Promise<void> {
  await expect(activateProductLocked(root.dir, digestB, FIXTURE_PRINCIPAL, { faults })).rejects.toThrow();
}

const crash = () => { throw new Error("simulated crash"); };

describe("activation write is crash-atomic", () => {
  it("a fault before the temp write leaves the complete-old authority", async () => {
    const { digestA, digestB } = await setup();
    await faultActivateB(digestB, { beforeWrite: crash });
    expect(await onDiskDigest()).toBe(digestA);
  });

  it("a fault after the parent check, before the rename, leaves the complete-old authority", async () => {
    const { digestA, digestB } = await setup();
    await faultActivateB(digestB, { afterParentCheck: crash });
    expect(await onDiskDigest()).toBe(digestA);
  });

  it("a fault after the rename, before the parent fsync, leaves the complete-new authority", async () => {
    const { digestB } = await setup();
    await faultActivateB(digestB, { beforeParentSync: crash });
    expect(await onDiskDigest()).toBe(digestB);
  });

  it("a fault after the durable write settles leaves the complete-new authority", async () => {
    const { digestB } = await setup();
    await faultActivateB(digestB, { afterWrite: crash });
    expect(await onDiskDigest()).toBe(digestB);
  });

  it("ignores a leftover temp from a crashed write and reads the complete-old authority", async () => {
    const { digestA } = await setup();
    await writeFile(`${activeProductBindingPath(root.dir)}.deadbeef.tmp`, "partial bytes", "utf8");
    expect(await onDiskDigest()).toBe(digestA);
  });
});
