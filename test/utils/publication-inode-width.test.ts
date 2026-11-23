/**
 * @file test/utils/publication-inode-width.test.ts
 * @description Synthetic high-inode collision regression for the final
 * committed-temp unlink guard. Real filesystems need not allocate such IDs.
 */

import type { BigIntStats, Stats } from "node:fs";
import * as fsPromises from "fs/promises";
import path from "node:path";
import { describe, expect, it, spyOn } from "bun:test";
import { removeCommittedTemp } from "../../src/utils/atomic-write-no-replace-durable.js";

const HIGH_INODE = 9_007_199_254_740_992n;

describe("committed-temp inode precision", () => {
  it("refuses an unsafe numeric identity before unlinking its path", async () => {
    const parent = await fsPromises.mkdtemp(path.join(process.env.TMPDIR!, "pub-inode-"));
    const leaf = path.join(parent, "ready.tmp");
    await fsPromises.writeFile(leaf, "foreign");
    const expected = { dev: 1, ino: Number(HIGH_INODE + 1n) } as Stats;
    const roundedActual = { dev: 1, ino: Number(HIGH_INODE) } as Stats;
    expect(expected.ino).toBe(roundedActual.ino);
    const realLstat = fsPromises.lstat;
    let intercepted = false;
    const seam = spyOn(fsPromises, "lstat").mockImplementation(async (file, options) => {
      if (file === leaf) { intercepted = true; return roundedActual; }
      return realLstat(file, options);
    });
    try {
      await expect(removeCommittedTemp(leaf, undefined, expected)).rejects.toThrow();
      expect(intercepted).toBe(false);
      expect(await fsPromises.readFile(leaf, "utf8")).toBe("foreign");
    } finally {
      seam.mockRestore();
      await fsPromises.rm(parent, { recursive: true, force: true });
    }
  });

  it("accepts a full-width match and refuses an adjacent high inode", async () => {
    const parent = await fsPromises.mkdtemp(path.join(process.env.TMPDIR!, "pub-inode-"));
    const matched = path.join(parent, "matched.tmp");
    const swapped = path.join(parent, "swapped.tmp");
    await fsPromises.writeFile(matched, "owned");
    await fsPromises.writeFile(swapped, "foreign");
    const expected = { dev: 1n, ino: HIGH_INODE + 1n } as BigIntStats;
    const realLstat = fsPromises.lstat;
    const seam = spyOn(fsPromises, "lstat").mockImplementation(async (file, options) => {
      if (file === matched) return expected;
      if (file === swapped) return { dev: 1n, ino: HIGH_INODE } as BigIntStats;
      return realLstat(file, options);
    });
    try {
      await removeCommittedTemp(matched, undefined, expected);
      await expect(fsPromises.readFile(matched)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(removeCommittedTemp(swapped, undefined, expected)).rejects.toThrow();
      expect(await fsPromises.readFile(swapped, "utf8")).toBe("foreign");
    } finally {
      seam.mockRestore();
      await fsPromises.rm(parent, { recursive: true, force: true });
    }
  });
});
