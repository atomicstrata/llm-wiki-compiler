/**
 * @file test/history/relations.test.ts
 * @description The segmented relation log of an active `local-indexed`
 * project on real disk, through the incumbent relation APIs with a declared
 * synthetic profile pack (relation writes are profile-gated, so on an
 * eligible default-profile project they are reachable only as these direct
 * API compositions). An imported log reads back identically; creation
 * dedupes by live content through one index lookup; updates supersede by id;
 * operation creates replay idempotently; compaction refuses; full
 * verification passes; the legacy file never changes.
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import { afterEach, beforeEach } from "../config/storage-profile-hooks.js";
import { verifyRelationHistory } from "../../src/history/history-verify.js";
import type { EntityId, ProfilePack } from "../../src/profile/types.js";
import { appendRelationForOperationLocked } from "../../src/relations/operation-write.js";
import { appendRelation, compactRelations, updateRelation } from "../../src/relations/store.js";
import { readRelationRecords, readRelations } from "../../src/relations/store-read.js";
import { newCounters, observeIo } from "../../src/segments/counters.js";
import { RELATIONS_FILE } from "../../src/utils/constants.js";
import { activateIndexed } from "../catalog/helpers.js";
import { EXPERIMENT_A, experimentsIdeasProfile } from "../fixtures/profile-fixtures.js";

let root: string;
beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), "llmwiki-rel-seg-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

/** A synthetic pack with one directed `tests` relation (experiments → ideas). */
const PROFILE: ProfilePack = experimentsIdeasProfile({ tests: { from: ["experiments"], to: ["ideas"], direction: "directed" } });
const BINDING = { bundleId: "bnd_01ARZ3NDEKTSV4RRFFQ69G5FAV", runId: "opr_01ARZ3NDEKTSV4RRFFQ69G5FAV", mutationId: `opm_${"b".repeat(64)}` };
/** The relation input to idea `n`. */
const toIdea = (n: number) => ({ type: "tests", from: EXPERIMENT_A, to: `ideas/n${n}` as EntityId, attributes: {} });

/** Seed `count` relations through the incumbent single-file path, then activate. */
async function seededIndexed(count: number): Promise<void> {
  for (let n = 0; n < count; n += 1) await appendRelation(root, PROFILE, toIdea(n));
  await activateIndexed(root);
}

describe("imported relation history", () => {
  it("reads back identically and keeps the legacy file byte-identical across later writes", async () => {
    for (let n = 0; n < 4; n += 1) await appendRelation(root, PROFILE, toIdea(n));
    const legacy = await readRelationRecords(root);
    const bytes = await readFile(path.join(root, RELATIONS_FILE));
    await activateIndexed(root);
    expect(await readRelationRecords(root)).toEqual(legacy);
    await appendRelation(root, PROFILE, toIdea(99));
    expect((await readRelations(root)).relations).toHaveLength(5);
    expect(await readFile(path.join(root, RELATIONS_FILE))).toEqual(bytes);
  });
});

describe("narrow writes", () => {
  it("dedupes a live duplicate through point lookups without writing, reading the same blocks at 30 and 240 relations", async () => {
    const measure = async (count: number) => {
      await seededIndexed(count);
      const counters = newCounters();
      const again = await observeIo(counters, () => appendRelation(root, PROFILE, toIdea(7)));
      expect([again.to, counters.manifestsPublished]).toEqual(["ideas/n7", 0]);
      return counters;
    };
    const small = await measure(30);
    await rm(root, { recursive: true, force: true });
    root = await mkdtemp(path.join(tmpdir(), "llmwiki-rel-seg-"));
    const large = await measure(240);
    // Point lookups decode whole blocks (at most BLOCK_TARGET_BYTES of rows each), so compare blocks, not rows.
    expect(large.blocksRead).toBeLessThanOrEqual(small.blocksRead + 2);
    expect(large.segmentsOpened).toBeLessThanOrEqual(small.segmentsOpened + 2);
  });

  it("supersedes by id on update, moving the content index with the latest version", async () => {
    await seededIndexed(2);
    const created = await appendRelation(root, PROFILE, toIdea(5));
    const updated = await updateRelation(root, PROFILE, created.id, { attributes: { v: "2" } });
    const relations = (await readRelations(root)).relations;
    expect(relations.filter((rel) => rel.id === created.id)).toEqual([updated]);
    const fresh = await appendRelation(root, PROFILE, toIdea(5));
    expect(fresh.id).not.toBe(created.id);
    expect(await verifyRelationHistory(root)).toMatchObject({ ok: true, records: 5 });
  });

  it("replays an operation create idempotently and refuses compaction with history unchanged", async () => {
    await seededIndexed(1);
    const first = await appendRelationForOperationLocked(root, PROFILE, toIdea(9), BINDING);
    const replay = await appendRelationForOperationLocked(root, PROFILE, toIdea(9), BINDING);
    expect([first.status, replay.status]).toEqual(["created", "skipped-idempotent"]);
    await expect(compactRelations(root, PROFILE)).rejects.toThrow("unavailable on a local-indexed project");
    expect((await readRelationRecords(root)).records).toHaveLength(2);
  });
});
