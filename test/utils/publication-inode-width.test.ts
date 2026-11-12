/**
 * @file test/utils/publication-inode-width.test.ts
 * @description Synthetic high-inode collision regression for the final
 * committed-temp unlink guard. Real filesystems need not allocate such IDs.
 */

import type { BigIntStats, PathLike, StatOptions, Stats } from "node:fs";
import * as fsPromises from "fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, spyOn } from "bun:test";
import { removeCommittedTemp } from "../../src/utils/atomic-write-no-replace-durable.js";
import * as fsMetadata from "../../src/utils/fs-metadata.js";

const HIGH_INODE = 9_007_199_254_740_992n;

/**
 * A stand-in for `lstat` that answers the chosen paths with synthetic BigIntStats
 * ONLY when the caller asks for `bigint: true` (the production call does), and
 * delegates every other call, path or option, to the real `lstat`. `lstat` is
 * overloaded and a mock is typed by its LAST overload (Stats), so the stand-in
 * declares the same overloads: a `bigint: false` or default request can never
 * receive a BigIntStats from it.
 */
function lstatSeam(real: typeof fsPromises.lstat, synthetic: ReadonlyMap<string, BigIntStats>) {
  function seam(file: PathLike, options?: StatOptions & { bigint?: false }): Promise<Stats>;
  function seam(file: PathLike, options: StatOptions & { bigint: true }): Promise<BigIntStats>;
  function seam(file: PathLike, options?: StatOptions): Promise<Stats | BigIntStats>;
  async function seam(file: PathLike, options?: StatOptions): Promise<Stats | BigIntStats> {
    const hit = options?.bigint === true && typeof file === "string" ? synthetic.get(file) : undefined;
    return hit ?? real(file, options);
  }
  return seam;
}

describe("committed-temp inode precision", () => {
  it("refuses an unsafe numeric identity before unlinking its path", async () => {
    const parent = await fsPromises.mkdtemp(path.join(tmpdir(), "pub-inode-"));
    const leaf = path.join(parent, "ready.tmp");
    await fsPromises.writeFile(leaf, "foreign");
    const expected = { dev: 1, ino: Number(HIGH_INODE + 1n) } as Stats;
    const roundedActual = { dev: 1, ino: Number(HIGH_INODE) } as Stats;
    expect(expected.ino).toBe(roundedActual.ino);
    const realLstat = fsPromises.lstat;
    // No synthetic answer exists here: the imprecise identity must be refused before ANY lstat.
    const seam = spyOn(fsMetadata, "lstat").mockImplementation(lstatSeam(realLstat, new Map()));
    try {
      await expect(removeCommittedTemp(leaf, undefined, expected)).rejects.toThrow();
      expect(seam).not.toHaveBeenCalled();
      expect(await fsPromises.readFile(leaf, "utf8")).toBe("foreign");
    } finally {
      seam.mockRestore();
      await fsPromises.rm(parent, { recursive: true, force: true });
    }
  });

  it("accepts a full-width match and refuses an adjacent high inode", async () => {
    const parent = await fsPromises.mkdtemp(path.join(tmpdir(), "pub-inode-"));
    const matched = path.join(parent, "matched.tmp");
    const swapped = path.join(parent, "swapped.tmp");
    await fsPromises.writeFile(matched, "owned");
    await fsPromises.writeFile(swapped, "foreign");
    const expected = { dev: 1n, ino: HIGH_INODE + 1n } as BigIntStats;
    const realLstat = fsPromises.lstat;
    const adjacent = { dev: 1n, ino: HIGH_INODE } as BigIntStats;
    const answers = new Map([[matched, expected], [swapped, adjacent]]);
    const seam = spyOn(fsMetadata, "lstat").mockImplementation(lstatSeam(realLstat, answers));
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
