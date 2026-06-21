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

import { describe, it, beforeEach, afterEach, expect } from "vitest";
import { mkdtemp, rm, mkdir, symlink, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { appendRelation } from "../src/relations/store.js";
import { readRelations } from "../src/relations/store-read.js";
import { experimentsIdeasProfile, EXPERIMENT_A as EXP_A, IDEA_B } from "./fixtures/profile-fixtures.js";

/** A non-default profile with a directed `tests` relation. */
const profile = () => experimentsIdeasProfile({ tests: { from: ["experiments"], to: ["ideas"], direction: "directed" } });

let root = "";
let outside = "";
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "rel-confine-"));
  outside = await mkdtemp(path.join(os.tmpdir(), "rel-out-"));
});
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  if (outside) await rm(outside, { recursive: true, force: true });
});

const append = () => appendRelation(root, profile(), { type: "tests", from: EXP_A, to: IDEA_B, attributes: {} });

describe("relation graph-parent confinement (FIX 1)", () => {
  it("fails closed when `wiki` is a symlinked escape and `wiki/graph` is absent", async () => {
    await symlink(outside, path.join(root, "wiki")); // wiki -> outside; graph absent
    await expect(append()).rejects.toThrow(/escapes project root/);
    expect(existsSync(path.join(outside, "graph"))).toBe(false);
    expect(await readdir(outside)).toEqual([]); // nothing written outside root
  });

  it("still appends + reads fine on the normal real-directory path", async () => {
    const ref = await append();
    const { relations } = await readRelations(root);
    expect(relations).toHaveLength(1);
    expect(relations[0].id).toBe(ref.id);
  });

  it("still fails closed when `wiki/graph` itself is a symlink (prior-fix regression)", async () => {
    await mkdir(path.join(root, "wiki"), { recursive: true });
    await symlink(outside, path.join(root, "wiki", "graph"));
    await expect(append()).rejects.toThrow(/escapes project root|not a directory/);
  });
});
