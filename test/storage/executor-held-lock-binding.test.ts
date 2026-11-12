/**
 * @file test/storage/executor-held-lock-binding.test.ts
 * @description The production held-lock executor, WHOLE, over raw journal and
 * page I/O held in ONE in-memory map: `applyApprovedMutationsLockedFrom` replays
 * FIRST (before the shape guard, for an empty or a refused plan too), opens a
 * journal batch, runs the REAL per-page body for each page in plan order with a
 * recorder that records through the SAME journal I/O, writes, and commits; a
 * mid-batch write failure leaves a pending journal that the next call's replay
 * restores; a lone non-page mutation goes to its domain handler and the
 * handler's ref and decision are forwarded. The body exists only after the
 * executor was given a body of its own, so this file has NO before-edit run.
 *
 * HOW IT IS BUILT. One project is minted on real disk, once, and copied BEFORE
 * its disk ask (`mintCopiedBeforeAsk`); its seed is two text pages. The ask runs
 * five steps through the ROOT `applyApprovedMutationsLocked` (an `opts.writeOne`
 * that fails on its second call drives the two failures), settling each once,
 * with the whole tree; a pending journal is shown by status and entries (target
 * relative, pre-state), its name normalised. The memory replay must equal the
 * disk, and both must equal the literals written here.
 *
 * WHAT IS MEMORY ONLY, AND NOT A REAL GUARD. The ordered trace, the non-page
 * handlers (fakes: the real ones are root-bound domain authorities this file
 * does not run) and every map answer. Confinement, links, caps, the lock and
 * crash recovery on disk stay with `executor-*`, `compile-write`, the journal
 * suites and `page-apply-binding`. No lock is taken: the held-lock core
 * acquires nothing, and the self-locking wrapper is not bound.
 */

import path from "node:path";
import { describe, expect, it, vi } from "bun:test";
import * as artifactApply from "../../src/artifacts/apply.js";
import * as diskLeaves from "../../src/storage/disk-guarded-leaves.js";
import * as diskLocations from "../../src/storage/disk-locations.js";
import * as executor from "../../src/trust/executor.js";
import {
  applyApprovedMutationsLocked, applyApprovedMutationsLockedFrom, type ApprovedMutationPorts, type NonPageMutationHandlers, type WriteOne,
} from "../../src/trust/executor.js";
import * as journal from "../../src/trust/journal.js";
import * as lifecycleApply from "../../src/trust/lifecycle-apply.js";
import * as pageApply from "../../src/trust/page-apply.js";
import type { PlannedMutation } from "../../src/trust/planner.js";
import * as relationApply from "../../src/trust/relation-apply.js";
import * as output from "../../src/utils/output.js";
import * as confine from "../../src/utils/path-confine.js";
import { tempRootTracker } from "../temp-roots.js";
import { MEM_ROOT, memoryReads as journalReads, memoryWrites, posix, put, shownKey, type MemoryMap } from "./journal-memory-map.js";
import { writeFiles } from "./copied-project.js";
import { diskTree, everyLeaf, expectBoundSilentThenFreshRoot, expectHoldsExactly, mintSeededBeforeAsk, sortedTree } from "./project-tree.js";
import { expectMintingDirectoryRemoved } from "./minted-directory.js";

const PREFIX = "executor-held-lock-binding-";
const page = (body: string): string => `---\ntitle: Ok\n---\n\n${body}\n`;
const [OLD, NEW, NEXT] = [page("old"), page("new"), page("next")];
const SEED = { "wiki/concepts/a.md": OLD, "wiki/concepts/gone.md": OLD };
const mutation = (operation: "create" | "update" | "delete", slug: string, body = NEW): PlannedMutation =>
  ({ kind: "page", operation, target: { directory: "concepts", slug }, body, provenance: { origin: "agent", decision: "allow", reviewRouted: false } });
/** Only the kind matters: these never reach a handler on the parity path. */
const relation = { kind: "relation" } as unknown as PlannedMutation;
const FAILING_PLAN = [mutation("update", "a", NEXT), mutation("create", "b")];
const BATCH = /journal\/[^/]+\.json$/u;

/** A tree entry as shown: a journal file by status and entries (target relative from `wiki/`), under a normalised name. */
function shownEntry([rel, text]: readonly [string, string]): [string, unknown] {
  if (!BATCH.test(rel)) return [rel, text];
  const batch = JSON.parse(text) as { status: string; entries: Array<{ targetPath: string; preState: unknown }> };
  const entries = batch.entries.map(({ targetPath, preState }) => [posix(targetPath).slice(posix(targetPath).lastIndexOf("wiki/")), preState]);
  return [rel.replace(BATCH, "journal/<batch>.json"), { status: batch.status, entries }];
}

/** One executor surface, root or bound, over one project. */
interface Side {
  apply(planned: PlannedMutation[], writeOne?: WriteOne): Promise<unknown>;
  failSecond(): WriteOne;
  tree(): Promise<Record<string, unknown>>;
}

/** A write that passes its first call to `base` and throws on its second. */
const failingSecond = (base: WriteOne): WriteOne => {
  let calls = 0;
  return async (filePath, content) => {
    calls += 1;
    if (calls === 2) throw new Error("injected write failure");
    return base(filePath, content);
  };
};

/** Apply all three operations; fail midway; refuse a mixed plan after replay; fail again; replay on an empty plan. */
async function runScenario(side: Side): Promise<string[]> {
  const out: string[] = [];
  const settle = async (name: string, planned: PlannedMutation[], writeOne?: WriteOne): Promise<void> => {
    const settled = await side.apply(planned, writeOne).then((value) => value, (error: Error) => `${error.name}: ${error.message}`);
    out.push(JSON.stringify({ name, settled, tree: await side.tree() }));
  };
  await settle("apply-all", [mutation("create", "new"), mutation("update", "a"), mutation("delete", "gone")]);
  await settle("fail-midway", FAILING_PLAN, side.failSecond());
  await settle("mixed-after-replay", [mutation("create", "c"), relation]);
  await settle("fail-again", FAILING_PLAN, side.failSecond());
  await settle("empty-after-replay", []);
  return out;
}

/** Every file under `root`, as shown, sorted. */
const shownTree = async (root: string): Promise<Record<string, unknown>> => Object.fromEntries(Object.entries(await diskTree(root, everyLeaf)).map(shownEntry));

const tracker = tempRootTracker();
const minted = mintSeededBeforeAsk(tracker, PREFIX, SEED, (root) => runScenario({
  apply: (planned, writeOne) => applyApprovedMutationsLocked(root, planned, writeOne === undefined ? {} : { writeOne }),
  failSecond: () => failingSecond(diskLeaves.writeLeafAtomicUnconfined),
  tree: () => shownTree(root),
}));

/** The copy, after requiring LITERALLY that it holds exactly the seed. */
function seededCopy(): Omit<MemoryMap, "log"> {
  expectHoldsExactly(minted.copy.files, SEED);
  return { files: new Map(minted.copy.files), dirs: new Set(minted.copy.listings.keys()) };
}

/**
 * The probes and reads over the map, every call logged: the shared journal reads,
 * with this suite's confinement that refuses an escaping target and its own
 * refusal of the byte read.
 */
function memoryReads(memory: MemoryMap): ReturnType<typeof journalReads> {
  return {
    ...journalReads(memory),
    confineTarget: async (target, root) => {
      memory.log.push(`confine ${posix(target)}`);
      const resolved = path.resolve(root, target);
      if (path.relative(root, resolved).startsWith("..")) throw new Error(`path escapes project root: ${target}`);
      return resolved;
    },
    readConfinedLeafBytes: async () => { throw new Error("readConfinedLeafBytes is not asked by the executor"); },
  };
}

/** Handlers that fail the case if the parity path ever dispatches to one. */
const unaskedHandlers: NonPageMutationHandlers = {
  relation: async () => { throw new Error("relation handler not asked"); },
  lifecycle: async () => { throw new Error("lifecycle handler not asked"); },
  artifact: async () => { throw new Error("artifact handler not asked"); },
};

/** The bound body over one memory map for journal AND page I/O, with a memory write and collected notes. */
function memorySide(log: string[], handlers: NonPageMutationHandlers = unaskedHandlers): Side & { notes: string[] } {
  const held = seededCopy();
  const memory: MemoryMap = { ...held, log };
  const io = { ...memoryReads(memory), ...memoryWrites(memory) };
  const write: WriteOne = async (filePath, content) => { log.push(`write ${shownKey(filePath)}`); put(memory, filePath, content); };
  const notes: string[] = [];
  const ports = (writeOne: WriteOne): ApprovedMutationPorts => ({ journal: io, page: io, writeOne, notes: (message) => { notes.push(message); }, handlers });
  return {
    notes,
    apply: (planned, writeOne) => applyApprovedMutationsLockedFrom(ports(writeOne ?? write), MEM_ROOT, planned),
    failSecond: () => failingSecond(write),
    tree: async () => Object.fromEntries(Object.entries(sortedTree(Object.fromEntries(held.files))).map(shownEntry)),
  };
}

/** Replay the scenario in memory, require the disk's outcomes and no notes, and index them by name. */
async function expectDiskParity(): Promise<Record<string, { settled: unknown; tree: Record<string, unknown> }>> {
  const side = memorySide([]);
  const outcomes = await runScenario(side);
  expect([outcomes, side.notes]).toEqual([minted.onDisk, []]);
  return Object.fromEntries(outcomes.map((line) => JSON.parse(line)).map((step) => [step.name, step]));
}

const PENDING = {
  ".llmwiki/journal/<batch>.json": { status: "pending", entries: [["wiki/concepts/a.md", { absent: false, content: NEW }], ["wiki/concepts/b.md", { absent: true }]] },
};
const APPLIED = { "wiki/concepts/a.md": NEW, "wiki/concepts/new.md": NEW };

describe("the held-lock executor over one copied project, with the minting directory gone", () => {
  it("E1 runs after the minting directory was removed, on a copy holding exactly the seed", () => {
    expectMintingDirectoryRemoved(minted.dir, PREFIX);
    seededCopy();
  });

  it("E2 creates, updates and deletes in one committed batch, leaving no journal file, as the disk did", async () => {
    const steps = await expectDiskParity();
    expect(steps["apply-all"]).toEqual({ name: "apply-all", settled: [{ kind: "page" }, { kind: "page" }, { kind: "page" }], tree: APPLIED });
  });

  it("E3 leaves a pending journal on a mid-batch failure, and the next call replays it BEFORE refusing a mixed plan or returning an empty one, as the disk did", async () => {
    const steps = await expectDiskParity();
    const failed = { ...APPLIED, "wiki/concepts/a.md": NEXT, ...PENDING };
    expect(["fail-midway", "mixed-after-replay", "fail-again", "empty-after-replay"].map((name) => [steps[name]!.settled, steps[name]!.tree])).toEqual([
      ["Error: injected write failure", failed],
      ["CrossStoreBatchUnsupportedError: cross-store-batch-unsupported: mixed-kind batch: page+relation", APPLIED],
      ["Error: injected write failure", failed],
      [[], APPLIED],
    ]);
  });

  it("E4 replays, opens, then per page confines, checks, records through the SAME journal I/O and writes, and commits once (memory only)", async () => {
    const log: string[] = [];
    await memorySide(log).apply([mutation("update", "a"), mutation("create", "c")]);
    const journalFile = ".llmwiki/journal/<batch>.json";
    expect(log).toEqual([
      "safe-realpath .llmwiki/journal", "confine .llmwiki/journal", `replace ${journalFile}`,
      "confine wiki/concepts/a.md", "read wiki/concepts/a.md", "realpath .", "read wiki/concepts/a.md", `replace ${journalFile}`, "write wiki/concepts/a.md",
      "confine wiki/concepts/c.md", "present wiki/concepts/c.md", "realpath .", "read wiki/concepts/c.md", `replace ${journalFile}`, "write wiki/concepts/c.md",
      `remove ${journalFile}`,
    ]);
  });

  it("E5 forwards each lone non-page shape to its handler AFTER replay and returns what it composed; refuses a multi-relation plan unhandled (memory only)", async () => {
    const log: string[] = [];
    const handlers: NonPageMutationHandlers = {
      relation: async (root, m) => { log.push(`relation ${root === MEM_ROOT} ${m === relation}`); return { ref: { id: "r1" } as never, decision: "allow" }; },
      lifecycle: async (root) => { log.push(`lifecycle ${root === MEM_ROOT}`); return "allow-with-warning"; },
      artifact: async (root) => { log.push(`artifact ${root === MEM_ROOT}`); return { ref: { id: "a1" } as never, decision: "stage-for-review" }; },
    };
    const side = memorySide(log, handlers);
    const settled = (planned: PlannedMutation[]): Promise<unknown> => side.apply(planned).catch((error: Error) => `${error.name}: ${error.message}`);
    expect(await settled([relation])).toEqual([{ kind: "relation", ref: { id: "r1" }, decision: "allow" }]);
    expect(await settled([{ kind: "lifecycle-transition" } as unknown as PlannedMutation])).toEqual([{ kind: "lifecycle-transition", decision: "allow-with-warning" }]);
    expect(await settled([{ kind: "artifact" } as unknown as PlannedMutation])).toEqual([{ kind: "artifact", ref: { id: "a1" }, decision: "stage-for-review" }]);
    expect(await settled([relation, relation])).toBe("CrossStoreBatchUnsupportedError: cross-store-batch-unsupported: multi-relation batch (no per-store batch semantics yet)");
    const replayed = "safe-realpath .llmwiki/journal";
    expect(log).toEqual([replayed, "relation true true", replayed, "lifecycle true", replayed, "artifact true", replayed]);
  });
});

describe("the bound executor route reaches no disk binding and no root journal or page wrapper", () => {
  /** Every incumbent the local ports reach, and every root wrapper the body must not call. */
  const spyAll = () => [
    vi.spyOn(diskLeaves, "replaceLeafAtomicWithin"), vi.spyOn(diskLeaves, "readConfinedLeafText"), vi.spyOn(diskLeaves, "removeLeaf"),
    vi.spyOn(diskLeaves, "leafPresent"), vi.spyOn(diskLeaves, "writeLeafAtomicUnconfined"), vi.spyOn(confine, "confineUnderRoot"),
    vi.spyOn(confine, "safeRealpath"), vi.spyOn(diskLocations, "locationRealPath"), vi.spyOn(journal, "openBatch"), vi.spyOn(journal, "recordPreState"),
    vi.spyOn(journal, "commitBatch"), vi.spyOn(journal, "replayJournal"), vi.spyOn(pageApply, "applyPageMutationLocked"),
    vi.spyOn(relationApply, "applyRelationLocked"), vi.spyOn(lifecycleApply, "applyLifecycleLocked"), vi.spyOn(artifactApply, "applyArtifactLocked"),
    vi.spyOn(output, "note"),
  ];

  it("E6 makes no ambient call in the bound body; the root form reaches the disk primitives through the bound bodies, never the root wrappers", async () => {
    const spies = spyAll();
    const root = await expectBoundSilentThenFreshRoot(spies, () => runScenario(memorySide([])), { tracker, prefix: PREFIX, seed: (at) => writeFiles(at, SEED) });
    expect(await executor.applyApprovedMutationsLocked(root, [mutation("update", "a"), mutation("create", "c")])).toEqual([{ kind: "page" }, { kind: "page" }]);
    expect(spies.map((spy) => spy.mock.calls.length > 0))
      .toEqual([true, true, true, true, true, true, true, true, false, false, false, false, false, false, false, false, false]);
  });
});
