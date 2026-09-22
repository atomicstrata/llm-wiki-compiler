/**
 * @file test/atomic-write-create-only.test.ts
 * @description Contract tests for Task 4's byte-safe create-only atomic
 * writer surface. They prove a collision cannot overwrite existing bytes.
 */

import { mkdir, readFile, rename, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AtomicWriteCollisionError, atomicWrite, atomicWriteNoReplace } from "../src/utils/atomic-write.js";
import { useTempRoot } from "./fixtures/temp-root.js";

const root = useTempRoot();

describe("atomicWrite createOnly", () => {
  it("snapshots mutable bytes before the overwrite path reaches its first await", async () => {
    const target = path.join(root.dir, "mutable-overwrite", "record");
    const bytes = Buffer.from("original");

    const writing = atomicWrite(target, bytes, { confineRoot: root.dir });
    bytes.fill(0x78);
    await writing;

    expect(await readFile(target, "utf8")).toBe("original");
  });

  it("snapshots mutable bytes before the no-replace path reaches its first await", async () => {
    const target = path.join(root.dir, "mutable-create", "record");
    const bytes = Buffer.from("original");

    const writing = atomicWriteNoReplace(target, bytes, { confineRoot: root.dir });
    bytes.fill(0x78);
    await writing;

    expect(await readFile(target, "utf8")).toBe("original");
  });

  it("publishes Uint8Array bytes without changing string overwrite behavior", async () => {
    const target = path.join(root.dir, "bytes", "record");
    const bytes = Buffer.from([0, 255, 1, 2]);

    await atomicWrite(target, bytes, { createOnly: true, confineRoot: root.dir });
    await atomicWrite(path.join(root.dir, "string"), "text", { confineRoot: root.dir });

    expect(await readFile(target)).toEqual(bytes);
    expect(await readFile(path.join(root.dir, "string"), "utf8")).toBe("text");
  });

  it("rejects a different existing leaf without replacing it", async () => {
    const target = path.join(root.dir, "collision", "record");
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, Buffer.from("original"));

    await expect(atomicWrite(target, Buffer.from("replacement"), {
      createOnly: true, confineRoot: root.dir,
    })).rejects.toBeInstanceOf(AtomicWriteCollisionError);

    expect(await readFile(target, "utf8")).toBe("original");
  });

  it("refuses a parent swapped to an escaping symlink before publishing", async () => {
    const parent = path.join(root.dir, "swapped");
    const outside = path.join(root.dir, "outside");
    await mkdir(parent);
    await mkdir(outside);

    const writing = atomicWrite(path.join(parent, "record"), Buffer.from("body"), {
      createOnly: true, confineRoot: root.dir,
      afterParentCheckForTest: async () => {
        await rename(parent, `${parent}-original`);
        await symlink(outside, parent, "dir");
      },
    });

    await expect(writing).rejects.toThrow(/changed|symlink|escape/i);
    await expect(readFile(path.join(outside, "record"))).rejects.toThrow();
  });
});
