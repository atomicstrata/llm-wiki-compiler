/**
 * @file test/relation-store-audit.test.ts
 * @description Tests for the Phase 4 relation-store audit fixes:
 *  - FIX #1: validate-AFTER-canonicalize + symmetric endpoint sets (a symmetric
 *    edge whose from-type sorts after its to-type writes and re-validates clean).
 *  - FIX #6: contentHash dedup — (a→b) then (b→a) on a symmetric type, and two
 *    identical directed creates, collapse to ONE record.
 *  - FIX #5: updateRelation reads its base under ONE lock (no lost update).
 *  - FIX #3: N concurrent appends serialize (all succeed); a held lock past the
 *    timeout throws the busy error.
 *  - FIX #4: appending at/over the store cap throws RelationStoreFullError;
 *    compactRelations collapses superseded records and shrinks the file.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, truncate } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { EntityId, ProfilePack } from "../src/profile/types.js";
import { RELATIONS_FILE, MAX_RELATION_STORE_BYTES, LOCK_FILE, LLMWIKI_DIR } from "../src/utils/constants.js";
import { appendRelation, updateRelation, compactRelations } from "../src/relations/store.js";
import { readRelations } from "../src/relations/store-read.js";
import { validateRelationAgainstProfile } from "../src/relations/relation-contract.js";
import { RelationStoreFullError } from "../src/relations/types.js";
import { acquireLockBlocking, LockBusyError } from "../src/utils/lock.js";

const EXP_A = "experiments/a" as EntityId;
const IDEA_B = "ideas/b" as EntityId;
const ZETA_X = "zeta/x" as EntityId;
const ALPHA_Y = "alpha/y" as EntityId;

/** A profile whose symmetric `related` lists from:[zeta] AFTER to:[alpha] lexically. */
function profile(): ProfilePack {
  return {
    schemaVersion: 1,
    profileId: "research",
    entities: {
      experiments: { directory: "wiki/experiments" }, ideas: { directory: "wiki/ideas" },
      zeta: { directory: "wiki/zeta" }, alpha: { directory: "wiki/alpha" },
    },
    relations: {
      tests: { from: ["experiments"], to: ["ideas"], direction: "directed" },
      related: { from: ["zeta"], to: ["alpha"], direction: "symmetric" },
    },
  };
}

let root = "";
const storePath = (): string => path.join(root, RELATIONS_FILE);

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "rel-audit-"));
});
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

describe("FIX #1 — validate after canonicalize, symmetric endpoint sets", () => {
  it("writes a symmetric zeta→alpha edge whose canonical form re-validates clean", async () => {
    const ref = await appendRelation(root, profile(), { type: "related", from: ZETA_X, to: ALPHA_Y, attributes: {} });
    const { relations } = await readRelations(root);
    expect(relations).toHaveLength(1);
    expect(validateRelationAgainstProfile(relations[0], profile())).toEqual([]);
  });

  it("a directed relation still validates from/to in declared order", async () => {
    const bad = appendRelation(root, profile(), { type: "tests", from: IDEA_B, to: EXP_A, attributes: {} });
    await expect(bad).rejects.toThrow(/not an allowed entity type/);
  });
});

describe("FIX #6 — contentHash dedup (idempotent create)", () => {
  it("(a→b) then (b→a) on a symmetric type collapse to ONE record (same id)", async () => {
    const ab = await appendRelation(root, profile(), { type: "related", from: ZETA_X, to: ALPHA_Y, attributes: {} });
    const ba = await appendRelation(root, profile(), { type: "related", from: ALPHA_Y, to: ZETA_X, attributes: {} });
    expect(ba.id).toBe(ab.id);
    const { relations } = await readRelations(root);
    expect(relations).toHaveLength(1);
  });

  it("two identical directed creates collapse to one; a distinct edge does not", async () => {
    const first = await appendRelation(root, profile(), { type: "tests", from: EXP_A, to: IDEA_B, attributes: {} });
    const dup = await appendRelation(root, profile(), { type: "tests", from: EXP_A, to: IDEA_B, attributes: {} });
    await appendRelation(root, profile(), { type: "tests", from: EXP_A, to: "ideas/c" as EntityId, attributes: {} });
    expect(dup.id).toBe(first.id);
    expect((await readRelations(root)).relations).toHaveLength(2);
  });
});

describe("FIX #5 — updateRelation reads its base under one lock", () => {
  it("merges against the current on-disk latest, not a stale read", async () => {
    const ref = await appendRelation(root, profile(), { type: "tests", from: EXP_A, to: IDEA_B, attributes: { a: "1" } });
    await updateRelation(root, profile(), ref.id, { attributes: { a: "2" } });
    const updated = await updateRelation(root, profile(), ref.id, { evidence: [{ sourcePath: "s.md" }] });
    expect(updated.attributes).toEqual({ a: "2" });
    const { relations } = await readRelations(root);
    expect(relations).toHaveLength(1);
    expect(relations[0].attributes).toEqual({ a: "2" });
  });
});

describe("FIX #3 — bounded-blocking acquire serializes writers", () => {
  it("N concurrent appends all succeed (serialized, no spurious throw)", async () => {
    const writes = Array.from({ length: 20 }, (_, i) =>
      appendRelation(root, profile(), { type: "tests", from: EXP_A, to: `ideas/n${i}` as EntityId, attributes: {} }),
    );
    const refs = await Promise.all(writes);
    expect(new Set(refs.map((r) => r.id)).size).toBe(20);
    expect((await readRelations(root)).relations).toHaveLength(20);
  });

  it("throws LockBusyError when the lock is held past the timeout", async () => {
    await mkdir(path.join(root, LLMWIKI_DIR), { recursive: true });
    // A lock file naming THIS (live) process PID is never stale, so the acquire
    // can never reclaim it — it must time out and throw the busy error.
    await writeFile(path.join(root, LOCK_FILE), String(process.pid), "utf8");
    const attempt = acquireLockBlocking(root, { timeoutMs: 50, intervalMs: 10 });
    await expect(attempt).rejects.toBeInstanceOf(LockBusyError);
  });

  it("does NOT spam the busy warning on each intermediate retry (FIX 3)", async () => {
    await mkdir(path.join(root, LLMWIKI_DIR), { recursive: true });
    await writeFile(path.join(root, LOCK_FILE), String(process.pid), "utf8");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await acquireLockBlocking(root, { timeoutMs: 60, intervalMs: 10 }).catch(() => {});
      const busyLines = logSpy.mock.calls.filter(([line]) => String(line).includes("Another compilation is running."));
      expect(busyLines.length).toBeLessThanOrEqual(1);
    } finally {
      logSpy.mockRestore();
    }
  });
});

describe("FIX #4 — append cap + compaction", () => {
  it("appending at/over the store cap throws RelationStoreFullError (not corrupt)", async () => {
    await appendRelation(root, profile(), { type: "tests", from: EXP_A, to: IDEA_B, attributes: {} });
    await truncate(storePath(), MAX_RELATION_STORE_BYTES - 10);
    const attempt = appendRelation(root, profile(), { type: "tests", from: EXP_A, to: "ideas/z" as EntityId, attributes: {} });
    await expect(attempt).rejects.toBeInstanceOf(RelationStoreFullError);
  });

  it("compactRelations collapses superseded records, shrinks the file, and reads/appends still work", async () => {
    const ref = await appendRelation(root, profile(), { type: "tests", from: EXP_A, to: IDEA_B, attributes: { a: "1" } });
    await updateRelation(root, profile(), ref.id, { attributes: { a: "2" } });
    await updateRelation(root, profile(), ref.id, { attributes: { a: "3" } });
    const { before, after } = await compactRelations(root, profile());
    expect(after).toBeLessThan(before);
    const { relations } = await readRelations(root);
    expect(relations).toHaveLength(1);
    expect(relations[0].attributes).toEqual({ a: "3" });
    await appendRelation(root, profile(), { type: "tests", from: EXP_A, to: "ideas/c" as EntityId, attributes: {} });
    expect((await readRelations(root)).relations).toHaveLength(2);
  });
});
