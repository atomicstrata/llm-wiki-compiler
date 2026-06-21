/**
 * @file test/relation-store.test.ts
 * @description Tests for the append-only JSONL relation store (Phase 4 PR4).
 *
 * Covers: append→readback round-trip with a `rel_` id + stable contentHash;
 * endpoint/required-attribute violations fail closed writing nothing; symmetric
 * canonicalization; a torn trailing line is tolerated+reported; interior
 * corruption + a too-new schemaVersion fail closed; a symlinked `wiki/graph`
 * fails closed; update appends under the same id; and a DEFAULT project (no
 * `wiki/graph`) reads empty.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, readFile, writeFile, appendFile, symlink } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { EntityId, ProfilePack } from "../src/profile/types.js";
import { RELATIONS_FILE } from "../src/utils/constants.js";
import { appendRelation, updateRelation } from "../src/relations/store.js";
import { readRelations } from "../src/relations/store-read.js";
import {
  RelationEndpointError,
  RelationStoreCorruptError,
  RelationStoreTooNewError,
} from "../src/relations/types.js";

const EXP_A = "experiments/a" as EntityId;
const IDEA_B = "ideas/b" as EntityId;

/** A non-default profile with a directed `tests` and a symmetric `related` relation. */
function profile(): ProfilePack {
  return {
    schemaVersion: 1,
    profileId: "research",
    entities: { experiments: { directory: "wiki/experiments" }, ideas: { directory: "wiki/ideas" } },
    relations: {
      tests: { from: ["experiments"], to: ["ideas"], direction: "directed", attributes: { note: { type: "string" } }, requiredAttributes: ["note"] },
      related: { from: ["experiments", "ideas"], to: ["experiments", "ideas"], direction: "symmetric" },
    },
  };
}

let root = "";
beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), "rel-store-")); });
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });

/** Append-mode test profile + the on-disk store path. */
const storePath = (): string => path.join(root, RELATIONS_FILE);

describe("appendRelation / readRelations round-trip", () => {
  it("persists a relation with a rel_ id and stable contentHash", async () => {
    const ref = await appendRelation(root, profile(), { type: "tests", from: EXP_A, to: IDEA_B, attributes: { note: "x" } });
    expect(ref.id).toMatch(/^rel_/);
    const { relations, problems } = await readRelations(root);
    expect(problems).toEqual([]);
    expect(relations).toHaveLength(1);
    expect(relations[0]).toMatchObject({ id: ref.id, contentHash: ref.contentHash, from: EXP_A });
  });
});

describe("endpoint + attribute validation (fail closed)", () => {
  it("rejects a wrong from-endpoint entity type and writes nothing", async () => {
    const bad = appendRelation(root, profile(), { type: "tests", from: IDEA_B, to: IDEA_B, attributes: { note: "x" } });
    await expect(bad).rejects.toThrow(RelationEndpointError);
    await expect(readRelations(root)).resolves.toMatchObject({ relations: [] });
  });

  it("rejects a missing required attribute", async () => {
    const bad = appendRelation(root, profile(), { type: "tests", from: EXP_A, to: IDEA_B, attributes: {} });
    await expect(bad).rejects.toThrow(/missing required attribute 'note'/);
  });
});

describe("symmetric canonicalization", () => {
  it("(a→b) and (b→a) share a contentHash", async () => {
    const ab = await appendRelation(root, profile(), { type: "related", from: EXP_A, to: IDEA_B, attributes: {} });
    const ba = await appendRelation(root, profile(), { type: "related", from: IDEA_B, to: EXP_A, attributes: {} });
    expect(ab.contentHash).toBe(ba.contentHash);
  });
});

describe("durability: torn / corrupt / too-new", () => {
  it("tolerates and reports a torn trailing line", async () => {
    await appendRelation(root, profile(), { type: "tests", from: EXP_A, to: IDEA_B, attributes: { note: "x" } });
    await appendFile(storePath(), '{"id":"rel_torn","type":"tes');
    const { relations, problems } = await readRelations(root);
    expect(relations).toHaveLength(1);
    expect(problems[0]).toMatch(/torn trailing line/);
  });

  it("fails closed on an interior bad-checksum line", async () => {
    await appendRelation(root, profile(), { type: "tests", from: EXP_A, to: IDEA_B, attributes: { note: "x" } });
    const raw = await readFile(storePath(), "utf-8");
    const tampered = raw.replace(/"note":"x"/, '"note":"TAMPERED"');
    await writeFile(storePath(), tampered + '{"id":"rel_z","type":"tests","checksum":"_"}\n');
    await expect(readRelations(root)).rejects.toThrow(RelationStoreCorruptError);
  });

  it("fails closed when schemaVersion exceeds the known version", async () => {
    await mkdir(path.dirname(storePath()), { recursive: true });
    await writeFile(storePath(), '{"kind":"relation-store-header","schemaVersion":99}\n');
    await expect(readRelations(root)).rejects.toThrow(RelationStoreTooNewError);
  });
});

describe("confinement + default + update", () => {
  it("fails closed when wiki/graph is a symlinked escape", async () => {
    const outside = await mkdtemp(path.join(os.tmpdir(), "rel-escape-"));
    await mkdir(path.join(root, "wiki"), { recursive: true });
    await symlink(outside, path.join(root, "wiki", "graph"));
    await expect(readRelations(root)).rejects.toThrow(/escapes project root|not a directory/);
    await rm(outside, { recursive: true, force: true });
  });

  it("reads empty for a DEFAULT project with no wiki/graph", async () => {
    await expect(readRelations(root)).resolves.toEqual({ relations: [], problems: [] });
  });

  it("update appends under the same id with a new contentHash", async () => {
    const ref = await appendRelation(root, profile(), { type: "tests", from: EXP_A, to: IDEA_B, attributes: { note: "x" } });
    const updated = await updateRelation(root, profile(), ref.id, { attributes: { note: "y" } });
    expect(updated.id).toBe(ref.id);
    expect(updated.contentHash).not.toBe(ref.contentHash);
    const { relations } = await readRelations(root);
    expect(relations).toHaveLength(1);
    expect(relations[0].attributes).toEqual({ note: "y" });
  });
});
