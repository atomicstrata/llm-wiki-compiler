/**
 * @file test/storage/lifecycle-apply-binding.test.ts
 * @description The lifecycle transition's under-lock write, whole:
 * `applyLifecycleLockedWith` loads the profile, resolves and reads the entity
 * page, decides, runs the gated-state seam, checks the audit store's health and
 * the event's size, writes the page under ONE journal batch of its own (open,
 * record, write, commit), then appends the event (bound or not). The bound body
 * exists only after the handler was given sources, so this file has NO
 * before-edit run.
 *
 * HOW IT IS BUILT. Three projects are minted on real disk, once, and copied
 * BEFORE their disk ask: a fresh research-lite project, one whose audit store is
 * a base-version (v1) store with one record, and one with a tampered head. On
 * `fresh` and `tampered` the disk ask is the ROOT `transitionLifecycle` (the SDK
 * user action: the caller's lock, the gate, the executor, the handler) and the
 * memory replay is the bound executor with the BOUND lifecycle handler. On `v1`
 * the disk ask is the ROOT `applyLifecycleLocked(root, m, binding)` as the bundle
 * adapter calls it — it does NOT take or exercise the caller's lock — and the
 * memory replay is the body with the same binding.
 *
 * ONE MEMORY MAP. The executor's replay, the lifecycle journal and the page
 * write share one map of files and directories, so a failed write leaves a real
 * pending batch the next executor call's REAL replay lists, loads, restores and
 * removes.
 *
 * WHAT IS CHECKED PER SIDE. The page's exact bytes, the journal directory's
 * entries, and the event store whole by the real reader (problems, chain, head
 * sealing the last record, strict — `readEventsStrict` on disk; derived in
 * memory, because its body is root-bound). An interior bad record throws; a bad
 * last record is a tolerated torn tail, reported and dropped. Only a minted
 * event's id, `at`, `prevHash` and `checksum` are hidden across sides.
 *
 * WHAT IS MEMORY ONLY, AND NOT A REAL GUARD. The maps, the trace, the faults, and
 * the gate member: in memory it is a no-op RECORDER (this profile declares no
 * gated requirement, so the real seam would read nothing either). Gated
 * authorization is NOT covered here; `profile-lifecycle-enforce`,
 * `relation-precondition-enforce`, `artifact-precondition-lifecycle-transition`
 * and `gated-state-entry-priority` cover it on real files. Nothing here shows
 * the lock, real confinement, fsync, journal power-loss durability, or
 * cross-store atomicity.
 */

import path from "node:path";
import { describe, expect, it, vi } from "bun:test";
import * as eventRecord from "../../src/events/store-record.js";
import * as profileBlock from "../../src/profile/block.js";
import * as lifecycleRead from "../../src/profile/lifecycle-read.js";
import * as diskLeaves from "../../src/storage/disk-guarded-leaves.js";
import { applyApprovedMutationsLockedFrom } from "../../src/trust/executor.js";
import * as gatedStateEntry from "../../src/trust/gated-state-entry.js";
import { applyLifecycleLocked, applyLifecycleLockedWith, type LifecycleApplySources } from "../../src/trust/lifecycle-apply.js";
import { transitionLifecycle } from "../../src/trust/lifecycle-transition.js";
import type { LifecycleTransitionPlannedMutation } from "../../src/trust/planner.js";
import * as markdown from "../../src/utils/markdown.js";
import type { OperationBinding } from "../../src/utils/operation-binding.js";
import { RESEARCH_LITE_PROFILE } from "../fixtures/profile-fixtures.js";
import {
  auditSeeds, boundOn, EVENTS, eventsOf, EVT_V1, EVT_V2, expectBoundSilentRootReaches, expectCopiesHoldSeeds, freshBinding, health, HEALTHY, normalized, ONE,
  seededParity, shownEventLines, TWO, type AuditReads,
} from "./audit-event-fixtures.js";
import { effectiveProfileOf, unasked, type Copy } from "./copied-project.js";
import {
  diskJournalledReads, executorPorts, journalIo, JOURNAL, keyOf, MEM_ROOT, memoryEvents, memorySideReads, put, shownKey, type MemoryMap,
} from "./journal-memory-map.js";

const PREFIX = "lifecycle-apply-binding-";
const PAGE = "wiki/ideas/sparse-routing.md";
const SEED_PAGE = "---\nstatus: proposed\n---\n\n# sparse-routing\n";
const SEEDS = auditSeeds({ ".llmwiki/profile.json": JSON.stringify(RESEARCH_LITE_PROFILE), [PAGE]: SEED_PAGE });
type Scenario = keyof typeof SEEDS;
const BINDING = freshBinding();
const transition = (toState: string, slug = "sparse-routing"): LifecycleTransitionPlannedMutation => ({ kind: "lifecycle-transition", entityType: "ideas", slug, toState });
const PLANS: Record<Scenario, LifecycleTransitionPlannedMutation[]> = {
  fresh: [transition("testing"), transition("tested"), transition("proposed"), transition("testing", "nope")],
  v1: [transition("testing")],
  tampered: [transition("testing")],
};
/** The `v1` scenario is the bundle's bound call on both sides; the rest the SDK transition (disk) and the executor (memory). */
const { tracker, minted, parity } = seededParity({ prefix: PREFIX, seeds: SEEDS, plans: PLANS, run: runScenario, ...boundOn<Scenario, Side>("v1", diskSide, memorySide) });

/** Every read and act one side answers for. */
interface Side extends AuditReads {
  apply(m: LifecycleTransitionPlannedMutation): Promise<unknown>;
  journal(): Promise<string[]>;
}

/** Health, each transition settled once, then the page, the journal entries, the events and health again. */
async function runScenario(side: Side, plan: LifecycleTransitionPlannedMutation[]): Promise<unknown> {
  const before = await health(side);
  const settled: unknown[] = [];
  for (const m of plan) settled.push(await side.apply(m).then(() => "applied", (error: Error) => `${error.name}: ${error.message}`));
  const events = shownEventLines(await side.text(EVENTS));
  return normalized({ before, settled, page: await side.text(PAGE), journal: await side.journal(), events, after: await health(side) });
}

/** The ROOT surfaces over one disk project: the SDK action, or the bundle's direct bound call. */
function diskSide(root: string, bound: boolean): Side {
  return {
    apply: (m) => (bound ? applyLifecycleLocked(root, m, BINDING) : transitionLifecycle(root, m.entityType, m.slug, m.toState)),
    ...diskJournalledReads(root),
  };
}

/** The ONE memory map (files and directories as POSIX keys under `MEM_ROOT`, the ordered log), plus one-shot faults. */
interface Memory extends MemoryMap { faults: { write?: boolean; eventAppend?: boolean } }
function take(memory: Memory, fault: keyof Memory["faults"]): boolean {
  const on = memory.faults[fault] === true;
  memory.faults[fault] = false;
  return on;
}

/** The lifecycle sources over the same map: the REAL profile loader over the copy, and a no-op gate RECORDER. */
function memorySources(memory: Memory, copy: Copy): LifecycleApplySources {
  const io = journalIo(memory);
  return {
    root: MEM_ROOT,
    loadProfile: () => { memory.log.push("profile"); return profileBlock.loadNonDefaultProfileFrom(effectiveProfileOf(copy, () => undefined)); },
    resolvePage: async (def, slug) => { memory.log.push(`resolve ${def.directory}/${slug}.md`); return memory.files.has(`${def.directory}/${slug}.md`) ? path.join(MEM_ROOT, def.directory, `${slug}.md`) : null; },
    readPage: async (real) => { memory.log.push(`read-page ${shownKey(real)}`); return memory.files.get(keyOf(real)) ?? ""; },
    enforceEntry: async (input) => { memory.log.push(`gate ${input.entityType}/${input.slug} ${input.enteredState}`); },
    journal: io, page: io,
    writeOne: async (filePath, content) => { memory.log.push(`write ${shownKey(filePath)}`); if (take(memory, "write")) throw new Error("injected write failure"); put(memory, filePath, content); },
    events: memoryEvents(memory, () => { if (take(memory, "eventAppend")) throw new Error("injected event append failure"); }),
  };
}

/** The memory side: the bound executor (replay first) with the bound lifecycle handler, or the body with the binding. */
function memorySide(copy: Copy, bound: boolean, faults: Memory["faults"] = {}): Side & { memory: Memory; replay(): Promise<unknown> } {
  const memory: Memory = { files: new Map(copy.files), dirs: new Set(copy.listings.keys()), log: [], faults };
  const sources = memorySources(memory, copy);
  const ports = executorPorts(memory, { relation: unasked("relation"), artifact: unasked("artifact"), lifecycle: (_root, m) => applyLifecycleLockedWith(sources, m) });
  return {
    memory,
    apply: (m) => (bound ? applyLifecycleLockedWith(sources, m, BINDING) : applyApprovedMutationsLockedFrom(ports, MEM_ROOT, [m])),
    replay: () => applyApprovedMutationsLockedFrom(ports, MEM_ROOT, []),
    ...memorySideReads(memory),
  };
}

const pageAt = (status: string): string => `---\nstatus: ${status}\n---\n\n# sparse-routing\n`;
const event = (n: number, from: string, to: string, binding?: OperationBinding) => ({
  id: `evt#${n}`, type: "lifecycle-transition", origin: "sdk", decision: "allow",
  payload: { entityType: "ideas", slug: "sparse-routing", from, to, evidenceKeys: [] }, ...(binding === undefined ? {} : { operationBinding: binding }), at: "<at>",
});
const EVT_HEADER_V1 = JSON.parse(EVT_V1) as unknown;

describe("the lifecycle transition's under-lock write, disk and memory, from three copied projects", () => {
  it("L1 runs after every minting directory was removed, on copies holding exactly their seeds", () => {
    expectCopiesHoldSeeds(minted, SEEDS, PREFIX);
  });

  it("L2 transitions twice, then refuses an illegal transition and an absent page, with exact page bytes and no journal left, as the disk did", async () => {
    expect(await parity("fresh")).toEqual({
      before: HEALTHY,
      settled: ["applied", "applied", expect.stringMatching(/^LifecycleTransitionError: typed page ideas\/sparse-routing violates the profile lifecycle: /u),
        "LifecycleTransitionUnavailableError: cannot transition lifecycle: no page at wiki/ideas/nope.md to transition"],
      page: pageAt("tested"), journal: [], events: [EVT_HEADER_V1, event(1, "proposed", "testing"), event(2, "testing", "tested")],
      after: HEALTHY,
    });
  });

  it("L3 refuses a tampered audit head BEFORE any batch opens, with the page and the store unchanged, as the disk did", async () => {
    const tampered = { problems: [`head anchor ${"0".repeat(64)} does not match last event`], chainOk: true, headSealsLast: false, strict: "EventStoreChainError" };
    expect(await parity("tampered")).toEqual({
      before: tampered, settled: ["EventStoreChainError: event store chain broken: head anchor does not match a committable store state"],
      page: SEED_PAGE, journal: [], events: [EVT_HEADER_V1, ONE, TWO], after: tampered,
    });
  });

  it("L4 raises a REAL v1 audit store to v2 through ONE durable call, keeping its record after the header, then appends the bound event, as the disk did", async () => {
    expect(await parity("v1")).toEqual({
      before: HEALTHY, settled: ["applied"], page: pageAt("testing"), journal: [],
      events: [JSON.parse(EVT_V2), ONE, event(1, "proposed", "testing", BINDING)], after: HEALTHY,
    });
    const side = memorySide(minted.v1.copy, true);
    await side.apply(transition("testing"));
    expect(side.memory.files.get(EVENTS)!.startsWith(EVT_V2 + eventsOf([ONE]).slice(EVT_V1.length))).toBe(true);
    expect(side.memory.log.filter((entry) => entry.startsWith("durable"))).toEqual(["durable events.jsonl"]);
  });
});

describe("the bound transition's order, its unknown outcomes, and no ambient call (memory only, not real guards)", () => {
  const repair = ["read events.jsonl", "private-dir", "head events.head"];
  const batch = ".llmwiki/journal/<batch>.json";

  it("L5 traces one unbound transition exactly: replay, context, gate, audit repair, pre-flight size, the journalled page write, then the event", async () => {
    const side = memorySide(minted.fresh.copy, false);
    await side.apply(transition("testing"));
    expect(side.memory.log).toEqual([
      "safe-realpath .llmwiki/journal", "profile", `resolve ${PAGE}`, `read-page ${PAGE}`, "gate ideas/sparse-routing testing",
      ...repair, ...repair, "size events.jsonl",
      "confine .llmwiki/journal", `replace ${batch}`,
      `confine ${PAGE}`, `read ${PAGE}`, "realpath .", `read ${PAGE}`, `replace ${batch}`, `write ${PAGE}`, `remove ${batch}`,
      ...repair, "append events.jsonl at 0", "write events.jsonl", "write events.jsonl", "seal",
    ]);
    expect(side.memory.log.filter((entry) => /^(durable|replace events)/u.test(entry))).toEqual([]);
  });

  it("L6 leaves a pending batch and no event when the page write fails, and the next executor call's REAL replay restores the original bytes and removes the batch", async () => {
    const side = memorySide(minted.fresh.copy, false, { write: true });
    await expect(side.apply(transition("testing"))).rejects.toThrow("injected write failure");
    expect([(await side.journal()).length, side.memory.files.get(PAGE), side.memory.files.has(EVENTS)]).toEqual([1, SEED_PAGE, false]);
    side.memory.log.length = 0;
    await side.replay();
    expect([await side.journal(), side.memory.files.get(PAGE), side.memory.files.has(EVENTS)]).toEqual([[], SEED_PAGE, false]);
    // The real replay lists the batch, loads it (no-follow), restores the page, THEN removes the batch.
    const steps = [`list ${JOURNAL} -> <batch>.json`, `read-nofollow ${batch}`, `restore ${PAGE}`, `remove ${batch}`];
    const at = steps.map((step) => side.memory.log.indexOf(step));
    expect(at.every((index, i) => index >= 0 && (i === 0 || index > at[i - 1]!))).toBe(true);
  });

  it("L7 commits the page and then fails the event append, leaving the page WITHOUT its event (the cross-store residual, shown not closed)", async () => {
    const side = memorySide(minted.fresh.copy, false, { eventAppend: true });
    await expect(side.apply(transition("testing"))).rejects.toThrow("injected event append failure");
    expect([side.memory.files.get(PAGE), await side.journal(), side.memory.files.has(EVENTS), await health(side)]).toEqual([pageAt("testing"), [], false, HEALTHY]);
  });

  it("L8 makes no ambient call in the bound route; the ROOT SDK transition reaches each handler seam across modules", async () => {
    const spies = [
      vi.spyOn(profileBlock, "loadNonDefaultProfile"), vi.spyOn(lifecycleRead, "resolveConfinedEntityPage"), vi.spyOn(markdown, "safeReadFile"),
      vi.spyOn(gatedStateEntry, "enforceGatedStateEntry"), vi.spyOn(diskLeaves, "replaceLeafAtomicWithin"), vi.spyOn(diskLeaves, "removeLeaf"),
      vi.spyOn(diskLeaves, "writeLeafAtomicUnconfined"), vi.spyOn(markdown, "atomicWrite"), vi.spyOn(eventRecord, "openEventFileRead"),
      vi.spyOn(eventRecord, "openEventFileAppend"),
    ];
    await expectBoundSilentRootReaches(spies, () => runScenario(memorySide(minted.fresh.copy, false), PLANS.fresh), { tracker, prefix: PREFIX, files: SEEDS.fresh },
      (root) => transitionLifecycle(root, "ideas", "sparse-routing", "testing"));
  });
});
