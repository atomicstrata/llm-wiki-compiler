/**
 * @file test/preparations/lifecycle-fs-operations.test.ts
 * @description Adversarial production-path checks that every Task 9B filesystem
 * operation refuses a redirected `.llmwiki` ancestor before reading or mutating
 * the decoy tree.
 */

import { mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { useTempRoot } from "../fixtures/temp-root.js";
import {
  captureLifecycleScopedObject,
  destroyQuarantineUnitBytes,
} from "../../src/preparations/lifecycle-fs/quarantine-operations.js";
import {
  writePruneReceiptBytes,
} from "../../src/preparations/lifecycle-fs/prune-protocol.js";
import {
  moveOldPreparationKey,
  writeResetUnitLeaf,
} from "../../src/preparations/lifecycle-fs/reset-operations.js";
import {
  preparationKeyFile,
  preparationQuarantineUnitPaths,
} from "../../src/preparations/paths.js";

/** Redirect the private root to an empty in-project decoy. */
async function redirectPrivateRoot(root: string): Promise<string> {
  const decoy = path.join(root, "decoy");
  await mkdir(decoy);
  await symlink(decoy, path.join(root, ".llmwiki"));
  return decoy;
}

import { mintLifecycleMutationPermit } from "../../src/preparations/lifecycle-mutation-permit.js";

describe("preparation lifecycle filesystem operations", () => {
  const root = useTempRoot();

  it("refuses a reset write through a redirected private root", async () => {
    const decoy = await redirectPrivateRoot(root.dir);
    await expect(writeResetUnitLeaf(
      root.dir,
      "rst-decoy",
      "intent",
      Buffer.from("{}"),
    )).rejects.toThrow("unavailable");
    expect(await readdir(decoy)).toEqual([]);
  });

  it("refuses a prune receipt write with no driver permit, before touching any path", async () => {
    // Task 9E gated this seam. The permit check now runs FIRST, so this call can
    // no longer reach the confinement check -- the assertion changed with the
    // code rather than being loosened to keep passing.
    //
    // Confinement through a redirected root is still proven, end to end and
    // through the driver, by PLA-REG-PRN-015 ("refuses to derive a sweep when the
    // prune registry root is a symlink"). Verified green, not assumed.
    const decoy = await redirectPrivateRoot(root.dir);
    await expect(writePruneReceiptBytes(
      undefined as never,
      root.dir,
      "prn-decoy",
      "prune-planned",
      Buffer.from("{}"),
    )).rejects.toThrow(/requires a driver-minted permit/u);
    expect(await readdir(decoy)).toEqual([]);
  });

  it("refuses quarantine custody reads through a redirected private root", async () => {
    const decoy = await redirectPrivateRoot(root.dir);
    await expect(captureLifecycleScopedObject(
      root.dir,
      "workspaces/example/leaf",
      1,
    )).rejects.toThrow("unavailable");
    expect(await readdir(decoy)).toEqual([]);
  });

  it("refuses a quarantine destroy with no driver permit, before touching any path", async () => {
    // Task 9E chunk C2 gated this seam, and bound it to `purge` specifically. The
    // permit check runs FIRST, so this call can no longer reach the confinement
    // check -- the assertion changed with the code rather than being loosened.
    //
    // Confinement through a redirected root is still proven end to end by
    // "refuses to purge through a unit symlinked out of the project, deleting
    // nothing" in quarantine.test.ts, which runs through the driver. Verified
    // green, not assumed.
    const decoy = await redirectPrivateRoot(root.dir);
    await expect(destroyQuarantineUnitBytes(
      undefined as never,
      root.dir,
      "qtn-decoy",
      [{ objectName: "obj-000000" }],
    )).rejects.toThrow(/requires a driver-minted permit/u);
    expect(await readdir(decoy)).toEqual([]);
  });

  it("refuses old-key custody through a redirected bytes directory", async () => {
    const paths = preparationQuarantineUnitPaths(root.dir, "rst-bytes-decoy");
    const decoy = path.join(root.dir, "bytes-decoy");
    await mkdir(paths.unitRoot, { recursive: true });
    await mkdir(decoy);
    await symlink(decoy, paths.bytesRoot);
    await writeFile(preparationKeyFile(root.dir), "old-key");
    // The permit is minted here because this test exercises the filesystem layer
    // BELOW the driver; without it the permit check refuses first and the
    // confinement refusal this test exists for would never be reached.
    await expect(moveOldPreparationKey(
      root.dir, "rst-bytes-decoy",
      mintLifecycleMutationPermit("reset", "rst-bytes-decoy"),
    )).rejects.toThrow("bytes directory");
    expect(await readFile(preparationKeyFile(root.dir), "utf8")).toBe("old-key");
    expect(await readdir(decoy)).toEqual([]);
  });
});
