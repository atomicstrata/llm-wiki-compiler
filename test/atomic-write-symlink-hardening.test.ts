/**
 * @file test/atomic-write-symlink-hardening.test.ts
 * @description Close the systemic leaf-symlink WRITE-ESCAPE class at the shared
 * atomic-write primitive. The old `writeFile(<path>.tmp)` FOLLOWED a pre-planted
 * symlinked temp leaf, redirecting the write OUTSIDE the project root. The
 * hardened `atomicWrite` uses a RANDOM temp name opened with `O_EXCL`, so a
 * symlink at the predictable `<path>.tmp` is sidestepped and a symlink at the
 * random temp would fail the open (EEXIST). These tests prove no write escapes
 * root via the temp LEAF and that normal writes still succeed. (The symlinked
 * parent-DIR guard is covered by atomic-write-confine-race.test.ts.)
 */

import { describe, it, expect } from "vitest";
import { symlink, readdir, readFile, writeFile } from "fs/promises";
import path from "path";
import { atomicWrite } from "../src/utils/markdown.js";
import { useConfinementRoots } from "./fixtures/confinement-roots.js";

const ctx = useConfinementRoots("leaf");

describe("atomicWrite leaf-symlink write-escape hardening", () => {
  it("sidesteps a symlink planted at the OLD predictable <path>.tmp name", async () => {
    const { root, outside } = ctx;
    const target = path.join(root, "page.md");
    const sink = path.join(outside, "sink");
    await writeFile(sink, "original", "utf-8");
    await symlink(sink, `${target}.tmp`); // the old predictable temp leaf

    await atomicWrite(target, "safe-body");

    expect(await readFile(target, "utf-8")).toBe("safe-body"); // target written
    expect(await readFile(sink, "utf-8")).toBe("original"); // outside untouched
  });

  // The symlinked-PARENT-DIR guard is covered by atomic-write-confine-race.test.ts;
  // this suite owns the LEAF-symlink escape that the random O_EXCL temp closes.

  it("still writes correctly to a real path (regression)", async () => {
    const target = path.join(ctx.root, "sub", "page.md");
    await atomicWrite(target, "body");
    expect(await readFile(target, "utf-8")).toBe("body");
  });

  it("overwrites an existing real target without leaking a stale temp", async () => {
    const { root } = ctx;
    const target = path.join(root, "page.md");
    await atomicWrite(target, "v1");
    await atomicWrite(target, "v2");
    expect(await readFile(target, "utf-8")).toBe("v2");
    expect((await readdir(root)).filter((f) => f.endsWith(".tmp"))).toHaveLength(0);
  });
});
