/**
 * @file test/storage/scanned-leaf-bytes.test.ts
 * @description A leaf the inventory walk read is answered from those bytes by
 * the durable-leaf reader ONLY while it is still that version at the same
 * confined path with exact reserved links; any change sends the reader back to
 * the disk, where it decides absent, unavailable or the new bytes as before.
 *
 * Real files on real disk: the walk's observation (`observeInventoryLeaf`) and
 * the reader (`readDurableOperationLeafBuffer`) are the production functions.
 */

import { link, mkdir, mkdtemp, realpath, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { readDurableOperationLeafBuffer } from "../../src/operation-bundles/durable-leaf.js";
import { observeInventoryLeaf } from "../../src/utils/inventory-scan.js";
import { scannedLeafBytes, type ScannedLeafBytes } from "../../src/utils/scanned-leaf-bytes.js";

const CAP = 1024;
let root: string, dir: string, leaf: string, scanned: ScannedLeafBytes;

/** Observe the leaf as the walk does, keeping its bytes in the pass's holder. */
async function walkLeaf(): Promise<void> {
  expect((await observeInventoryLeaf(root, leaf, dir, { into: scanned, maxBytes: CAP })).kind).toBe("confirmed");
}

/** Read the leaf as a pass reader does. */
async function read(): Promise<string> {
  const outcome = await readDurableOperationLeafBuffer(root, leaf, dir, CAP, scanned);
  return outcome.kind === "ok" ? outcome.body.toString("utf8") : outcome.kind;
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), "scanned-leaf-")));
  dir = path.join(root, "store");
  leaf = path.join(dir, "run.json");
  scanned = scannedLeafBytes();
  await mkdir(dir);
  await writeFile(leaf, "first");
});

afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe("walk-held leaf bytes", () => {
  it("holds the walk's bytes for an unchanged leaf, and nothing for a leaf over the cap", async () => {
    await walkLeaf();
    expect(scanned.heldFor(root, leaf, dir, CAP)?.body.toString("utf8")).toBe("first");
    expect(scanned.heldFor(root, leaf, dir, 4)).toBeUndefined();
    expect(await read()).toBe("first");
  });

  it("reads the disk again once the leaf is replaced, removed, or its parent is swapped", async () => {
    await walkLeaf();
    await writeFile(path.join(dir, "next"), "second");
    await rename(path.join(dir, "next"), leaf);
    expect(await read()).toBe("second");
    await unlink(leaf);
    expect(await read()).toBe("absent");
    await writeFile(leaf, "first");
    await walkLeaf();
    await rename(dir, path.join(root, "moved"));
    await symlink(path.join(root, "moved"), dir);
    expect(await read()).toBe("unavailable");
  });

  it("refuses a held leaf whose reserved links stopped being exact", async () => {
    await walkLeaf();
    await writeFile(`${leaf}.tmp`, "foreign");
    expect(await read()).toBe("unavailable");
    await unlink(`${leaf}.tmp`);
    await walkLeaf();
    await link(leaf, path.join(root, "outside-link"));
    expect(await read()).toBe("unavailable");
  });
});
