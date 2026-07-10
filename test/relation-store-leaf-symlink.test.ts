/**
 * @file test/relation-store-leaf-symlink.test.ts
 * @description Leaf-defense regression for the relation store FILE (audit FIX):
 * the graph DIR and the compaction TEMP leaf were confined, but the canonical
 * store FILE leaf `wiki/graph/relations.jsonl` was NOT. A pre-planted SYMLINK at
 * that leaf — pointing to an OUT-OF-TREE file that already carries a valid
 * relation-store header — must NOT be followed: the no-follow open fails the
 * append/read closed (ELOOP), so no record ever lands outside root and a read
 * never returns the outside content.
 *
 * Covers: append/create fails closed (outside file UNCHANGED, leaf still a
 * symlink — never written through); read fails closed (does not return the
 * outside content); a NORMAL real-file store still appends + reads (regression).
 */

import { describe, it, expect } from "vitest";
import { mkdir, symlink, writeFile, readFile, lstat } from "node:fs/promises";
import path from "node:path";
import { RELATIONS_FILE, WIKI_GRAPH_DIR } from "../src/utils/constants.js";
import { readRelations } from "../src/relations/store-read.js";
import { useConfinementRoots } from "./fixtures/confinement-roots.js";
import { appendTestRelation, expectNormalAppendAndRead } from "./fixtures/relation-confine.js";

const ctx = useConfinementRoots("rel-leaf");
const storePath = (): string => path.join(ctx.root, RELATIONS_FILE);
/** An out-of-tree file pre-seeded with a VALID relation-store header line. */
const outsideStore = (): string => path.join(ctx.outside, "outside-store.jsonl");

/** Plant `relations.jsonl` as a symlink to a header-bearing out-of-tree file. */
async function plantLeafSymlink(): Promise<string> {
  await mkdir(path.join(ctx.root, WIKI_GRAPH_DIR), { recursive: true });
  const header = JSON.stringify({ kind: "relation-store-header", schemaVersion: 1 }) + "\n";
  await writeFile(outsideStore(), header, "utf8");
  await symlink(outsideStore(), storePath());
  return header;
}

describe("relation store FILE-leaf no-follow (symlink write-escape)", () => {
  it("append fails closed; outside file UNCHANGED and leaf still a symlink", async () => {
    const header = await plantLeafSymlink();
    await expect(appendTestRelation(ctx.root)).rejects.toThrow();
    expect(await readFile(outsideStore(), "utf8")).toBe(header); // no record appended
    expect((await lstat(storePath())).isSymbolicLink()).toBe(true); // never written through
  });

  it("read fails closed; does NOT return the outside content", async () => {
    await plantLeafSymlink();
    await expect(readRelations(ctx.root)).rejects.toThrow();
  });

  it("a NORMAL real-file store still appends + reads fine (regression)", async () => {
    await expectNormalAppendAndRead(ctx.root);
    expect((await lstat(storePath())).isSymbolicLink()).toBe(false);
  });
});
