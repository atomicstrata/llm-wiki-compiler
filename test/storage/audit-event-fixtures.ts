/**
 * @file test/storage/audit-event-fixtures.ts
 * @description The audit-store scaffolding the bound-write parity suites share
 * (`artifact-apply`, `artifact-members`, `lifecycle-apply`, `relation-append` and
 * `relation-operation-append`): seeded event stores built by the production
 * serializer, the minted-event normalization, the real reader's health view, the
 * disk sides' audit reads, the seeded-scenario minting, the seeded-copy check,
 * scenario parity, and the "bound route is silent, root route reaches" check.
 *
 * WHAT IT IS NOT. It holds no suite's policy: each suite keeps its own scenarios,
 * plans, sides, memory doubles and assertions. Nothing here touches the real
 * project except the disk audit reads and the minting, which the suites asked of
 * their own temporary roots.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { expect } from "bun:test";
import { eventPrevHash } from "../../src/events/event-digest.js";
import { readEvents, readEventsFrom, readEventsStrict, readEventsStrictFrom, verifyEventChain, type EventReadSources } from "../../src/events/store-read.js";
import * as eventRecord from "../../src/events/store-record.js";
import { GENESIS_PREV_HASH, type EventContent, type EventRecord } from "../../src/events/types.js";
import { mintBundleId, mintOperationRunId, mutationId } from "../../src/operation-bundles/ids.js";
import type { OperationBinding } from "../../src/utils/operation-binding.js";
import { tempRootTracker, type TempRootTrackerV1 } from "../temp-roots.js";
import { mintCopiedBeforeAsk, mintOnceThenRemove, writeFiles, type Copy, type Minted } from "./copied-project.js";
import { expectMintingDirectoryRemoved } from "./minted-directory.js";
import { expectBoundSilentThenFreshRoot } from "./project-tree.js";

/** The audit store and its sealed head, as project-relative keys. */
export const [EVENTS, HEAD] = ["wiki/graph/events.jsonl", ".llmwiki/events.head"] as const;
/** The base-version (v1) and current (v2) event-store headers, as written. */
export const [EVT_V1, EVT_V2] = [`{"kind":"event-store-header","schemaVersion":1}\n`, `{"kind":"event-store-header","schemaVersion":2}\n`] as const;
/** One seeded (pre-existing) event record's content. */
const seeded = (n: number): EventContent => ({ id: `evt_seed${n}`, type: "relation-create", origin: "test", payload: { n }, at: "2026-01-01T00:00:00Z" });
export const [ONE, TWO] = [seeded(1), seeded(2)];
/** A base-version event store holding `items`, chained in order, each line by the production serializer. */
export const eventsOf = (items: EventContent[]): string => EVT_V1 + items.map((item, at) =>
  eventRecord.serializeEventRecord({ ...item, prevHash: at === 0 ? GENESIS_PREV_HASH : eventPrevHash(items[at - 1]!) })).join("");
/** The three audit seeds every bound-write suite mints over its own base: fresh, a REAL v1 store with one record, and a tampered head. */
export const auditSeeds = <Base extends Record<string, string>>(base: Base) => ({
  fresh: base,
  v1: { ...base, [EVENTS]: eventsOf([ONE]), [HEAD]: eventPrevHash(ONE) },
  tampered: { ...base, [EVENTS]: eventsOf([ONE, TWO]), [HEAD]: "0".repeat(64) },
});

/** A freshly minted operation binding for one bundle's mutation `index`. */
export function freshBinding(index = 0): OperationBinding {
  const bundle = mintBundleId();
  return { bundleId: bundle, runId: mintOperationRunId(), mutationId: mutationId(bundle, index) };
}

const MINTED = /\bevt_[0-9A-HJKMNP-TV-Z]{26}\b/gu;
/** Whether `id` is a minted (not seeded) event id. */
const isMintedEvent = (id: unknown): boolean => typeof id === "string" && /^evt_[0-9A-HJKMNP-TV-Z]{26}$/u.test(id);
/** Hide an event's chain fields, and a minted event's `at`. */
export const shownEvent = ({ checksum: _checksum, prevHash: _prev, ...rest }: Record<string, unknown>): unknown =>
  (isMintedEvent(rest.id) ? { ...rest, at: "<at>" } : rest);
/** Replace minted event ids by ordinals in order of first appearance; nothing else changes. */
export function normalized(value: unknown): unknown {
  const seen = new Map<string, string>();
  return JSON.parse(JSON.stringify(value).replace(MINTED, (id) => { if (!seen.has(id)) seen.set(id, `evt#${seen.size + 1}`); return seen.get(id)!; }));
}
/** An event store's lines as shown: the header parsed, each record through {@link shownEvent}; `null` when absent. */
export const shownEventLines = (text: string | null): unknown =>
  (text === null ? null : text.split("\n").filter((line) => line !== "").map((line, at) => (at === 0 ? JSON.parse(line) : shownEvent(JSON.parse(line)))));

/** The audit reads every side answers: one stored text, the real reader, and its strict verdict. */
export interface AuditReads {
  text(rel: string): Promise<string | null>;
  events(): Promise<{ events: EventRecord[]; problems: string[] }>;
  strict(): Promise<string>;
}
/** The healthy audit view, as {@link health} reports it. */
export const HEALTHY = { problems: [], chainOk: true, headSealsLast: true, strict: "ok" };
/** The real reader's view of the audit store on one side: problems, the chain, the head sealing the last record, and strict. */
export async function health(side: AuditReads): Promise<unknown> {
  const { events, problems } = await side.events();
  const last = events.at(-1);
  const head = (await side.text(HEAD))?.trim() ?? null;
  return { problems, chainOk: verifyEventChain(events).ok, headSealsLast: head === (last === undefined ? null : eventPrevHash(last)), strict: await side.strict() };
}

/** The disk audit reads of one project: a text (null when absent), the real reader, and `readEventsStrict` as a verdict. */
export function diskAuditReads(root: string): AuditReads {
  return {
    text: (rel) => readFile(path.join(root, rel), "utf-8").catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; }),
    events: () => readEvents(root),
    strict: () => readEventsStrict(root).then(() => "ok", (error: Error) => error.name),
  };
}
/** The memory audit reads over one text map, through quiet (unlogged) event sources; strict is the REAL strict body as a verdict. */
export function memoryAuditReads(files: Map<string, string>, quiet: EventReadSources): AuditReads {
  return {
    text: async (rel) => files.get(rel) ?? null,
    events: () => readEventsFrom(quiet),
    strict: () => readEventsStrictFrom(quiet).then(() => "ok", (error: Error) => error.name),
  };
}

/** Mint every seeded scenario once, in seed order, copied BEFORE its disk ask; the tracker removes them all before any case runs. */
function mintSeededScenarios<Scenario extends string>(
  tracker: TempRootTrackerV1, prefix: string, seeds: Record<Scenario, Record<string, string>>,
  ask: (name: Scenario, root: string) => Promise<unknown>,
): Record<Scenario, Minted<unknown>> {
  const minted = {} as Record<Scenario, Minted<unknown>>;
  mintOnceThenRemove(tracker, async () => {
    for (const name of Object.keys(seeds) as Scenario[]) {
      minted[name] = await mintCopiedBeforeAsk(tracker, prefix, (root) => writeFiles(root, seeds[name]), (root) => ask(name, root));
    }
  });
  return minted;
}

/** Every minting directory is gone, and each copy holds exactly its seed. */
export function expectCopiesHoldSeeds<Scenario extends string>(
  minted: Record<Scenario, Minted<unknown>>, seeds: Record<Scenario, Record<string, string>>, prefix: string,
): void {
  for (const name of Object.keys(seeds) as Scenario[]) {
    expectMintingDirectoryRemoved(minted[name].dir, prefix);
    expect(Object.fromEntries([...minted[name].copy.files].sort(([a], [b]) => a.localeCompare(b)))).toEqual(Object.fromEntries(Object.entries(seeds[name]).sort(([a], [b]) => a.localeCompare(b))));
  }
}

/** A suite's memory project: its files, its ordered log, and its own one-shot faults. */
export interface FaultedMemory<Faults> { files: Map<string, string>; log: string[]; faults: Faults }

/** One suite's parity scenarios: seeds and plans by name, how one plan runs over a side, and how each side is built. */
export interface ParitySuite<Scenario extends string, Side, Plan> {
  prefix: string;
  seeds: Record<Scenario, Record<string, string>>;
  plans: Record<Scenario, Plan>;
  run(side: Side, plan: Plan): Promise<unknown>;
  disk(root: string, name: Scenario): Side;
  memory(copy: Copy, name: Scenario): Side;
}

/**
 * The parity protocol over a fresh tracker: every seeded scenario is minted once on
 * disk and its plan run over the disk side ({@link mintSeededScenarios}); `parity(name)`
 * runs the same plan over the memory side of that scenario's copy and requires the
 * disk's outcome.
 */
export function seededParity<Scenario extends string, Side, Plan>(suite: ParitySuite<Scenario, Side, Plan>): {
  tracker: TempRootTrackerV1; minted: Record<Scenario, Minted<unknown>>; parity(name: Scenario): Promise<unknown>;
} {
  const tracker = tempRootTracker();
  const minted = mintSeededScenarios(tracker, suite.prefix, suite.seeds, (name, root) => suite.run(suite.disk(root, name), suite.plans[name]));
  const parity = async (name: Scenario): Promise<unknown> => {
    const outcome = await suite.run(suite.memory(minted[name].copy, name), suite.plans[name]);
    expect(outcome).toEqual(minted[name].onDisk);
    return outcome;
  };
  return { tracker, minted, parity };
}

/** The two sides of a suite whose `bound` scenario takes the bundle's bound call on both sides, and every other scenario its unbound route. */
export function boundOn<Scenario extends string, Side>(
  bound: Scenario, disk: (root: string, isBound: boolean) => Side, memory: (copy: Copy, isBound: boolean) => Side,
): Pick<ParitySuite<Scenario, Side, unknown>, "disk" | "memory"> {
  return { disk: (root, name) => disk(root, name === bound), memory: (copy, name) => memory(copy, name === bound) };
}

/**
 * The bound route calls none of `spies`; then a fresh project seeded with `fresh.files`
 * is asked through the root route (`rootAct`), which must reach every one of them.
 * Returns that root.
 */
export async function expectBoundSilentRootReaches(
  spies: ReadonlyArray<{ mock: { calls: unknown[] } }>, bound: () => Promise<unknown>,
  fresh: { tracker: TempRootTrackerV1; prefix: string; files: Record<string, string> }, rootAct: (root: string) => Promise<unknown>,
): Promise<string> {
  const root = await expectBoundSilentThenFreshRoot(spies, bound, { tracker: fresh.tracker, prefix: fresh.prefix, seed: (at) => writeFiles(at, fresh.files) });
  await rootAct(root);
  expect(spies.map((spy) => spy.mock.calls.length > 0)).toEqual(spies.map(() => true));
  return root;
}
