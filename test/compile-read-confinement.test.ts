/**
 * Tests for the compile-side confined wiki-read helpers.
 *
 * `readConfinedWikiPage` / `readConfinedWikiFile` confine a wiki read to an
 * EXACT expected directory and return a discriminated `{content}` | `{dropped}`.
 * A symlink that escapes the expected dir is DROPPED — its target bytes are
 * NEVER returned. These tests assert the legit read AND every dropped path
 * (escape, absent file, missing root) so no out-of-tree bytes can leak into a
 * planned write or an LLM prompt.
 */

import { describe, it, expect } from "vitest";
import { writeFile, symlink, rm, mkdir } from "fs/promises";
import path from "path";
import { makeTempRoot } from "./fixtures/temp-root.js";
import { makeOutsideDir } from "./fixtures/outside-dir.js";
import {
  readConfinedWikiPage,
  readConfinedWikiFile,
} from "../src/compiler/confined-wiki-read.js";

describe("readConfinedWikiPage", () => {
  it("returns the real bytes for a real in-dir page", async () => {
    const root = await makeTempRoot("cwr-page-ok");
    await writeFile(path.join(root, "wiki/concepts/foo.md"), "real-body");
    expect(await readConfinedWikiPage(root, "wiki/concepts", "foo")).toEqual({
      content: "real-body",
    });
  });

  it("drops a symlink-escaping page without returning the target bytes", async () => {
    const root = await makeTempRoot("cwr-page-escape");
    const outside = await makeOutsideDir();
    await writeFile(path.join(outside, "secret.md"), "OUTSIDE-secret");
    await symlink(
      path.join(outside, "secret.md"),
      path.join(root, "wiki/concepts/foo.md"),
    );
    const out = await readConfinedWikiPage(root, "wiki/concepts", "foo");
    expect(out).toEqual({ dropped: "escapes-dir" });
    expect(out).not.toHaveProperty("content");
  });

  it("drops an absent page as escapes-dir (safeRealpath null)", async () => {
    const root = await makeTempRoot("cwr-page-absent");
    expect(await readConfinedWikiPage(root, "wiki/concepts", "missing")).toEqual({
      dropped: "escapes-dir",
    });
  });

  it("drops as unreadable when realpath+confinement pass but the read fails closed", async () => {
    // A directory named `<slug>.md` is a real in-dir path: `safeRealpath` +
    // `isInsideDir` both pass, so the helper proceeds to `readConfinedPage` —
    // which opens no-follow and rejects a non-regular file (st.isFile() false),
    // returning null. This drives the `unreadable` arm through the helper's own
    // surface (no seam needed); the inode-mismatch null path that also yields
    // `unreadable` is exhaustively covered by readConfinedPage's own suite.
    const root = await makeTempRoot("cwr-page-unreadable");
    await mkdir(path.join(root, "wiki/concepts/foo.md"));
    expect(await readConfinedWikiPage(root, "wiki/concepts", "foo")).toEqual({
      dropped: "unreadable",
    });
  });

  it("drops with no-root when the root does not exist", async () => {
    const root = path.join(await makeOutsideDir(), "does-not-exist");
    await rm(root, { recursive: true, force: true });
    expect(await readConfinedWikiPage(root, "wiki/concepts", "foo")).toEqual({
      dropped: "no-root",
    });
  });
});

describe("readConfinedWikiFile", () => {
  it("returns the real bytes for a real in-tree file", async () => {
    const root = await makeTempRoot("cwr-file-ok");
    await writeFile(path.join(root, "wiki/index.md"), "index-body");
    expect(await readConfinedWikiFile(root, "wiki/index.md")).toEqual({
      content: "index-body",
    });
  });

  it("drops a symlinked index.md without returning the target bytes", async () => {
    const root = await makeTempRoot("cwr-file-escape");
    const outside = await makeOutsideDir();
    await writeFile(path.join(outside, "secret.md"), "OUTSIDE-secret");
    await symlink(path.join(outside, "secret.md"), path.join(root, "wiki/index.md"));
    const out = await readConfinedWikiFile(root, "wiki/index.md");
    expect(out).toEqual({ dropped: "escapes-dir" });
    expect(out).not.toHaveProperty("content");
  });

  it("drops with no-root when the root does not exist", async () => {
    const root = path.join(await makeOutsideDir(), "does-not-exist");
    await rm(root, { recursive: true, force: true });
    expect(await readConfinedWikiFile(root, "wiki/index.md")).toEqual({
      dropped: "no-root",
    });
  });
});
