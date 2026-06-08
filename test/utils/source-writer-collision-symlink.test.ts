/**
 * Bug 2: collision-suffix write path writes through a planted symlink.
 *
 * Before the fix, saveSource used plain writeFile(destPath, ...) for new sources.
 * If a symlink existed at the expected hash-suffixed destination (e.g.
 * sources/safe-<hash>.md → /outside.md), writeFile would follow it and overwrite
 * the outside file. The identity scan skips symlinks escaping sources/, so
 * existingByIdentity is null, and saveSource proceeds to the "created" path —
 * straight into writeFile on the symlink target.
 *
 * The fix: use writeFile with flag "wx" (exclusive create) for new-source writes
 * so that any pre-existing entry — including a symlink — causes EEXIST and a
 * PathSafetyError rather than silent overwrite.
 */
import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { saveSource } from "../../src/utils/source-writer.js";
import { createHash } from "node:crypto";

describe("saveSource never writes through a planted collision-suffix symlink", () => {
  it("refuses to overwrite an outside file via sources/<slug>-<hash>.md symlink", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sw-collide-"));
    await mkdir(path.join(root, "sources"), { recursive: true });
    // a DIFFERENT source already owns sources/safe.md (forces the hash-suffix path)
    await writeFile(path.join(root, "sources/safe.md"), "---\ntitle: Safe\nsource: other\n---\nother", "utf-8");
    // outside file we must NOT clobber
    const outside = path.join(root, "outside.md");
    await writeFile(outside, "ORIGINAL OUTSIDE", "utf-8");
    // plant the symlink at exactly the hash-suffixed name for source "poison"
    const hash = createHash("sha256").update("poison").digest("hex").slice(0, 8);
    await symlink(outside, path.join(root, `sources/safe-${hash}.md`));

    // ingest "poison" under slug "Safe" → would resolve to safe-<hash>.md (the symlink)
    const doc = "---\ntitle: Safe\nsource: poison\ningestedAt: 2026-01-01T00:00:00.000Z\n---\n\nnew body";
    await expect(saveSource(root, "Safe", doc, "poison")).rejects.toThrow(); // refuses to write through it
    expect(await readFile(outside, "utf-8")).toBe("ORIGINAL OUTSIDE"); // untouched
  });
});
