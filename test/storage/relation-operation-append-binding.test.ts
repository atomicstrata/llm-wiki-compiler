/**
 * @file test/storage/relation-operation-append-binding.test.ts
 * @description The operation-bound relation create, whole, over both append
 * stores and their DURABLE header upgrades: `appendRelationForOperationLockedFrom`
 * reads and classifies the relation records, and on a create upgrades this
 * store's header durably, checks the audit store's precondition, appends the
 * bound record, then appends (or reuses) the bound child event, which upgrades
 * the audit store's header durably before its append and seal. The bound bodies
 * exist only after these writers were given sources, so this file has NO
 * before-edit run.
 *
 * HOW IT IS BUILT. Six projects are minted on real disk, once, and copied BEFORE
 * their disk ask (`mintCopiedBeforeAsk`): fresh; base-version (v1) stores; a
 * bound record without its event; a v3 relation header; a torn relation tail;
 * and a tampered audit head. Each disk ask runs the ROOT
 * `appendRelationForOperationLocked` over its plan; the memory replay runs the
 * BODY over the copy. Both sides are compared at the BODY level — status,
 * `bound`, `detail`, the ref and the event — with no test-side copy of the
 * bundle adapter's status mapping. The adapter (`relationAdapter.apply`) is run
 * only on disk, as O8's root positive control. Its profile load and its
 * attestation check stay root-bound and are not exercised in memory.
 *
 * WHAT IS CHECKED PER SIDE. The event store whole: problems, the chain, the head
 * sealing the last record, and strict (`readEventsStrict` on disk; derived in
 * memory, because its body is root-bound). An interior bad record throws; a bad
 * last record is a tolerated torn tail, reported and dropped. The relation store
 * is ALSO read by the real reader on each side (problems, and each record's
 * mutation id); its bytes are compared EXACTLY across sides, because promised
 * ids and fixed bindings make them deterministic. Only minted event ids and an
 * event's `at`, `prevHash` and `checksum` are hidden across sides.
 *
 * WHAT IS MEMORY ONLY, AND NOT A REAL GUARD. The maps, the trace and the faults.
 * The memory durable replacement only SETS the text: it is NOT evidence of
 * fsync, exact-parent confinement, published-identity checks or power-loss
 * durability, which `atomic-write-durable`, `atomic-write-post-commit-recovery`
 * and `store-v1-compat` show on real files. The cross-store residual is shown,
 * not closed.
 */

import path from "node:path";
import { describe, expect, it, vi } from "bun:test";
import { eventPrevHash } from "../../src/events/event-digest.js";
import type { EventBoundWriteSources } from "../../src/events/store.js";
import * as eventRecord from "../../src/events/store-record.js";
import { relationAdapter } from "../../src/operation-bundles/adapters/relation.js";
import { mintBundleId, mintOperationRunId, mutationId } from "../../src/operation-bundles/ids.js";
import type { OperationDigest, RelationOperationMutation } from "../../src/operation-bundles/types.js";
import type { EntityId } from "../../src/profile/types.js";
import { appendRelationForOperationLocked, appendRelationForOperationLockedFrom, type RelationOperationSources } from "../../src/relations/operation-write.js";
import { buildRelationRef, type AppendRelationInput } from "../../src/relations/store.js";
import { readRelationRecords, readRelationRecordsFrom } from "../../src/relations/store-read.js";
import * as relationRecord from "../../src/relations/store-record.js";
import * as atomicWriteModule from "../../src/utils/atomic-write.js";
import type { GraphAppendPlan } from "../../src/utils/jsonl-store.js";
import * as markdown from "../../src/utils/markdown.js";
import * as noFollow from "../../src/utils/no-follow-open.js";
import type { OperationBinding } from "../../src/utils/operation-binding.js";
import { EXPERIMENT_A, IDEA_B, RELATED_INPUT, relatedProfile } from "../fixtures/profile-fixtures.js";
import { makeBinding, makeContext } from "../operation-bundles/adapter-fixtures.js";
import {
  diskAuditReads, EVENTS, eventsOf, EVT_V1, EVT_V2, expectBoundSilentRootReaches, expectCopiesHoldSeeds, HEAD, health as auditHealth, memoryAuditReads, normalized, ONE, seededParity, shownEvent, shownEventLines, TWO, type AuditReads, type FaultedMemory,
} from "./audit-event-fixtures.js";
import type { Copy } from "./copied-project.js";
import { memoryEventHeadReads, memoryGraphReads } from "./graph-store-memory.js";

const PREFIX = "relation-operation-append-binding-";
const PROFILE = relatedProfile();
const RELATIONS = "wiki/graph/relations.jsonl";
const C = "experiments/c" as EntityId;
const A = RELATED_INPUT as AppendRelationInput;
const DIVERGENT: AppendRelationInput = { type: "related", from: EXPERIMENT_A, to: C };
const SEEDED: AppendRelationInput = { type: "related", from: C, to: IDEA_B };
const BUNDLE = mintBundleId();
const RUN = mintOperationRunId();
const binding = (index: number): OperationBinding => ({ bundleId: BUNDLE, runId: RUN, mutationId: mutationId(BUNDLE, index) });
const [B1, B2] = [binding(0), binding(1)];
const [M1, M2, SEED_ID] = ["rel_m1", "rel_m2", "rel_seed"] as const;
const REF_M1 = buildRelationRef(PROFILE, A, M1);
const REF_SEED = buildRelationRef(PROFILE, SEEDED, SEED_ID);
const [REL_V1, REL_V2] = [`{"kind":"relation-store-header","schemaVersion":1}\n`, `{"kind":"relation-store-header","schemaVersion":2}\n`];
const recordLine = (ref: typeof REF_M1, bound?: OperationBinding): string => relationRecord.serializeRecord(ref, bound);
const PROFILE_FILE = { ".llmwiki/profile.json": JSON.stringify(PROFILE) };
const SEEDS = {
  fresh: PROFILE_FILE,
  v1: { ...PROFILE_FILE, [RELATIONS]: REL_V1 + recordLine(REF_SEED), [EVENTS]: eventsOf([ONE]), [HEAD]: eventPrevHash(ONE) },
  boundNoEvent: { ...PROFILE_FILE, [RELATIONS]: REL_V2 + recordLine(REF_M1, B1) },
  v3: { ...PROFILE_FILE, [RELATIONS]: `{"kind":"relation-store-header","schemaVersion":3}\n` },
  tornRelation: { ...PROFILE_FILE, [RELATIONS]: REL_V1 + recordLine(REF_SEED) + `{"id":"rel_torn` },
  tamperedAudit: { ...PROFILE_FILE, [EVENTS]: eventsOf([ONE, TWO]), [HEAD]: "0".repeat(64) },
};
type Scenario = keyof typeof SEEDS;
interface Call { input: AppendRelationInput; binding: OperationBinding; promisedId: `rel_${string}` }
const call = (input: AppendRelationInput, bound: OperationBinding, promisedId: `rel_${string}`): Call => ({ input, binding: bound, promisedId });
const PLANS: Record<Scenario, Call[]> = {
  fresh: [call(A, B1, M1), call(A, B1, M1), call(DIVERGENT, B1, M1), call(A, B2, M2)],
  v1: [call(A, B1, M1)], boundNoEvent: [call(A, B1, M1)], v3: [call(A, B1, M1)], tornRelation: [call(A, B1, M1)], tamperedAudit: [call(A, B1, M1)],
};

/** Every read and write one side answers for. */
interface Side extends AuditReads {
  apply(c: Call): Promise<unknown>;
  relations(): Promise<{ records: Array<{ operationBinding?: OperationBinding }>; problems: string[] }>;
}

/** A settled body result as shown: its event's chain fields hidden; a throw as `Name: message`. */
async function settle(side: Side, c: Call): Promise<unknown> {
  return side.apply(c).then((result) => {
    const shown = result as { event?: Record<string, unknown> };
    return shown.event === undefined ? result : { ...shown, event: shownEvent(shown.event) };
  }, (error: Error) => `${error.name}: ${error.message}`);
}

/** Each store's real reader on one side: events whole, and the relation records with their mutation ids. */
async function health(side: Side): Promise<unknown> {
  const events = await auditHealth(side);
  const relations = await side.relations().then(
    (read) => ({ problems: read.problems, mutations: read.records.map((record) => record.operationBinding?.mutationId ?? null) }),
    (error: Error) => error.name,
  );
  return { events, relations };
}

/** Health, each call settled once, then the stores (relations as exact bytes) and health again. */
async function runScenario(side: Side, calls: Call[]): Promise<unknown> {
  const before = await health(side);
  const settled: unknown[] = [];
  for (const c of calls) settled.push(await settle(side, c));
  const lines = shownEventLines(await side.text(EVENTS));
  return normalized({ before, settled, stores: { relations: await side.text(RELATIONS), events: lines, head: (await side.text(HEAD)) === null ? null : "<head>" }, after: await health(side) });
}

/** The ROOT body over one disk project. */
function diskSide(root: string): Side {
  return {
    apply: (c) => appendRelationForOperationLocked(root, PROFILE, c.input, c.binding, c.promisedId),
    ...diskAuditReads(root),
    relations: () => readRelationRecords(root),
  };
}

const { tracker, minted, parity } = seededParity({ prefix: PREFIX, seeds: SEEDS, plans: PLANS, run: runScenario, disk: diskSide, memory: (copy) => memorySide(copy) });

/** The memory project, its ordered log, and one-shot post-commit faults for each durable replacement. */
type Memory = FaultedMemory<{ relationDurable?: boolean; eventDurable?: boolean }>;

/** The handle-held append over the map: the leaf created, its size taken, then each pulled chunk written. */
function memoryAppend(memory: Memory, rel: string): (plan: GraphAppendPlan) => Promise<void> {
  const name = path.posix.basename(rel);
  return async (plan) => {
    const existing = Buffer.byteLength(memory.files.get(rel) ?? "");
    memory.log.push(`append ${name} at ${existing}`);
    memory.files.set(rel, memory.files.get(rel) ?? "");
    for (const chunk of plan(existing)) { memory.log.push(`write ${name}`); memory.files.set(rel, memory.files.get(rel)! + chunk); }
  };
}

/** The durable replacement over the map: it SETS the text (no durability), then optionally rejects post-commit once. */
function memoryDurable(memory: Memory, rel: string, fault: keyof Memory["faults"]): (body: string) => Promise<void> {
  return async (body) => {
    memory.log.push(`durable ${path.posix.basename(rel)}`);
    memory.files.set(rel, body);
    if (memory.faults[fault] !== true) return;
    memory.faults[fault] = false;
    throw new atomicWriteModule.AtomicWritePostCommitError(new Error("injected post-commit fault"));
  };
}

/** The audit store's bound-append sources over the map. */
function memoryEvents(memory: Memory): EventBoundWriteSources {
  return {
    graph: memoryGraphReads(memory),
    ...memoryEventHeadReads(memory),
    replaceStore: async (body) => { memory.log.push("replace events.jsonl"); memory.files.set(EVENTS, body); },
    appendStore: memoryAppend(memory, EVENTS),
    storeByteSize: async () => { memory.log.push("size events.jsonl"); return Buffer.byteLength(memory.files.get(EVENTS) ?? ""); },
    sealHead: async (digest) => { memory.log.push("seal"); memory.files.set(HEAD, digest); },
    replaceStoreDurable: memoryDurable(memory, EVENTS, "eventDurable"),
  };
}

/** The memory side over one copy; `memory` is exposed for the trace and the faults. */
function memorySide(copy: Copy, faults: Memory["faults"] = {}): Side & { memory: Memory } {
  const memory: Memory = { files: new Map(copy.files), log: [], faults };
  const sources: RelationOperationSources = {
    graph: { ...memoryGraphReads(memory), appendStore: memoryAppend(memory, RELATIONS) },
    replaceStoreDurable: memoryDurable(memory, RELATIONS, "relationDurable"),
    events: memoryEvents(memory),
  };
  return {
    memory,
    apply: (c) => appendRelationForOperationLockedFrom(sources, PROFILE, c.input, c.binding, c.promisedId),
    ...memoryAuditReads(memory.files, memoryEvents({ ...memory, log: [] })),
    relations: () => readRelationRecordsFrom(memoryGraphReads({ ...memory, log: [] })),
  };
}



const event = (n: number, bound: OperationBinding) => ({
  id: `evt#${n}`, type: "relation-create", origin: "sdk", payload: { id: M1, relType: "related", from: EXPERIMENT_A, to: IDEA_B }, operationBinding: bound, at: "<at>",
});
const shownRef = JSON.parse(JSON.stringify(REF_M1)) as unknown;
const healthy = (mutations: Array<string | null>) => ({ events: { problems: [], chainOk: true, headSealsLast: true, strict: "ok" }, relations: { problems: [], mutations } });
const [EVT_HEADER_V2, EVT_HEADER_V1] = [JSON.parse(EVT_V2) as unknown, JSON.parse(EVT_V1) as unknown];

describe("the operation-bound relation create over both stores, disk and memory, from six copied projects", () => {
  it("O1 runs after every minting directory was removed, on copies holding exactly their seeds", () => {
    expectCopiesHoldSeeds(minted, SEEDS, PREFIX);
  });

  it("O2 creates at v2, reuses on an exact retry, parks a divergent retry, and dedups a new mutation onto the live record, as the disk did", async () => {
    expect(await parity("fresh")).toEqual({
      before: healthy([]),
      settled: [
        { status: "created", ref: shownRef, event: event(1, B1) },
        { status: "skipped-idempotent", ref: shownRef, bound: true },
        { status: "conflict", detail: "relation mutation content mismatch" },
        { status: "skipped-idempotent", ref: shownRef, bound: false },
      ],
      stores: { relations: REL_V2 + recordLine(REF_M1, B1), events: [EVT_HEADER_V2, event(1, B1), event(2, B2)], head: "<head>" },
      after: healthy([B1.mutationId]),
    });
  });

  it("O3 raises both base-version headers to v2 with every seeded record byte kept after line 1, then appends, as the disk did", async () => {
    expect(await parity("v1")).toEqual({
      before: healthy([null]), settled: [{ status: "created", ref: shownRef, event: event(1, B1) }],
      stores: { relations: REL_V2 + recordLine(REF_SEED) + recordLine(REF_M1, B1), events: [EVT_HEADER_V2, ONE, event(1, B1)], head: "<head>" },
      after: healthy([null, B1.mutationId]),
    });
  });

  it("O4 forward-repairs a bound record's missing event, creating the audit store header-only at v2 first, as the disk did", async () => {
    expect(await parity("boundNoEvent")).toEqual({
      before: healthy([B1.mutationId]), settled: [{ status: "skipped-idempotent", ref: shownRef, bound: true }],
      stores: { relations: REL_V2 + recordLine(REF_M1, B1), events: [EVT_HEADER_V2, event(1, B1)], head: "<head>" },
      after: healthy([B1.mutationId]),
    });
  });

  it("O5 refuses a v3 header and a torn relation tail with nothing written, and a tampered audit head AFTER the durable relation upgrade, as the disk did", async () => {
    const v3 = { events: healthy([]).events, relations: "RelationStoreTooNewError" };
    expect(await parity("v3")).toEqual({
      before: v3, settled: ["RelationStoreTooNewError: relation store schemaVersion 3 exceeds supported 2"],
      stores: { relations: SEEDS.v3[RELATIONS], events: null, head: null }, after: v3,
    });
    const torn = { events: healthy([]).events, relations: { problems: ["tolerated torn trailing line: relation store corrupt: record line is not valid JSON"], mutations: [null] } };
    expect(await parity("tornRelation")).toEqual({
      before: torn, settled: [{ status: "conflict", detail: "relation store has an uncommitted tail" }],
      stores: { relations: SEEDS.tornRelation[RELATIONS], events: null, head: null }, after: torn,
    });
    const tampered = (mutations: unknown[]) => ({ events: { problems: [`head anchor ${"0".repeat(64)} does not match last event`], chainOk: true, headSealsLast: false, strict: "EventStoreChainError" }, relations: { problems: [], mutations } });
    expect(await parity("tamperedAudit")).toEqual({
      before: tampered([]), settled: ["EventStoreChainError: event store chain broken: head anchor does not match a committable store state"],
      stores: { relations: REL_V2, events: [EVT_HEADER_V1, ONE, TWO], head: "<head>" }, after: tampered([]),
    });
  });
});

describe("the bound operation create's order, its unknown outcomes, and no ambient call (memory only, not real guards)", () => {
  const repair = ["read events.jsonl", "private-dir", "head events.head"];

  it("O6 traces a fresh create exactly: two durable upgrades, each store's append writing the record ONLY, and no non-durable replacement", async () => {
    const side = memorySide(minted.fresh.copy);
    await side.apply(call(A, B1, M1));
    expect(side.memory.log).toEqual([
      "read relations.jsonl", "read relations.jsonl", "durable relations.jsonl", ...repair,
      `append relations.jsonl at ${Buffer.byteLength(REL_V2)}`, "write relations.jsonl",
      "read events.jsonl", "private-dir", "head events.head", ...repair, "read events.jsonl", "durable events.jsonl",
      `append events.jsonl at ${Buffer.byteLength(EVT_V2)}`, "write events.jsonl", "seal",
    ]);
    expect([side.memory.log.filter((entry) => entry.startsWith("durable")).length, side.memory.log.filter((entry) => /^(replace|size)/u.test(entry))]).toEqual([2, []]);
  });

  it("O7 publishes the relation header and then throws the writer's post-commit error, and the next create proceeds without re-upgrading", async () => {
    const side = memorySide(minted.fresh.copy, { relationDurable: true });
    const first = await side.apply(call(A, B1, M1)).catch((error: unknown) => error);
    expect([first instanceof atomicWriteModule.AtomicWritePostCommitError, (first as Error).name, side.memory.files.get(RELATIONS), side.memory.files.has(EVENTS)])
      .toEqual([true, "AtomicWritePostCommitError", REL_V2, false]);
    side.memory.log.length = 0;
    expect(normalized(await settle(side, call(A, B1, M1)))).toEqual({ status: "created", ref: shownRef, event: event(1, B1) });
    expect(side.memory.log.filter((entry) => entry.startsWith("durable"))).toEqual(["durable events.jsonl"]);
  });

  it("O7b leaves the bound record WITHOUT its event when the audit header's durable write fails post-commit, and the next apply forward-repairs it", async () => {
    const side = memorySide(minted.fresh.copy, { eventDurable: true });
    await expect(side.apply(call(A, B1, M1))).rejects.toBeInstanceOf(atomicWriteModule.AtomicWritePostCommitError);
    expect([side.memory.files.get(RELATIONS), side.memory.files.get(EVENTS), side.memory.files.has(HEAD)]).toEqual([REL_V2 + recordLine(REF_M1, B1), EVT_V2, false]);
    expect(normalized(await settle(side, call(A, B1, M1)))).toEqual({ status: "skipped-idempotent", ref: shownRef, bound: true });
    expect(normalized(await runScenario(side, []))).toMatchObject({ stores: { events: [EVT_HEADER_V2, event(1, B1)], head: "<head>" }, after: healthy([B1.mutationId]) });
  });

  it("O8 makes no ambient call in the bound route; the root bundle step reaches every one of them across modules", async () => {
    const spies = [
      vi.spyOn(atomicWriteModule, "atomicWrite"), vi.spyOn(markdown, "atomicWrite"), vi.spyOn(relationRecord, "resolveGraphDir"),
      vi.spyOn(relationRecord, "openStoreFileAppend"), vi.spyOn(eventRecord, "resolveEventGraphDir"), vi.spyOn(eventRecord, "openEventFileAppend"),
      vi.spyOn(noFollow, "openFileNoFollow"),
    ];
    await expectBoundSilentRootReaches(spies, () => runScenario(memorySide(minted.fresh.copy), PLANS.fresh), { tracker, prefix: PREFIX, files: PROFILE_FILE }, async (root) => {
      const set = makeBinding();
      const mutation: RelationOperationMutation = {
        kind: "relation", index: 0, mutationId: set.onDisk.mutationId, dependsOn: [], reconciliationRefs: [], operation: "create",
        target: { relationType: "related", from: EXPERIMENT_A, to: IDEA_B }, attributes: {}, precondition: { kind: "absent" },
        postcondition: { digest: `sha256:${REF_M1.contentHash}` as OperationDigest, recordId: M1 },
      };
      // A fresh store needs no repair, so `markdown.atomicWrite` is reached only by the seal.
      expect((await relationAdapter.apply(makeContext(root, mutation, set))).status).toBe("applied");
    });
  });
});
