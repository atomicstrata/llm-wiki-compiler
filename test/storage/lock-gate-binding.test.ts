/**
 * @file test/storage/lock-gate-binding.test.ts
 * @description The ORDINARY (non-destructive) gated acquisition, WHOLE:
 * `acquireMutationLockWith` / `acquireMutationLockBlockingWith` and the one gate
 * body `runRecoveryGateWith`, over the REAL lock bodies (`acquireLockFrom`,
 * `acquireLockBlockingFrom`, `releaseLockFrom`) and the REAL strict page-journal
 * recovery (`recoverJournalBeforeCompileFrom`), all over ONE in-memory project.
 * The bodies exist only after the gate was given bodies of its own, so this file
 * has NO before-edit run.
 *
 * WHAT IS FAKED, AND LABELLED. The four DOMAIN legs stay root-bound and are
 * recorded fakes here: the bundle-recovery detection, the portable pending block,
 * the preparation-lifecycle gate (which owns destructive authorization) and the
 * handoff settlement (which writes). This file proves nothing about them; the
 * incumbent `lock-gate`, `preparation-lifecycle-gate*`, `preparation-gate-*` and
 * `portable-pending-gate-binding` suites own them. The host behind the memory lock (pid, liveness,
 * clock, FIFO) is a test host, as in `project-lock-binding`.
 *
 * HOW IT IS BUILT. One project is minted on real disk, once, and copied BEFORE
 * its disk ask. The ask runs the ROOT `acquireMutationLock(root, "ordinary")` and
 * `releaseLock` through a clean acquisition, one that strictly replays a planted
 * pending journal, and one refused on a planted malformed journal, settling each
 * with its value or error and the pages, journal files and lock presence. On a
 * clean project the real legs all pass. The memory replay must equal the disk.
 */

import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "bun:test";
import * as capacity from "../../src/operation-bundles/capacity.js";
import {
  acquireMutationLock, acquireMutationLockBlockingWith, acquireMutationLockWith, PreparationLifecycleGateError, type RecoveryGateSteps,
} from "../../src/operation-bundles/lock-gate.js";
import * as pendingGate from "../../src/portable/host/pending-gate.js";
import * as recovery from "../../src/preparations/recovery.js";
import * as journalRecovery from "../../src/trust/journal-recovery.js";
import { recoverJournalBeforeCompileFrom } from "../../src/trust/journal-recovery.js";
import { AtomicWriteCollisionError } from "../../src/utils/atomic-write-no-replace-durable.js";
import * as legacyLayout from "../../src/utils/legacy-private-layout.js";
import * as lock from "../../src/utils/lock.js";
import { acquireLockBlockingFrom, acquireLockFrom, releaseLock, releaseLockFrom, type LockIo } from "../../src/utils/lock.js";
import { tempRootTracker } from "../temp-roots.js";
import { MEM_ROOT, keyOf, memoryHost, put, type Held } from "./compile-memory-steps.js";
import { enoent, writeFiles } from "./copied-project.js";
import { diskTree, expectBoundSilentThenFreshRoot, mintSeededBeforeAsk, sortedTree } from "./project-tree.js";
import { expectMintingDirectoryRemoved } from "./minted-directory.js";

const PREFIX = "lock-gate-binding-";
const J = ".llmwiki/journal";
const LOCK = ".llmwiki/lock";
const SEED = { "wiki/concepts/a.md": "changed\n" };
const PENDING = JSON.stringify({ batchId: "p1", status: "pending", entries: [{ targetPath: "wiki/concepts/a.md", preState: { absent: false, content: "original\n" } }] });
/** The lock leaf is shown by presence only (its owner record names a real pid on disk). */
const shownEntry = ([rel, text]: readonly [string, string]): [string, string] => [rel, rel === LOCK ? "<lock>" : text];
const shown = (rel: string): boolean => rel.startsWith("wiki/") || rel.startsWith(`${J}/`) || rel === LOCK;

/** One gate surface, root or bound, over one project. */
interface Side {
  acquire(): Promise<boolean>;
  release(): Promise<void>;
  plant(rel: string, text: string): Promise<void>;
  tree(): Promise<Record<string, string>>;
}

/** Acquire clean, release; plant a pending journal, acquire (replays), release; plant a malformed one, acquire (refused). */
async function runScenario(side: Side): Promise<string[]> {
  const out: string[] = [];
  const settle = async (name: string, act: () => Promise<unknown>): Promise<void> => {
    const settled = await act().then((value) => value ?? "ok", (error: Error) => `${error.name}: ${error.message}`);
    out.push(JSON.stringify({ name, settled, tree: await side.tree() }));
  };
  await settle("acquire-clean", () => side.acquire());
  await settle("release", () => side.release());
  await side.plant(`${J}/p1.json`, PENDING);
  await settle("acquire-replays", () => side.acquire());
  await settle("release-again", () => side.release());
  await side.plant(`${J}/bad.json`, "{ not json");
  await settle("acquire-unsafe", () => side.acquire());
  return out;
}

/** The shown files under `root`, sorted, the lock by presence only. */
const shownTree = async (root: string): Promise<Record<string, string>> =>
  Object.fromEntries(Object.entries(await diskTree(root, (rel, entry) => entry.isFile() && shown(rel))).map(shownEntry));

const tracker = tempRootTracker();
const minted = mintSeededBeforeAsk(tracker, PREFIX, SEED, (root) => runScenario({
  acquire: () => acquireMutationLock(root, "ordinary"),
  release: () => releaseLock(root),
  plant: async (rel, text) => { await mkdir(path.dirname(path.join(root, rel)), { recursive: true }); await writeFile(path.join(root, rel), text); },
  tree: () => shownTree(root),
}));

/** The copy, after requiring LITERALLY that it holds exactly the seed. */
function seededCopy(): Held {
  expect(Object.fromEntries(minted.copy.files)).toEqual(SEED);
  return { files: new Map(minted.copy.files), dirs: new Set(minted.copy.listings.keys()) };
}

/** Raw lock and journal-recovery I/O over the map (no links: a realpath is the normalised spelling). */
function memoryIo(held: Held): LockIo & Parameters<typeof recoverJournalBeforeCompileFrom>[0] {
  const exists = (abs: string): boolean => keyOf(abs) === "" || held.dirs.has(keyOf(abs)) || held.files.has(keyOf(abs));
  return {
    confineTarget: async (target, root) => path.resolve(root, target),
    makeDirectoryTree: async (dir) => { held.dirs.add(keyOf(dir)); },
    safeRealPath: async (location) => (exists(location) ? path.resolve(location) : null),
    probeEntryNoFollow: async (location) => { if (!exists(location)) throw enoent(); },
    realPath: async (location) => { if (!exists(location)) throw enoent(); return path.resolve(location); },
    readLeafCapped: async (leaf) => { const text = held.files.get(keyOf(leaf)); return text === undefined ? { kind: "absent" as const } : { kind: "ok" as const, body: text }; },
    createLeafExclusive: async (leaf, text) => { if (held.files.has(keyOf(leaf))) throw Object.assign(new Error("EEXIST"), { code: "EEXIST" }); put(held, keyOf(leaf), text); },
    linkLeafNoReplace: async (from, to) => { if (held.files.has(keyOf(to))) throw new AtomicWriteCollisionError(); put(held, keyOf(to), held.files.get(keyOf(from))!); },
    removeLeaf: async (leaf) => { if (!held.files.delete(keyOf(leaf))) throw enoent(); },
    replaceLeafContentWithin: async (_root, leaf, content) => { put(held, keyOf(leaf), String(content)); },
    readLeafTextNoFollow: async (leaf) => held.files.get(keyOf(leaf)) ?? null,
    listDirectoryNames: async (dir) => [...new Set([...held.files.keys()].filter((rel) => rel.startsWith(`${keyOf(dir)}/`)).map((rel) => rel.slice(keyOf(dir).length + 1).split("/")[0]!))],
  };
}

/** The four DOMAIN legs as recorded FAKES (root-bound in production), each passing unless told otherwise. */
type Legs = Pick<RecoveryGateSteps, "detectBundleRecovery" | "portableBlock" | "gateLifecycle" | "settleHandoffs">;
function fakeLegs(log: string[], overrides: Partial<Legs> = {}): Legs {
  return {
    detectBundleRecovery: async () => { log.push("bundle"); return null; },
    portableBlock: async () => { log.push("portable"); return null; },
    gateLifecycle: async (_root, intent) => { log.push(`lifecycle ${intent}`); return null; },
    settleHandoffs: async () => { log.push("settle"); },
    ...overrides,
  };
}

/** The steps over the memory project: the REAL lock and journal-recovery bodies, each logged, plus the fake legs. */
function memorySteps(held: Held, log: string[], legs: Legs): RecoveryGateSteps {
  const io = memoryIo(held);
  const host = memoryHost();
  return {
    acquireLock: (root, options) => { log.push("lock"); return acquireLockFrom(io, host, root, options); },
    acquireLockBlocking: (root, options) => { log.push("lock-blocking"); return acquireLockBlockingFrom(io, host, root, options); },
    releaseLock: (root) => { log.push("release"); return releaseLockFrom(io, host, root); },
    recoverJournal: (root) => { log.push("journal"); return recoverJournalBeforeCompileFrom(io, root); },
    ...legs,
  };
}

/** The bound side over a fresh seeded copy. */
function memorySide(log: string[] = [], overrides: Partial<Legs> = {}): Side & { held: Held; steps: RecoveryGateSteps } {
  const held = seededCopy();
  const steps = memorySteps(held, log, fakeLegs(log, overrides));
  return {
    held, steps,
    acquire: () => acquireMutationLockWith(steps, MEM_ROOT, "ordinary"),
    release: () => steps.releaseLock(MEM_ROOT),
    plant: async (rel, text) => { put(held, rel, text); },
    tree: async () => Object.fromEntries(Object.entries(sortedTree(Object.fromEntries([...held.files].filter(([rel]) => shown(rel))))).map(shownEntry)),
  };
}

describe("the ordinary gated acquisition over one copied project, with the minting directory gone", () => {
  it("G1 runs after the minting directory was removed, on a copy holding exactly the seed", () => {
    expectMintingDirectoryRemoved(minted.dir, PREFIX);
    seededCopy();
  });

  it("G2 acquires clean, strictly replays a pending journal before granting, and refuses a malformed one having released the lock, as the disk did", async () => {
    const outcomes = await runScenario(memorySide());
    expect(outcomes).toEqual(minted.onDisk);
    expect(outcomes.map((line) => JSON.parse(line))).toEqual([
      { name: "acquire-clean", settled: true, tree: { [LOCK]: "<lock>", "wiki/concepts/a.md": "changed\n" } },
      { name: "release", settled: "ok", tree: { "wiki/concepts/a.md": "changed\n" } },
      { name: "acquire-replays", settled: true, tree: { [LOCK]: "<lock>", "wiki/concepts/a.md": "original\n" } },
      { name: "release-again", settled: "ok", tree: { "wiki/concepts/a.md": "original\n" } },
      { name: "acquire-unsafe", settled: "JournalUnsafeError: journal recovery unsafe: pre-mutation journal recovery unsafe", tree: { [`${J}/bad.json`]: "{ not json", "wiki/concepts/a.md": "original\n" } },
    ]);
  });
});

describe("the gate's leg order, exemptions and refusals over recorded legs (memory only; the legs are FAKES)", () => {
  /** One fresh acquisition at `intent`: the calls made, the outcome, and whether the lock is still held. */
  const acquireAt = async (intent: Parameters<typeof acquireMutationLockWith>[2], overrides: Partial<Legs> = {}): Promise<unknown[]> => {
    const log: string[] = [];
    const side = memorySide(log, overrides);
    const settled = await acquireMutationLockWith(side.steps, MEM_ROOT, intent).then((value) => value, (error: Error) => `${error.name}: ${error.message}`);
    return [log, settled, side.held.files.has(LOCK)];
  };

  it("G3 orders lock, journal, bundle, portable, lifecycle, settlement; recovery bypasses every leg, portable skips its own block, handoff skips settlement", async () => {
    const all = ["lock", "journal", "bundle", "portable"];
    expect([await acquireAt("ordinary"), await acquireAt("reset"), await acquireAt("recovery"), await acquireAt("portable"), await acquireAt("handoff")]).toEqual([
      [[...all, "lifecycle ordinary", "settle"], true, true], [[...all, "lifecycle reset", "settle"], true, true], [["lock"], true, true],
      [["lock", "journal", "bundle", "lifecycle portable", "settle"], true, true], [[...all, "lifecycle handoff"], true, true],
    ]);
  });

  it("G4 releases the lock before rethrowing each refusal, stops before settlement, and lets a failing release replace the refusal", async () => {
    const refusals = [
      await acquireAt("ordinary", { detectBundleRecovery: async () => "bundle-recovery-blocking" }),
      await acquireAt("ordinary", { portableBlock: async () => "unresolved-intent" }),
      await acquireAt("ordinary", { gateLifecycle: async () => { throw new PreparationLifecycleGateError("lifecycle pending"); } }),
    ];
    expect(refusals.map(([log, settled, held]) => [(log as string[]).at(-1), String(settled).split(":")[0], held])).toEqual([
      ["release", "RecoveryGateError", false], ["release", "PortableRecoveryBlockingError", false], ["release", "PreparationLifecycleGateError", false],
    ]);
    const log: string[] = [];
    const side = memorySide(log, { gateLifecycle: async () => { throw new PreparationLifecycleGateError("lifecycle pending"); } });
    const steps: RecoveryGateSteps = { ...side.steps, releaseLock: async () => { throw new Error("release failed"); } };
    await expect(acquireMutationLockWith(steps, MEM_ROOT, "ordinary")).rejects.toThrow("release failed");
  });

  it("G5 returns false on a busy lock and throws the busy timeout from the blocking form, before any leg", async () => {
    const log: string[] = [];
    const side = memorySide(log);
    put(side.held, LOCK, JSON.stringify({ pid: 4343 }));
    expect(await acquireMutationLockWith(side.steps, MEM_ROOT, "ordinary")).toBe(false);
    await expect(acquireMutationLockBlockingWith(side.steps, MEM_ROOT, "ordinary", { timeoutMs: 10, intervalMs: 5 })).rejects.toThrow("relation store busy after 10ms");
    expect(log).toEqual(["lock", "lock-blocking"]);
  });
});

describe("the bound acquisition reaches no root lock, recovery or leg", () => {
  it("G6 makes no root call in the bound route, while the root acquisition reaches each one", async () => {
    const spies = [
      vi.spyOn(lock, "acquireLock"), vi.spyOn(lock, "releaseLock"), vi.spyOn(journalRecovery, "recoverJournalBeforeCompile"),
      vi.spyOn(capacity, "scanOperationInventory"), vi.spyOn(pendingGate, "portableGateBlock"),
      vi.spyOn(legacyLayout, "legacyPrivateAliasHasNoEntries"), vi.spyOn(recovery, "settlePreparationHandoffsLocked"),
    ];
    const root = await expectBoundSilentThenFreshRoot(spies, () => runScenario(memorySide()), { tracker, prefix: PREFIX, seed: (at) => writeFiles(at, SEED) });
    expect(await acquireMutationLock(root, "ordinary")).toBe(true);
    await releaseLock(root);
    expect(spies.map((spy) => spy.mock.calls.length > 0)).toEqual(spies.map(() => true));
  });
});
