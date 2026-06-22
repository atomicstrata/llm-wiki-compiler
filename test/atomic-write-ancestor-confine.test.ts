/**
 * @file test/atomic-write-ancestor-confine.test.ts
 * @description FIX 2 — atomicWrite's optional confineRoot closes the ancestor-
 * symlink escape. `mkdir(dir,{recursive})` runs before the immediate-parent
 * lstat guard, so an absent leaf below a symlinked ANCESTOR is created THROUGH
 * the symlink and the leaf-parent lstat then sees a real dir and passes — the
 * write escapes root. When `confineRoot` is provided, atomicWrite resolves the
 * nearest existing ancestor's realpath and refuses (fail closed) before any
 * mkdir if it escapes root. Omitting confineRoot preserves today's behavior.
 */

import { describe, it, expect } from "vitest";
import { symlink, mkdir, readFile, readdir } from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import { atomicWrite } from "../src/utils/markdown.js";
import { useConfinementRoots } from "./fixtures/confinement-roots.js";

const ctx = useConfinementRoots("ancestor-confine");

/** Plant a symlinked grandparent dir whose absent leaf escapes root. */
async function plantEscapingAncestor(root: string, outside: string): Promise<string> {
  const glink = path.join(root, "glink");
  await symlink(outside, glink); // grandparent symlink → out of tree
  return path.join(glink, "sub", "evil.md"); // leaf + parent absent
}

describe("atomicWrite ancestor-symlink confinement", () => {
  it("fails closed with confineRoot when an ancestor dir is a symlink out of tree", async () => {
    const { root, outside } = ctx;
    const target = await plantEscapingAncestor(root, outside);

    await expect(atomicWrite(target, "evil", { confineRoot: root })).rejects.toThrow();

    expect(existsSync(path.join(outside, "sub"))).toBe(false); // nothing created outside
  });

  it("WITHOUT confineRoot keeps today's behavior (escape not blocked at ancestor)", async () => {
    const { root, outside } = ctx;
    const target = await plantEscapingAncestor(root, outside);
    // Today's primitive only lstats the immediate parent (a real dir created
    // through the symlink), so the write lands outside. This documents the gap
    // that confineRoot closes; we assert the write does NOT throw on confinement.
    await atomicWrite(target, "legacy");
    expect(await readFile(path.join(outside, "sub", "evil.md"), "utf-8")).toBe("legacy");
  });

  it("a normal in-root write with confineRoot succeeds byte-identically", async () => {
    const { root } = ctx;
    const target = path.join(root, "wiki", "concepts", "x.md");
    await atomicWrite(target, "body", { confineRoot: root });
    expect(await readFile(target, "utf-8")).toBe("body");
    expect((await readdir(path.dirname(target))).filter((f) => f.endsWith(".tmp"))).toHaveLength(0);
  });

  it("allows an in-root nested dir under confineRoot (no false rejection)", async () => {
    const { root } = ctx;
    await mkdir(path.join(root, "wiki"), { recursive: true });
    const target = path.join(root, "wiki", "deep", "y.md");
    await atomicWrite(target, "ok", { confineRoot: root });
    expect(await readFile(target, "utf-8")).toBe("ok");
  });
});
