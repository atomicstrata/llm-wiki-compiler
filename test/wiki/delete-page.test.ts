/**
 * @file test/wiki/delete-page.test.ts
 * @description Coverage for the journalled page-delete primitive
 * (`src/wiki/delete-page.ts`) — the delete counterpart to
 * `test/compile-write.test.ts`'s coverage of the journalled write path.
 *
 * The suite pins the same contracts `applyCompilePageWritesLocked` gets:
 *  - a plain delete removes only the named pages, leaving siblings untouched;
 *  - a crash mid-batch (unlink succeeds, then the process dies) is recoverable —
 *    `replayJournal` restores the pre-state because `recordPreState` captured the
 *    page's bytes BEFORE the unlink landed;
 *  - a page that SURVIVES its unlink attempt (the failure `confinedUnlink`'s
 *    shared catch would otherwise swallow) makes the batch THROW instead of
 *    reporting success, leaving the page on disk and the batch pending;
 *  - a slug failing the filename floor is reported in `skipped`, never fatal to
 *    the rest of the batch (SKIP, NOT ABORT);
 *  - nothing to delete (absent page, or empty input) opens NO journal batch
 *    (EMPTY ⇒ NO-OP), so a no-op leaves no dangling recovery window;
 *  - a `wiki/concepts` symlink escaping the project root is refused, not
 *    followed — `recordPreState`'s parent-dir confinement fails the batch closed
 *    rather than deleting through it.
 */

import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, unlink, readdir, symlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { deleteWikiPagesLocked } from "../../src/wiki/delete-page.js";
import { replayJournal } from "../../src/trust/journal.js";

/** A temp project with `wiki/concepts/<slug>.md` for each given slug. */
async function projectWithPages(slugs: string[]): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "wiki-del-"));
  await mkdir(path.join(root, "wiki/concepts"), { recursive: true });
  for (const slug of slugs) {
    await writeFile(path.join(root, `wiki/concepts/${slug}.md`), `---\ntitle: ${slug}\n---\n${slug} body`, "utf-8");
  }
  return root;
}

describe("deleteWikiPagesLocked", () => {
  it("deletes the named pages and leaves the rest alone", async () => {
    const root = await projectWithPages(["alpha", "beta"]);

    const { skipped } = await deleteWikiPagesLocked(root, ["alpha"]);

    expect(skipped).toEqual([]);
    expect(existsSync(path.join(root, "wiki/concepts/alpha.md"))).toBe(false);
    expect(existsSync(path.join(root, "wiki/concepts/beta.md"))).toBe(true);
  });

  it("restores page bytes when the batch dies before commit", async () => {
    const root = await projectWithPages(["alpha"]);
    const page = path.join(root, "wiki/concepts/alpha.md");
    // Unlink for real, then throw — reproducing a crash inside the batch window.
    const crashing = async (target: string): Promise<void> => {
      await unlink(target);
      throw new Error("boom");
    };

    await expect(deleteWikiPagesLocked(root, ["alpha"], { unlinkOne: crashing })).rejects.toThrow("boom");
    expect(existsSync(page)).toBe(false); // the crash really did remove it

    await replayJournal(root);
    expect(await readFile(page, "utf-8")).toContain("alpha body"); // journal put it back
  });

  it("throws instead of reporting success when the page survives the unlink", async () => {
    const root = await projectWithPages(["alpha"]);
    // A no-op unlink models confinedUnlink swallowing EACCES/EROFS/EBUSY.
    const swallowed = async (): Promise<void> => {};

    await expect(deleteWikiPagesLocked(root, ["alpha"], { unlinkOne: swallowed })).rejects.toThrow(/alpha/);
    expect(existsSync(path.join(root, "wiki/concepts/alpha.md"))).toBe(true);
  });

  it("skips a slug that fails the filename floor without touching the batch", async () => {
    const root = await projectWithPages(["alpha"]);

    const { skipped } = await deleteWikiPagesLocked(root, ["../escape", "alpha"]);

    expect(skipped).toEqual([{ slug: "../escape", reason: "floor:unsafe-slug" }]);
    expect(existsSync(path.join(root, "wiki/concepts/alpha.md"))).toBe(false); // the safe one still went
  });

  it("is a no-op for an absent page and opens no batch for empty input", async () => {
    const root = await projectWithPages([]);
    const journalDir = path.join(root, ".llmwiki/journal");

    await expect(deleteWikiPagesLocked(root, ["ghost"])).resolves.toEqual({ skipped: [] });
    await expect(deleteWikiPagesLocked(root, [])).resolves.toEqual({ skipped: [] });

    const journalled = existsSync(journalDir) ? await readdir(journalDir) : [];
    expect(journalled).toEqual([]); // committed batches prune themselves; empty input opens none
  });

  it("fails closed rather than deleting through a symlinked concepts dir", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "wiki-del-sym-"));
    const outside = await mkdtemp(path.join(tmpdir(), "wiki-del-out-"));
    await mkdir(path.join(root, "wiki"), { recursive: true });
    const victim = path.join(outside, "alpha.md");
    await writeFile(victim, "content outside the project", "utf-8");
    // wiki/concepts is a symlink escaping the project root
    await symlink(outside, path.join(root, "wiki/concepts"));

    // recordPreState's parent-dir confinement rejects the escaping leaf.
    await expect(deleteWikiPagesLocked(root, ["alpha"])).rejects.toThrow();
    expect(existsSync(victim)).toBe(true); // nothing outside the project was touched
  });
});
