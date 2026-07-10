/**
 * @file test/journal-revert-confined.test.ts
 * @description Coverage for the HARDENED, re-confined journal revert path.
 *
 * Before this hardening, replay re-confined every target ONCE up front (via the
 * whole-batch gate) and then did a raw `mkdir`+`writeFile`/`unlink` to that
 * previously-computed path. A parent directory swapped to a symlink that escapes
 * root AFTER that confinement — but before the write/delete — would let the
 * revert land OUTSIDE the project (confine→act TOCTOU).
 *
 * The revert now RE-CONFINES each target immediately before acting and restores
 * content via the hardened `atomicWrite(confinedPath, content, { confineRoot })`,
 * which rejects a symlinked parent directory. This test plants an escaping
 * symlink as a target's parent and drives the revert through the public recovery
 * surface, asserting the outside file is never written/overwritten — the revert
 * fails closed rather than escaping root.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFile, readFile, mkdir, symlink, rm, mkdtemp } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { revertEntry, type JournalEntry } from "../src/trust/journal.js";
import { makeTrustRoot, cleanupTrustRoot } from "./trust/fixture.js";

let root: string;
let outsideDir: string;

beforeEach(async () => {
  root = await makeTrustRoot("journal-revert-confined-");
  outsideDir = await mkdtemp(path.join(tmpdir(), "journal-revert-outside-"));
});

afterEach(async () => {
  await cleanupTrustRoot(root);
  await rm(outsideDir, { recursive: true, force: true });
});

describe("revertEntry — content restore through a symlinked parent dir", () => {
  it("fails closed: does not write the restored bytes outside root", async () => {
    // `leak/` inside root is a symlink to an outside directory; a restore that
    // followed it would write `escaped.md` into `outsideDir`, escaping the project.
    await symlink(outsideDir, path.join(root, "leak"), "dir");
    const target = path.join(root, "leak", "escaped.md");
    const entry: JournalEntry = {
      targetPath: target,
      preState: { absent: false, content: "RESTORED-SECRET" },
    };

    await expect(revertEntry(entry, root)).rejects.toThrow();

    // Nothing landed in the outside directory the symlink points at.
    const escaped = path.join(outsideDir, "escaped.md");
    await expect(readFile(escaped, "utf-8")).rejects.toThrow();
  });
});

describe("revertEntry — delete through a symlinked parent dir", () => {
  it("fails closed: does not delete an outside file via an escaping parent", async () => {
    const outsideVictim = path.join(outsideDir, "victim.md");
    await writeFile(outsideVictim, "PRECIOUS", "utf-8");
    await symlink(outsideDir, path.join(root, "leak"), "dir");
    // An absent-pre-state entry whose path resolves THROUGH the escaping symlink.
    const entry: JournalEntry = {
      targetPath: path.join(root, "leak", "victim.md"),
      preState: { absent: true },
    };

    // Re-confining the delete target fails closed (parent escapes root) → throw.
    await expect(revertEntry(entry, root)).rejects.toThrow();

    // The outside victim survives — the confined unlink refused to escape root.
    expect(await readFile(outsideVictim, "utf-8")).toBe("PRECIOUS");
  });
});

describe("revertEntry — confined happy path still works", () => {
  it("restores prior bytes to an in-root target", async () => {
    const target = path.join(root, "wiki", "concepts", "page.md");
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, "NEW", "utf-8");
    const entry: JournalEntry = {
      targetPath: target,
      preState: { absent: false, content: "OLD" },
    };

    await revertEntry(entry, root);

    expect(await readFile(target, "utf-8")).toBe("OLD");
  });
});
