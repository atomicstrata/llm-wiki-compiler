/**
 * @file test/atomic-write-confine-race.test.ts
 * @description FIX S3 — close the confine→write TOCTOU window in `atomicWrite`.
 *
 * Callers resolve a write target with `confineUnderRoot(..., {mustExist:false})`,
 * which returns a LEXICAL path after checking the nearest EXISTING ancestor.
 * Between that check and the rename, the final directory can be swapped for a
 * symlink that escapes the project root, so the write would land outside.
 *
 * `atomicWrite` lacks root context, so it fails CLOSED on the actual escape
 * vector: it refuses to write when its parent directory is a SYMLINK. This test
 * mirrors the confirmed exploit — confine a path under a real dir, replace that
 * dir with a symlink to an out-of-tree location, then attempt the write — and
 * asserts nothing is written outside the project.
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, rename, symlink, readdir } from "fs/promises";
import { existsSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { confineUnderRoot } from "../src/utils/path-confine.js";
import { atomicWrite } from "../src/utils/markdown.js";

let root = "";
let outside = "";

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  if (outside) await rm(outside, { recursive: true, force: true });
  root = outside = "";
});

describe("atomicWrite confine→write race (S3)", () => {
  it("refuses to write through a final dir swapped to an escaping symlink", async () => {
    root = await mkdtemp(path.join(tmpdir(), "s3-root-"));
    outside = await mkdtemp(path.join(tmpdir(), "s3-out-"));
    await mkdir(path.join(root, "concepts"), { recursive: true });

    // Confinement passes against the REAL dir (the legitimate pre-write state).
    const target = await confineUnderRoot("concepts/leak.md", root, { mustExist: false });

    // Race: swap the confined parent dir for a symlink that escapes root.
    await rename(path.join(root, "concepts"), path.join(root, "concepts.real"));
    await symlink(outside, path.join(root, "concepts"), "dir");

    await expect(atomicWrite(target, "secret")).rejects.toThrow(/symlink/i);
    expect(existsSync(path.join(outside, "leak.md"))).toBe(false); // nothing escaped
    expect(await readdir(outside)).toHaveLength(0);
  });

  it("still writes normally into a real directory", async () => {
    root = await mkdtemp(path.join(tmpdir(), "s3-ok-"));
    await mkdir(path.join(root, "concepts"), { recursive: true });
    const target = path.join(root, "concepts", "page.md");
    await atomicWrite(target, "body");
    expect(existsSync(target)).toBe(true);
  });
});
