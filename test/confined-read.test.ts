/**
 * Tests for the handle-bound confined page-read helper.
 *
 * `readConfinedPage` binds the read to the OPENED HANDLE's {dev,ino}, not to a
 * path, so a TOCTOU parent-directory swap between open and the post-open check
 * is defeated. These tests exercise the legit reads AND every fail-closed path,
 * including a deterministic swap-back race that proves the {dev,ino} guard.
 */

import { describe, it, expect } from "vitest";
import { writeFile, symlink, rename, realpath, chmod } from "fs/promises";
import path from "path";
import { makeTempRoot } from "./fixtures/temp-root.js";
import { makeOutsideDir } from "./fixtures/outside-dir.js";
import { readConfinedPage, readConfinedPageOutcome } from "../src/utils/confined-read.js";

/** Resolve the canonical concepts dir + a captured realpath for one entry. */
async function captured(root: string, file: string) {
  const dir = await realpath(path.join(root, "wiki/concepts"));
  const real = await realpath(path.join(dir, file));
  return { dir, real };
}

/** A concepts dir + a captured realpath that ESCAPES it (an out-of-tree leaf). */
async function escapingLeaf(prefix: string) {
  const root = await makeTempRoot(prefix);
  const outside = await makeOutsideDir();
  await writeFile(path.join(outside, "leak.md"), "secret");
  const dir = await realpath(path.join(root, "wiki/concepts"));
  const escapedReal = await realpath(path.join(outside, "leak.md"));
  return { dir, escapedReal };
}

describe("readConfinedPage", () => {
  it("reads a normal in-dir file via the handle", async () => {
    const root = await makeTempRoot("confined-normal");
    await writeFile(path.join(root, "wiki/concepts/a.md"), "hello");
    const { dir, real } = await captured(root, "a.md");
    expect(await readConfinedPage(real, dir)).toBe("hello");
  });

  it("reads a legit IN-DIR symlinked page (alias -> original)", async () => {
    const root = await makeTempRoot("confined-alias");
    const dir = path.join(root, "wiki/concepts");
    await writeFile(path.join(dir, "original.md"), "orig-body");
    await symlink(path.join(dir, "original.md"), path.join(dir, "alias.md"));
    const { dir: cdir, real } = await captured(root, "alias.md");
    expect(await readConfinedPage(real, cdir)).toBe("orig-body");
  });

  it("fails closed on an escaping symlink (captured realpath outside dir)", async () => {
    const { dir, escapedReal } = await escapingLeaf("confined-escape");
    expect(await readConfinedPage(escapedReal, dir)).toBeNull();
  });

  it("fails closed when a parent dir is swapped OUT-of-tree after capture", async () => {
    const root = await makeTempRoot("confined-parent-swap");
    const dir = path.join(root, "wiki/concepts");
    await writeFile(path.join(dir, "a.md"), "in-tree");
    const { dir: cdir, real } = await captured(root, "a.md");
    const outside = await makeOutsideDir();
    await writeFile(path.join(outside, "a.md"), "evil");
    await rename(dir, dir + ".bak");
    await symlink(outside, dir);
    expect(await readConfinedPage(real, cdir)).toBeNull();
  });

  it("fails closed when a parent dir is swapped to an IN-ROOT SIBLING dir", async () => {
    const root = await makeTempRoot("confined-sibling-swap");
    const concepts = path.join(root, "wiki/concepts");
    const queries = path.join(root, "wiki/queries");
    await writeFile(path.join(concepts, "a.md"), "concept");
    await writeFile(path.join(queries, "a.md"), "query");
    const { dir: cdir, real } = await captured(root, "a.md");
    await rename(concepts, concepts + ".bak");
    await symlink(queries, concepts);
    expect(await readConfinedPage(real, cdir)).toBeNull();
  });

  it("defeats a leaf swapped to a different inode after open via {dev,ino} check", async () => {
    const root = await makeTempRoot("confined-swapback");
    const dir = path.join(root, "wiki/concepts");
    const leaf = path.join(dir, "a.md");
    await writeFile(leaf, "ORIGINAL-body"); // handle binds to this inode
    const { dir: cdir, real } = await captured(root, "a.md");
    // Seam fires AFTER open (handle bound to ORIGINAL inode) but BEFORE the
    // post-open check. We atomically replace the leaf with a DIFFERENT inode
    // at the SAME in-dir path — so the path post-check still resolves INSIDE
    // expectedDir, isolating the {dev,ino} guard as the thing that must catch it.
    const afterOpen = async () => {
      const decoy = path.join(dir, "decoy.md");
      await writeFile(decoy, "SWAPPED-body"); // new inode
      await rename(decoy, leaf); // a.md now points at the new inode
    };
    const out = await readConfinedPage(real, cdir, { afterOpenForTest: afterOpen });
    expect(out).not.toBe("SWAPPED-body"); // wrong-file content must NOT leak
    expect(out).toBeNull(); // {dev,ino} mismatch → fail closed
  });
});

describe("readConfinedPageOutcome — discriminated absence vs I/O fault", () => {
  it("returns ok with the body for a normal in-dir file", async () => {
    const root = await makeTempRoot("outcome-ok");
    await writeFile(path.join(root, "wiki/concepts/a.md"), "hello");
    const { dir, real } = await captured(root, "a.md");
    expect(await readConfinedPageOutcome(real, dir)).toEqual({ kind: "ok", body: "hello" });
  });

  it("classifies an escaping page as a CLEAN absent, not a fault", async () => {
    const { dir, escapedReal } = await escapingLeaf("outcome-escape");
    expect(await readConfinedPageOutcome(escapedReal, dir)).toEqual({ kind: "absent" });
  });

  it("classifies a permission-blocked page as UNREADABLE (park signal), not absent", async () => {
    if (process.getuid?.() === 0) return; // chmod 000 does not block root; skip
    const root = await makeTempRoot("outcome-eacces");
    const leaf = path.join(root, "wiki/concepts/a.md");
    await writeFile(leaf, "blocked");
    const { dir, real } = await captured(root, "a.md");
    await chmod(leaf, 0o000);
    try {
      const out = await readConfinedPageOutcome(real, dir);
      expect(out.kind).toBe("unreadable");
      expect(out.kind === "unreadable" && out.cause.code).toBe("EACCES");
    } finally {
      await chmod(leaf, 0o644);
    }
  });
});
