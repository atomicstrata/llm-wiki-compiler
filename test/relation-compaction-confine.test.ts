/**
 * @file test/relation-compaction-confine.test.ts
 * @description Confinement test for the compaction temp write (FIX 1).
 *
 * `compactRelations` rewrites the store via a RANDOM-named temp file opened with
 * O_EXCL ("wx") inside the confined graph dir, then renames it over
 * `relations.jsonl`. This proves the hardened discipline: a pre-planted SYMLINK at
 * the (old, predictable) compaction temp path pointing OUT of the project must NOT
 * be followed — compaction FAILS CLOSED, the outside file is UNCHANGED, and
 * `relations.jsonl` is NOT replaced by a symlink. A normal compaction still
 * collapses superseded records and shrinks the file.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, symlink, readFile, lstat, writeFile, open } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { EntityId, ProfilePack } from "../src/profile/types.js";
import { RELATIONS_FILE, WIKI_GRAPH_DIR } from "../src/utils/constants.js";
import { appendRelation, updateRelation, compactRelations } from "../src/relations/store.js";
import { readRelations } from "../src/relations/store-read.js";

const EXP_A = "experiments/a" as EntityId;
const IDEA_B = "ideas/b" as EntityId;

/** A minimal directed-relation profile for the compaction tests. */
function profile(): ProfilePack {
  return {
    schemaVersion: 1,
    profileId: "research",
    entities: { experiments: { directory: "wiki/experiments" }, ideas: { directory: "wiki/ideas" } },
    relations: { tests: { from: ["experiments"], to: ["ideas"], direction: "directed" } },
  };
}

let root = "";
let outside = "";
const storePath = (): string => path.join(root, RELATIONS_FILE);
/** The PREDICTABLE legacy compaction temp path (the symlink-clobber target). */
const legacyTmp = (): string => path.join(root, WIKI_GRAPH_DIR, `${path.basename(RELATIONS_FILE)}.compact.tmp`);

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "rel-compact-"));
  outside = await mkdtemp(path.join(os.tmpdir(), "rel-outside-"));
});
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  if (outside) await rm(outside, { recursive: true, force: true });
});

describe("compaction temp-write confinement (FIX 1)", () => {
  it("refuses a pre-planted symlink at the predictable temp path; outside file untouched", async () => {
    const ref = await appendRelation(root, profile(), { type: "tests", from: EXP_A, to: IDEA_B, attributes: { a: "1" } });
    await updateRelation(root, profile(), ref.id, { attributes: { a: "2" } });
    const secret = path.join(outside, "secret.txt");
    await writeFile(secret, "DO NOT OVERWRITE", "utf8");
    await symlink(secret, legacyTmp()); // pre-plant the symlink-to-FILE clobber

    await expect(compactRelations(root, profile())).resolves.toBeDefined();

    expect(await readFile(secret, "utf8")).toBe("DO NOT OVERWRITE");
    expect((await lstat(storePath())).isSymbolicLink()).toBe(false);
  });

  it("the O_EXCL ('wx') temp open FAILS CLOSED on a pre-existing symlink (the load-bearing primitive)", async () => {
    const secret = path.join(outside, "secret.txt");
    await writeFile(secret, "DO NOT OVERWRITE", "utf8");
    const planted = path.join(root, "planted.tmp");
    await symlink(secret, planted);

    // The exact open the hardened compaction uses: a pre-existing entry (incl. a
    // symlink-to-FILE) makes "wx" throw EEXIST — it is never followed.
    await expect(open(planted, "wx")).rejects.toMatchObject({ code: "EEXIST" });
    expect(await readFile(secret, "utf8")).toBe("DO NOT OVERWRITE");
  });

  it("normal compaction collapses superseded records and shrinks the file", async () => {
    const ref = await appendRelation(root, profile(), { type: "tests", from: EXP_A, to: IDEA_B, attributes: { a: "1" } });
    await updateRelation(root, profile(), ref.id, { attributes: { a: "2" } });
    await updateRelation(root, profile(), ref.id, { attributes: { a: "3" } });

    const { before, after } = await compactRelations(root, profile());

    expect(after).toBeLessThan(before);
    const { relations } = await readRelations(root);
    expect(relations).toHaveLength(1);
    expect(relations[0].attributes).toEqual({ a: "3" });
    expect((await lstat(storePath())).isSymbolicLink()).toBe(false);
  });
});
