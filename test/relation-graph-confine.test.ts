/**
 * @file test/relation-graph-confine.test.ts
 * @description Graph-parent confinement regression for the relation store
 * (audit FIX 1): a symlinked `wiki` PARENT must fail closed even when
 * `wiki/graph` itself does not yet exist, so a relation write can never mkdir +
 * append OUTSIDE the project root.
 *
 * Covers: append fails closed (nothing created outside root) when `wiki` is a
 * symlink escaping root and `wiki/graph` is absent; the normal (real dir) path
 * still appends + reads; and an EXISTING symlinked `wiki/graph` still fails
 * closed (regression of the prior leaf-only fix).
 */

import { describe, it, expect } from "vitest";
import { mkdir, symlink, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { useConfinementRoots } from "./fixtures/confinement-roots.js";
import { appendTestRelation, expectNormalAppendAndRead } from "./fixtures/relation-confine.js";

const ctx = useConfinementRoots("rel");
const append = () => appendTestRelation(ctx.root);

describe("relation graph-parent confinement (FIX 1)", () => {
  it("fails closed when `wiki` is a symlinked escape and `wiki/graph` is absent", async () => {
    await symlink(ctx.outside, path.join(ctx.root, "wiki")); // wiki -> outside; graph absent
    await expect(append()).rejects.toThrow(/escapes project root/);
    expect(existsSync(path.join(ctx.outside, "graph"))).toBe(false);
    expect(await readdir(ctx.outside)).toEqual([]); // nothing written outside root
  });

  it("still appends + reads fine on the normal real-directory path", async () => {
    await expectNormalAppendAndRead(ctx.root);
  });

  it("still fails closed when `wiki/graph` itself is a symlink (prior-fix regression)", async () => {
    await mkdir(path.join(ctx.root, "wiki"), { recursive: true });
    await symlink(ctx.outside, path.join(ctx.root, "wiki", "graph"));
    await expect(append()).rejects.toThrow(/escapes project root|not a directory/);
  });
});
