/**
 * @file test/compile-derived-confine.test.ts
 * @description The derived-projection writes (wiki/index.md and wiki/MOC.md) must
 * fail CLOSED rather than redirect a write outside the project root when wiki/ is
 * a symlink that escapes root.
 *
 * Honest scope note on confineRoot's role here: for these one-level paths
 * (wiki/index.md, wiki/MOC.md) the escaping symlink IS the immediate parent
 * (wiki/), so atomicWrite's ALWAYS-ON `assertParentNotSymlink` (an lstat of the
 * immediate parent) already rejects the planted wiki/→outside symlink — these
 * fail-closed assertions hold WITH OR WITHOUT the confineRoot argument. The
 * `{ confineRoot: root }` we added is therefore NOT what closes a hole these
 * tests could otherwise demonstrate; its value is (a) defense-in-depth — a
 * second, independent guard (the pre-mkdir ancestor-realpath check plus the
 * post-mkdir TOCTOU re-check) on the same write, which would bite if the
 * escaping ancestor were ever NOT the immediate parent or were swapped in
 * mid-write — and (b) aligning the derived index/MOC writes with the
 * page-generation write path, which already passes `confineRoot: root`, so
 * "derived" does not silently mean "less protected." A clean test where the
 * parent-lstat is blind but confineRoot alone catches the escape is not
 * constructible for a fixed one-level target (there is no ancestor above wiki/
 * but below root), and the dedicated guard already has direct coverage in
 * test/atomic-write-ancestor-confine.test.ts; we do not fabricate one here.
 *
 * Each surface asserts two real properties:
 *   1. A symlink-escaping wiki/ dir → atomicWrite rejects (fails closed via its
 *      confinement guards) and NOTHING is written to the outside target.
 *   2. A normal (no-symlink) invocation still writes the file (confineRoot is
 *      parity-safe — it never alters a legitimate in-root write).
 */

import { describe, it, expect } from "vitest";
import { mkdir, symlink, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { generateIndex } from "../src/compiler/indexgen.js";
import { generateMOC } from "../src/compiler/obsidian.js";
import { INDEX_FILE, MOC_FILE } from "../src/utils/constants.js";
import { useConfinementRoots } from "./fixtures/confinement-roots.js";

const ctx = useConfinementRoots("derived-confine");

/**
 * Replace wiki/ with a symlink pointing outside root, so any write to
 * wiki/index.md or wiki/MOC.md would land out of tree. Returns nothing — the
 * out-of-root escape target is the caller's `outside` dir.
 */
async function plantEscapingWikiDir(root: string, outside: string): Promise<void> {
  await symlink(outside, path.join(root, "wiki"));
}

/** Set up a minimal concepts dir inside root for a normal (non-escaping) run. */
async function makeConceptsDir(root: string): Promise<void> {
  await mkdir(path.join(root, "wiki", "concepts"), { recursive: true });
}

describe("generateIndex derived-write confinement", () => {
  it("fails closed (no out-of-root write) when wiki/ is a symlinked escape", async () => {
    const { root, outside } = ctx;
    await plantEscapingWikiDir(root, outside);

    await expect(generateIndex(root)).rejects.toThrow();

    // The outside target must remain unwritten.
    expect(existsSync(path.join(outside, "index.md"))).toBe(false);
  });

  it("writes wiki/index.md normally when no symlink is present (parity-safe)", async () => {
    const { root } = ctx;
    await makeConceptsDir(root);

    await generateIndex(root);

    const written = await readFile(path.join(root, INDEX_FILE), "utf-8");
    expect(written).toContain("# Knowledge Wiki");
    expect(written).toContain("0 pages");
  });
});

describe("generateMOC derived-write confinement", () => {
  it("fails closed (no out-of-root write) when wiki/ is a symlinked escape", async () => {
    const { root, outside } = ctx;
    await plantEscapingWikiDir(root, outside);

    await expect(generateMOC(root)).rejects.toThrow();

    // The outside target must remain unwritten.
    expect(existsSync(path.join(outside, "MOC.md"))).toBe(false);
  });

  it("writes wiki/MOC.md normally when no symlink is present (parity-safe)", async () => {
    const { root } = ctx;
    await makeConceptsDir(root);

    await generateMOC(root);

    const written = await readFile(path.join(root, MOC_FILE), "utf-8");
    expect(written).toContain("# Map of Content");
  });
});
