/**
 * @file test/event-torn-append-repair.test.ts
 * @description Audit fix: a TORN trailing line (an uncommitted, crashed prior
 * append left a partial JSON line with no trailing newline) is a recoverable
 * WRITE precondition — the next append/mutation must REPAIR it (truncate the
 * partial line) before writing, NOT concatenate the new record onto it and
 * corrupt the audit log. Genuine TAMPER (interior edit / reorder / head-without-
 * log) still fails the write CLOSED. The READ path keeps tolerating a torn tail.
 *
 * Probes:
 *   - appendEvent onto a torn store → the torn line is dropped, the new event
 *     appends CLEANLY (all records parse, chain valid, head matches new last);
 *   - a relation create / lifecycle transition against a torn store → SUCCEEDS,
 *     the relation/page IS written, the event store is valid afterward;
 *   - a TAMPERED store → append AND both mutations still FAIL CLOSED;
 *   - readEvents still TOLERATES + reports a torn tail (read path unchanged);
 *   - a normal (clean) store append still works (regression).
 */

import { describe, it, beforeEach, afterEach, expect } from "vitest";
import { mkdtemp, rm, readFile, writeFile, appendFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { EntityId, ProfilePack } from "../src/profile/types.js";
import { EVENTS_FILE } from "../src/utils/constants.js";
import { appendEvent } from "../src/events/store.js";
import { readEvents } from "../src/events/store-read.js";
import { EventStoreChainError } from "../src/events/types.js";
import { appendRelation } from "../src/relations/store.js";
import { readRelations } from "../src/relations/store-read.js";
import { transitionLifecycle } from "../src/trust/lifecycle-transition.js";
import { eventInput, seedEvents } from "./fixtures/event-store-probe.js";
import { RESEARCH_LITE_RELATIONS_PROFILE } from "./fixtures/profile-fixtures.js";
import {
  makeConfineRoots,
  cleanupConfineRoots,
  type ConfineRoots,
} from "./fixtures/graph-store-confine.js";

const EXP = "experiments/ablation-batch-size" as EntityId;
const IDEA = "ideas/sparse-routing" as EntityId;
const profile = (): ProfilePack => RESEARCH_LITE_RELATIONS_PROFILE as ProfilePack;

/** Append a partial (newline-less) JSON fragment so the trailing line is torn. */
const tornFragment = '{"id":"evt_torn","type":"rel';

describe("torn-tail repair — bare event append", () => {
  let root = "";
  beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), "evt-torn-")); });
  afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });
  const storePath = (): string => path.join(root, EVENTS_FILE);

  it("truncates a torn trailing line, then appends the new event cleanly", async () => {
    await seedEvents(root, ["a", "b"]);
    await appendFile(storePath(), tornFragment); // crashed prior append
    const rec = await appendEvent(root, eventInput("c"));
    const { events, problems } = await readEvents(root);
    expect(problems).toEqual([]); // not concatenated/corrupted
    expect(events.map((e) => e.id)).toEqual(expect.arrayContaining([rec.id]));
    expect(events[events.length - 1].id).toBe(rec.id);
  });

  it("still FAILS CLOSED on a tampered (reordered) chain", async () => {
    const [header, r1, r2, r3] = await seedEvents(root, ["a", "b", "c"]);
    await writeFile(storePath(), [header, r2, r1, r3].join("\n") + "\n"); // swap r1<->r2
    await expect(appendEvent(root, eventInput("d"))).rejects.toBeInstanceOf(EventStoreChainError);
  });

  it("a TAMPERED + TORN store rejects AND leaves events.jsonl byte-identical (verify before repair)", async () => {
    const [header, r1, r2, r3] = await seedEvents(root, ["a", "b", "c"]);
    await writeFile(storePath(), [header, r2, r1, r3].join("\n") + "\n"); // tamper (swap)
    await appendFile(storePath(), tornFragment); // ...AND a torn trailing fragment
    const before = await readFile(storePath(), "utf8");
    await expect(appendEvent(root, eventInput("d"))).rejects.toBeInstanceOf(EventStoreChainError);
    expect(await readFile(storePath(), "utf8")).toBe(before); // tamper rejected, file NOT mutated
  });

  it("READ path still tolerates + reports a torn tail (unchanged)", async () => {
    await seedEvents(root, ["a", "b"]);
    await appendFile(storePath(), tornFragment);
    const { events, problems } = await readEvents(root);
    expect(events).toHaveLength(2);
    expect(problems.some((p) => /torn trailing line/.test(p))).toBe(true);
  });

  it("a clean store append still works (regression)", async () => {
    await seedEvents(root, ["a", "b"]); // no torn tail
    const rec = await appendEvent(root, eventInput("c"));
    const { events, problems } = await readEvents(root);
    expect(problems).toEqual([]);
    expect(events).toHaveLength(3);
    expect(events.at(-1)?.id).toBe(rec.id);
  });
});

describe("torn-tail repair — F2 mutations", () => {
  let ctx: ConfineRoots;
  let root = "";
  beforeEach(async () => { ctx = await makeConfineRoots("evt-torn-f2"); root = ctx.root; });
  afterEach(async () => { await cleanupConfineRoots(ctx); });
  const tear = async (): Promise<void> => {
    await seedEvents(root, ["a"]);
    await appendFile(path.join(root, EVENTS_FILE), tornFragment);
  };

  it("a relation create against a torn store SUCCEEDS + leaves a valid event log", async () => {
    await tear();
    const ref = await appendRelation(root, profile(), { type: "tests", from: EXP, to: IDEA });
    const { relations } = await readRelations(root);
    expect(relations.map((r) => r.id)).toEqual([ref.id]);
    const { problems } = await readEvents(root);
    expect(problems).toEqual([]); // repaired + audited cleanly
  });

  it("a lifecycle transition against a torn store SUCCEEDS + leaves a valid event log", async () => {
    await tear();
    await transitionLifecycle(root, "ideas", "sparse-routing", "testing");
    const page = await readFile(path.join(root, "wiki/ideas", "sparse-routing.md"), "utf8");
    expect(page).toMatch(/status:\s*testing/);
    const { problems } = await readEvents(root);
    expect(problems).toEqual([]);
  });

  it("a TAMPERED store still fails BOTH mutations closed (repair doesn't mask tamper)", async () => {
    await appendEvent(root, eventInput("a"));
    const header = (await readFile(path.join(root, EVENTS_FILE), "utf8")).split("\n").filter(Boolean)[0];
    await writeFile(path.join(root, EVENTS_FILE), header + "\n"); // head anchor still set: head-without-log
    await expect(appendRelation(root, profile(), { type: "tests", from: EXP, to: IDEA })).rejects.toThrow();
    await expect(transitionLifecycle(root, "ideas", "sparse-routing", "testing")).rejects.toThrow();
  });
});
