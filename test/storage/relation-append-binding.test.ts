/**
 * @file test/storage/relation-append-binding.test.ts
 * @description The relation CREATE, whole, over both append stores: the SDK's
 * `createRelation` lands in the held-lock executor, whose relation handler
 * re-loads the profile, re-plans and appends through `appendRelationLockedFrom`
 * — the audit store's repair precondition, the live read and dedup, the event's
 * size pre-flight, the record append, then the event append and the head seal.
 * The bound bodies exist only after the two stores were given write sources, so
 * this file has NO before-edit run.
 *
 * HOW IT IS BUILT. Four projects are minted on real disk, once, and copied
 * BEFORE their disk ask (`mintCopiedBeforeAsk`): a fresh profile project, a torn
 * trailing event line, a one-record-ahead store, and a tampered head. Each disk
 * ask runs the ROOT `createRelationForProject` (lock, gate, executor, handler)
 * over its plan. The memory replay runs the bound executor with the bound
 * handler over the copy, and must equal the disk.
 *
 * WHAT IS NORMALISED, AND ONLY ACROSS SIDES. Minted `rel_`/`evt_` ids become
 * ordinals and a minted event's `at` is hidden; an event's `prevHash` and
 * `checksum` and a relation's `checksum` are dropped from the shown lines
 * because they cover the minted id. The event store is checked whole per side;
 * the relation store is compared normalised and read for real only by the dedup.
 * The event check covers per-record checksums (an interior bad record throws; a
 * bad last record is a tolerated torn tail, reported and dropped), the chain, and
 * the head sealing the last record. On disk `readEventsStrict` is asked; in memory its two
 * checks are derived from `verifyEventChain` and `eventPrevHash`, because its
 * body is root-bound. A FAULT state is shown by its diagnostics BEFORE the
 * create, and strict health only AFTER the repair.
 *
 * WHAT IS MEMORY ONLY, AND NOT A REAL GUARD. The ordered trace, the two
 * injected faults and every map answer. Links, special files, confinement,
 * caps on real files, the lock and the gate stay with `relation-store-*`,
 * `relation-graph-confine`, `fifo-leaf-hardening`, `portable-nofollow` and the
 * event-store suites. The executor's journal port answers "no journal" only;
 * the page ports are never asked. The cross-store residual is SHOWN, not closed:
 * a record whose event failed stays without its event.
 */

import path from "node:path";
import { describe, expect, it, vi } from "bun:test";
import { eventPrevHash } from "../../src/events/event-digest.js";
import type { EventWriteSources } from "../../src/events/store.js";
import * as eventRecord from "../../src/events/store-record.js";
import * as profileBlock from "../../src/profile/block.js";
import type { EntityId } from "../../src/profile/types.js";
import { relationContentHash } from "../../src/relations/digest.js";
import * as relationRecord from "../../src/relations/store-record.js";
import * as relationStore from "../../src/relations/store.js";
import type { AppendRelationInput, RelationAppendSources } from "../../src/relations/store.js";
import type { RelationRef } from "../../src/relations/types.js";
import { applyApprovedMutationsLockedFrom, type ApprovedMutationPorts } from "../../src/trust/executor.js";
import * as relationApply from "../../src/trust/relation-apply.js";
import { createRelationForProject } from "../../src/trust/relation-write.js";
import * as jsonlStore from "../../src/utils/jsonl-store.js";
import * as markdown from "../../src/utils/markdown.js";
import { EXPERIMENT_A, IDEA_B, relatedProfile } from "../fixtures/profile-fixtures.js";
import {
  diskAuditReads, EVENTS, eventsOf, expectBoundSilentRootReaches, expectCopiesHoldSeeds, HEAD, health, HEALTHY, memoryAuditReads, ONE, seededParity, TWO, type AuditReads, type FaultedMemory,
} from "./audit-event-fixtures.js";
import { effectiveProfileOf, unasked, type Copy } from "./copied-project.js";
import { memoryEventHeadReads, memoryGraphReads } from "./graph-store-memory.js";

const PREFIX = "relation-append-binding-";
const MEM_ROOT = path.resolve("/memory/project");
const RELATIONS = "wiki/graph/relations.jsonl";
const C = "experiments/c" as EntityId;
const A: AppendRelationInput = { type: "related", from: EXPERIMENT_A, to: IDEA_B };
/** Symmetric: written with its endpoints swapped into canonical order. */
const B: AppendRelationInput = { type: "related", from: IDEA_B, to: C };
const DENIED: AppendRelationInput = { type: "unknown", from: EXPERIMENT_A, to: IDEA_B };
const PROFILE = { ".llmwiki/profile.json": JSON.stringify(relatedProfile()) };
const SEEDS = {
  fresh: PROFILE,
  torn: { ...PROFILE, [EVENTS]: eventsOf([ONE]) + `{"id":"evt_torn`, [HEAD]: eventPrevHash(ONE) },
  oneAhead: { ...PROFILE, [EVENTS]: eventsOf([ONE, TWO]), [HEAD]: eventPrevHash(ONE) },
  tamper: { ...PROFILE, [EVENTS]: eventsOf([ONE, TWO]), [HEAD]: "0".repeat(64) },
};
type Scenario = keyof typeof SEEDS;
const PLANS: Record<Scenario, AppendRelationInput[]> = { fresh: [A, A, B, DENIED], torn: [A], oneAhead: [A], tamper: [A] };

/** Every read and write one side answers for. */
interface Side extends AuditReads {
  create(input: AppendRelationInput): Promise<RelationRef>;
}

const MINTED = /\b(rel|evt)_[0-9A-HJKMNP-TV-Z]{26}\b/gu;
const isMinted = (id: unknown): boolean => typeof id === "string" && /^(rel|evt)_[0-9A-HJKMNP-TV-Z]{26}$/u.test(id);

/** Replace minted ids by ordinals in order of first appearance; nothing else changes. */
function normalized(value: unknown): unknown {
  const seen = new Map<string, string>();
  const ordinal = (id: string, kind: string): string => {
    if (!seen.has(id)) seen.set(id, `${kind}#${[...seen.keys()].filter((key) => key.startsWith(kind)).length + 1}`);
    return seen.get(id)!;
  };
  return JSON.parse(JSON.stringify(value).replace(MINTED, ordinal));
}

/** A store's lines as shown: the header parsed, each record through `shown`, an unparsable line as `<torn>`. */
function shownLines(text: string | null, shown: (record: Record<string, unknown>) => unknown): unknown {
  if (text === null) return null;
  return text.split("\n").filter((line) => line !== "").map((line, at) => {
    try { return at === 0 ? JSON.parse(line) : shown(JSON.parse(line)); } catch { return "<torn>"; }
  });
}

/** Both stores and the head, as shown across sides. */
async function shownStores(side: Side): Promise<unknown> {
  return {
    relations: shownLines(await side.text(RELATIONS), ({ checksum: _checksum, ...rest }) => rest),
    events: shownLines(await side.text(EVENTS), ({ checksum: _checksum, prevHash: _prev, ...rest }) => (isMinted(rest.id) ? { ...rest, at: "<at>" } : rest)),
    head: (await side.text(HEAD)) === null ? null : "<head>",
  };
}

/** Diagnostics, then each create settled once, then the stores and the health they were left in. */
async function runScenario(side: Side, inputs: AppendRelationInput[]): Promise<unknown> {
  const before = await health(side);
  const settled: unknown[] = [];
  for (const input of inputs) settled.push(await side.create(input).then((ref) => ref, (error: Error) => `${error.name}: ${error.message}`));
  return normalized({ before, settled, stores: await shownStores(side), after: await health(side) });
}

/** The ROOT surface over one disk project. */
function diskSide(root: string): Side {
  return { create: (input) => createRelationForProject(root, input), ...diskAuditReads(root) };
}

const { tracker, minted, parity } = seededParity({ prefix: PREFIX, seeds: SEEDS, plans: PLANS, run: runScenario, disk: diskSide, memory: (copy) => memorySide(copy) });

/** The memory project and its ordered log. One-shot faults are taken when first met. */
type Memory = FaultedMemory<{ partialEventAppend?: boolean; rejectSeal?: boolean }>;

/** Take a one-shot fault: true once, then cleared. */
function take(memory: Memory, fault: keyof Memory["faults"]): boolean {
  const on = memory.faults[fault] === true;
  memory.faults[fault] = false;
  return on;
}

/** The handle-held append over the map: the leaf is created, its size taken, then each pulled chunk written in order. */
async function memoryAppend(memory: Memory, rel: string, plan: jsonlStore.GraphAppendPlan, partial: boolean): Promise<void> {
  const existing = Buffer.byteLength(memory.files.get(rel) ?? "");
  memory.log.push(`append ${path.posix.basename(rel)} at ${existing}`);
  memory.files.set(rel, memory.files.get(rel) ?? "");
  for (const chunk of plan(existing)) {
    if (partial && !chunk.includes("store-header")) {
      memory.files.set(rel, memory.files.get(rel)! + chunk.slice(0, chunk.length >> 1));
      throw new Error("injected append failure");
    }
    memory.log.push(`write ${path.posix.basename(rel)}`);
    memory.files.set(rel, memory.files.get(rel)! + chunk);
  }
}

/** The event store's write sources over the map. */
function memoryEvents(memory: Memory): EventWriteSources {
  return {
    graph: memoryGraphReads(memory),
    ...memoryEventHeadReads(memory),
    replaceStore: async (body) => { memory.log.push("replace events.jsonl"); memory.files.set(EVENTS, body); },
    appendStore: (plan) => memoryAppend(memory, EVENTS, plan, take(memory, "partialEventAppend")),
    storeByteSize: async () => { memory.log.push("size events.jsonl"); return Buffer.byteLength(memory.files.get(EVENTS) ?? ""); },
    sealHead: async (digest) => {
      memory.log.push("seal");
      if (take(memory, "rejectSeal")) throw new Error("injected seal failure");
      memory.files.set(HEAD, digest);
    },
  };
}

/** Members the executor must never ask on this journey; the journal answers only "no journal". */
const unaskedExcept = <T extends object>(held: Partial<T>): T =>
  new Proxy(held, { get: (target, key) => (key in target ? target[key as keyof typeof target] : unasked(String(key))) }) as T;

/** The bound executor, with the BOUND relation handler over the memory stores and the real profile loader over the copy. */
function memoryPorts(memory: Memory, copy: Copy): ApprovedMutationPorts {
  const events = memoryEvents(memory);
  const sources: RelationAppendSources = { graph: { ...memoryGraphReads(memory), appendStore: (plan) => memoryAppend(memory, RELATIONS, plan, false) }, events };
  const steps: relationApply.RelationApplySteps = {
    loadProfile: () => profileBlock.loadNonDefaultProfileFrom(effectiveProfileOf(copy, () => undefined)),
    append: (profile, input, decision) => relationStore.appendRelationLockedFrom(sources, profile, input, decision),
  };
  const journal = unaskedExcept<ApprovedMutationPorts["journal"]>({ safeRealPath: async () => { memory.log.push("journal-replay"); return null; } });
  return {
    journal, page: unaskedExcept<ApprovedMutationPorts["page"]>({}), writeOne: unasked("writeOne"), notes: unasked("notes"),
    handlers: { relation: (_root, mutation) => relationApply.applyRelationLockedWith(steps, mutation), lifecycle: unasked("lifecycle"), artifact: unasked("artifact") },
  };
}

/** The memory side over one copy; `memory` is exposed for the trace and the faults. */
function memorySide(copy: Copy, faults: Memory["faults"] = {}): Side & { memory: Memory } {
  const memory: Memory = { files: new Map(copy.files), log: [], faults };
  const ports = memoryPorts(memory, copy);
  return {
    memory,
    create: async (input) => {
      const [result] = await applyApprovedMutationsLockedFrom(ports, MEM_ROOT, [{ kind: "relation", operation: "create", input }]);
      if (result?.kind !== "relation") throw new Error("not a relation result");
      return result.ref;
    },
    ...memoryAuditReads(memory.files, memoryEvents({ ...memory, log: [] })),
  };
}

const REF_A = { id: "rel#1", type: "related", from: EXPERIMENT_A, to: IDEA_B, attributes: {}, contentHash: relationContentHash({ type: "related", from: EXPERIMENT_A, to: IDEA_B, attributes: {} }) };
const REF_B = { id: "rel#2", type: "related", from: C, to: IDEA_B, attributes: {}, contentHash: relationContentHash({ type: "related", from: C, to: IDEA_B, attributes: {} }) };
const event = (n: number, ref: typeof REF_A) => ({ id: `evt#${n}`, type: "relation-create", origin: "sdk", payload: { id: ref.id, relType: "related", from: ref.from, to: ref.to }, decision: "allow", at: "<at>" });
const [EVENT_HEADER, RELATION_HEADER] = [{ kind: "event-store-header", schemaVersion: 1 }, { kind: "relation-store-header", schemaVersion: 1 }];
const headMismatch = (anchor: string) => `head anchor ${anchor} does not match last event`;

/** The next create (B) recovers the fault: both records, B's event alone, the head sealed, healthy. */
async function expectRepairedByB(side: ReturnType<typeof memorySide>): Promise<void> {
  await side.create(B);
  expect(normalized({ stores: await shownStores(side), health: await health(side) })).toEqual({
    stores: { relations: [RELATION_HEADER, REF_A, REF_B], events: [EVENT_HEADER, event(1, REF_B)], head: "<head>" }, health: HEALTHY,
  });
}

describe("the relation create over both stores, disk and memory, from four copied projects", () => {
  it("R1 runs after every minting directory was removed, on copies holding exactly their seeds", () => {
    expectCopiesHoldSeeds(minted, SEEDS, PREFIX);
  });

  it("R2 creates, dedups, canonicalises and denies through the user action, both stores and the head as the disk did", async () => {
    expect(await parity("fresh")).toEqual({
      before: HEALTHY,
      settled: [REF_A, REF_A, REF_B, "RelationWriteDeniedError: relation write of type 'unknown' denied by the write planner (deny); nothing written"],
      stores: { relations: [RELATION_HEADER, REF_A, REF_B], events: [EVENT_HEADER, event(1, REF_A), event(2, REF_B)], head: "<head>" },
      after: HEALTHY,
    });
  });

  it("R3 repairs a torn trailing line and drops a one-ahead record BEFORE chaining, after showing each fault's diagnostics, as the disk did", async () => {
    const torn = "tolerated torn trailing line: event store corrupt: record line is not valid JSON";
    expect(await parity("torn")).toEqual({
      before: { ...HEALTHY, problems: [torn] }, settled: [REF_A],
      stores: { relations: [RELATION_HEADER, REF_A], events: [EVENT_HEADER, ONE, event(1, REF_A)], head: "<head>" }, after: HEALTHY,
    });
    expect(await parity("oneAhead")).toEqual({
      before: { problems: [headMismatch(eventPrevHash(ONE))], chainOk: true, headSealsLast: false, strict: "EventStoreChainError" }, settled: [REF_A],
      stores: { relations: [RELATION_HEADER, REF_A], events: [EVENT_HEADER, ONE, event(1, REF_A)], head: "<head>" }, after: HEALTHY,
    });
  });

  it("R4 refuses a tampered head and a denied type with both stores byte-identical, and writes nothing in memory", async () => {
    const tampered = { problems: [headMismatch("0".repeat(64))], chainOk: true, headSealsLast: false, strict: "EventStoreChainError" };
    expect(await parity("tamper")).toEqual({
      before: tampered, settled: ["EventStoreChainError: event store chain broken: head anchor does not match a committable store state"],
      stores: { relations: null, events: [EVENT_HEADER, ONE, TWO], head: "<head>" }, after: tampered,
    });
    for (const [name, input] of [["tamper", A], ["fresh", DENIED]] as const) {
      const side = memorySide(minted[name].copy);
      await expect(side.create(input)).rejects.toThrow();
      expect([Object.fromEntries(side.memory.files), side.memory.log.filter((call) => /^(append|write|replace|seal)/u.test(call))]).toEqual([SEEDS[name], []]);
    }
  });
});

describe("the bound create's order, its unknown outcomes, and no ambient call (memory only, not real guards)", () => {
  /** The create's whole store conversation: repair read (store, then the anchor it judges), live read, pre-flight, record, event, seal. */
  const prepare = ["read events.jsonl", "private-dir", "head events.head"];

  it("R5a reads, repairs, pre-flights, appends the record (serialised twice, at the incumbent points), then the event, then seals", async () => {
    const real = relationRecord.serializeRecord;
    const side = memorySide(minted.fresh.copy);
    vi.spyOn(relationRecord, "serializeRecord").mockImplementation((ref, binding) => { side.memory.log.push("serialize"); return real(ref, binding); });
    await side.create(A);
    const record = (at: number, chunks: string[]) => [`append relations.jsonl at ${at}`, ...chunks];
    expect(side.memory.log).toEqual([
      "journal-replay", "serialize", ...prepare, "read relations.jsonl", ...prepare, "size events.jsonl",
      ...record(0, ["serialize", "write relations.jsonl", "serialize", "write relations.jsonl"]),
      ...prepare, "append events.jsonl at 0", "write events.jsonl", "write events.jsonl", "seal",
    ]);
    side.memory.log.length = 0;
    const held = Buffer.byteLength(side.memory.files.get(RELATIONS)!);
    await side.create(B);
    // A non-empty leaf: no header, so both serialisations precede the one write, as before.
    expect(side.memory.log.filter((call) => /^(serialize|append relations|write relations)/u.test(call)))
      .toEqual(["serialize", ...record(held, ["serialize", "serialize", "write relations.jsonl"])]);
  });

  it("R5b leaves a record WITHOUT its event when the event append tears (the cross-store residual), then the next create repairs the tail", async () => {
    const side = memorySide(minted.fresh.copy, { partialEventAppend: true });
    await expect(side.create(A)).rejects.toThrow("injected append failure");
    const residual = normalized({ stores: await shownStores(side), health: await health(side) });
    expect(residual).toEqual({
      stores: { relations: [RELATION_HEADER, REF_A], events: [EVENT_HEADER, "<torn>"], head: null },
      health: { problems: ["tolerated torn trailing line: event store corrupt: record line is not valid JSON"], chainOk: true, headSealsLast: true, strict: "ok" },
    });
    await expectRepairedByB(side);
  });

  it("R5c leaves a one-ahead store when the seal fails, and the next create drops that uncommitted event before chaining", async () => {
    const side = memorySide(minted.fresh.copy, { rejectSeal: true });
    await expect(side.create(A)).rejects.toThrow("injected seal failure");
    expect((await health(side) as { problems: string[] }).problems).toEqual([headMismatch("<absent>")]);
    await expectRepairedByB(side);
  });

  it("R6 makes no ambient call in the bound route; the root create reaches every one of them across modules", async () => {
    const spies = [
      vi.spyOn(profileBlock, "loadNonDefaultProfile"), vi.spyOn(relationStore, "appendRelationLocked"), vi.spyOn(relationApply, "applyRelationLocked"),
      vi.spyOn(relationRecord, "resolveGraphDir"), vi.spyOn(relationRecord, "openStoreFileAppend"), vi.spyOn(eventRecord, "resolveEventGraphDir"),
      vi.spyOn(eventRecord, "openEventFileAppend"), vi.spyOn(eventRecord, "openEventFileRead"), vi.spyOn(jsonlStore, "resolveConfinedGraphDir"),
      vi.spyOn(jsonlStore, "openGraphFileAppend"), vi.spyOn(markdown, "atomicWrite"),
    ];
    await expectBoundSilentRootReaches(spies, () => runScenario(memorySide(minted.fresh.copy), PLANS.fresh), { tracker, prefix: PREFIX, files: PROFILE },
      (root) => createRelationForProject(root, A));
  });
});
