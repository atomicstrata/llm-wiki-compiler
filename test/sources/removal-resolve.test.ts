/**
 * @file test/sources/removal-resolve.test.ts
 * @description Coverage for how `llmwiki rm` resolves its `<source>` argument,
 * exercised through `planRemoval` (`src/sources/removal.ts`) — the only caller,
 * and the level at which the resolution rules are actually observable.
 *
 * Two outcomes are pinned. A ref that names nothing collapses to a single
 * `null`, so the CLI has ONE "no such source" branch rather than a taxonomy: a
 * `.md` suffix is appended when omitted (ergonomics), and an absent name, a
 * path-unsafe ref (a URL or a `..` traversal — both fail `assertSafeSourceId`,
 * which THROWS rather than returning false), and a symlinked `sources/` entry
 * all land there rather than raising.
 *
 * The other is the RESUME path, added for maintainer review item 2: `rm`
 * deletes the source file before the fallible page batch, so a failure leaves
 * the file gone and its state entry behind. That pairing must resolve, or the
 * retry a user reaches for first reports "no such source" and exits while the
 * pages are still on disk. It is deliberately narrow — a symlink occupying the
 * name is present, not absent, so it stays unresolvable even when state
 * carries an entry for it.
 */

import { describe, it, expect } from "vitest";
import { writeFile, symlink, rm } from "node:fs/promises";
import path from "node:path";
import { planRemoval } from "../../src/sources/removal.js";
import { makeEmptyRmProject } from "../fixtures/rm-project.js";
import type { WikiState } from "../../src/utils/types.js";

/** Write a state whose only entry is `id`, owning one exclusive concept. */
async function seedStateFor(root: string, id: string): Promise<void> {
  const state: WikiState = {
    version: 1,
    indexHash: "h",
    sources: { [id]: { hash: "a", concepts: ["junk"], compiledAt: "2026-01-01T00:00:00Z" } },
  };
  await writeFile(path.join(root, ".llmwiki/state.json"), JSON.stringify(state), "utf-8");
}

/** A temp project holding one real, compiled source at `sources/note.md`. */
async function projectWithSource(): Promise<string> {
  const root = await makeEmptyRmProject();
  await writeFile(path.join(root, "sources/note.md"), "---\ntitle: Note\nsource: s\n---\nbody", "utf-8");
  await writeFile(path.join(root, "wiki/concepts/junk.md"), "---\ntitle: Junk\n---\njunk", "utf-8");
  await seedStateFor(root, "note.md");
  return root;
}

describe("planRemoval ref resolution", () => {
  it("accepts a basename with or without the .md suffix", async () => {
    const root = await projectWithSource();

    expect((await planRemoval(root, "note.md"))?.sourceFile).toBe("note.md");
    expect((await planRemoval(root, "note"))?.sourceFile).toBe("note.md");
  });

  it("returns null for a name that is neither on disk nor in state", async () => {
    const root = await projectWithSource();

    expect(await planRemoval(root, "missing.md")).toBeNull();
  });

  it("returns null rather than throwing for a path-unsafe ref", async () => {
    const root = await projectWithSource();

    // A URL and a traversal both fail assertSafeSourceId; neither may throw out.
    expect(await planRemoval(root, "https://example.com/x")).toBeNull();
    expect(await planRemoval(root, "../../etc/passwd")).toBeNull();
  });

  it("refuses a symlinked entry, matching getSource and deleteSource", async () => {
    const root = await projectWithSource();
    await writeFile(path.join(root, "secret.txt"), "SECRET", "utf-8");
    await symlink(path.join(root, "secret.txt"), path.join(root, "sources/leak.md"));

    expect(await planRemoval(root, "leak.md")).toBeNull();
  });

  it("resolves a source whose file is gone but whose state entry survives, so an interrupted rm can be retried", async () => {
    const root = await projectWithSource();
    await rm(path.join(root, "sources/note.md")); // as a failed rm would leave it

    const plan = await planRemoval(root, "note.md");

    expect(plan?.sourceFile).toBe("note.md");
    expect(plan?.deleteSlugs).toEqual(["junk"]); // the pages the failed run never got to
    expect(plan?.sourcePresent).toBe(false); // so the CLI can't claim to delete it again
  });

  it("does not treat a symlink occupying the name as an interrupted removal, even with a state entry", async () => {
    const root = await projectWithSource();
    await writeFile(path.join(root, "secret.txt"), "SECRET", "utf-8");
    await symlink(path.join(root, "secret.txt"), path.join(root, "sources/leak.md"));
    await seedStateFor(root, "leak.md");

    // Present-but-invalid is not absent: only a genuinely missing file means a
    // previous removal got partway.
    expect(await planRemoval(root, "leak.md")).toBeNull();
  });
});
