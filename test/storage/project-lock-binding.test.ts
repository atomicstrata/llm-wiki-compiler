/**
 * @file test/storage/project-lock-binding.test.ts
 * @description The project lock, WHOLE, over raw I/O and a host held in memory:
 * `acquireLockFrom`, `acquireLockBlockingFrom` and `releaseLockFrom` resolve the
 * private directory through the private-dir bodies (`mkdir` on acquire, never on
 * release), publish through `publishLockRecordFrom` on the SAME I/O, read the
 * owner capped, treat an unreadable owner as stale, reclaim under the reclaim
 * lock (a stale reclaim lock is only CLEANED, and the second attempt converges),
 * release only their own PID, and settle the process-local queue permit on every
 * release exit. The bodies exist only after the lock was given bodies of its
 * own, so this file has NO before-edit run.
 *
 * HOW IT IS BUILT. One project is minted on real disk, once, and copied BEFORE
 * its disk ask (`mintCopiedBeforeAsk`); its one seed holds no `.llmwiki`. The
 * ask runs every step through the ROOT functions with the real host (this
 * process, its parent as the live foreign holder, pid 999999 as the dead one),
 * settling each once, with the private directory's tree (owners shown by role)
 * and the status lines it printed. The memory replay must equal the disk, and
 * both must equal the literals written here.
 *
 * WHAT IS MEMORY ONLY, AND NOT A REAL GUARD. The ordered call traces, the fake
 * clock and FIFO, and the injected faults (an escaping private directory, a
 * failing root realpath, a failing unlink). Real races, publication, private-dir
 * confinement, release confinement, the cross-alias FIFO and process identity
 * stay with `lock-publication-race`, `lock-publication-binding`,
 * `lock-private-dir-confine`, `lock-release-confined`, `lock-blocking-fifo`,
 * `lock-hardening` and `lock-pid-reuse`.
 */

import path from "node:path";
import { describe, expect, it, vi } from "bun:test";

import { fsTapper } from "./fs-taps.js";

/** `calls` are the tapped `fs` function names noted while `on`. */
const taps = { on: false, calls: [] as string[] };
/** The suite's `fs/promises` tapper: each tapped call's name is noted while `on`. */
const tapper = fsTapper({ note: (name) => { if (taps.on) taps.calls.push(name); } });
// Snapshot the real module before mock.module patches it in place for this file.
const realFsPromises = { ...(await import("node:fs/promises")) };
// Both spellings: `private-dir.ts` takes `mkdir` from the bare one and `lstat` from the `node:` one.
vi.mock("fs/promises", () => tapper(realFsPromises, ["mkdir", "lstat"]));
vi.mock("node:fs/promises", () => tapper(realFsPromises, ["mkdir", "lstat"]));

import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import * as diskLeaves from "../../src/storage/disk-guarded-leaves.js";
import * as diskLocations from "../../src/storage/disk-locations.js";
import * as privateLeaves from "../../src/storage/disk-private-leaves.js";
import { AtomicWriteCollisionError } from "../../src/utils/atomic-write-no-replace-durable.js";
import { MAX_LOCK_FILE_BYTES } from "../../src/utils/constants.js";
import * as fifo from "../../src/utils/keyed-fifo.js";
import {
  acquireLock, acquireLockBlocking, acquireLockBlockingFrom, acquireLockFrom, releaseLock, releaseLockFrom,
  type AcquireLockOptions, type BlockingLockOptions, type LockHost, type LockIo,
} from "../../src/utils/lock.js";
import * as lockOwner from "../../src/utils/lock-owner.js";
import * as publication from "../../src/utils/lock-publication.js";
import * as output from "../../src/utils/output.js";
import * as confine from "../../src/utils/path-confine.js";
import { tempRootTracker } from "../temp-roots.js";
import { mintCopiedBeforeAsk, writeFiles } from "./copied-project.js";
import { captureStatusLines, mintSingle, plain } from "./project-tree.js";
import { expectMintingDirectoryRemoved } from "./minted-directory.js";

const PREFIX = "project-lock-binding-";
const MEM_ROOT = path.resolve("/memory/project");
const SEED = { "README.md": "seed\n" };
/** The canonical dead holder of the lock suites. */
const DEAD_PID = 999999;
const MEM_SELF = 4242;
const MEM_FOREIGN = 4343;
type Planted = "<foreign>" | "<dead>" | "<oversize>";
const posix = (native: string): string => native.split(path.sep).join("/");

/** One lock surface, root or bound, over one project, with what it printed. */
interface Side {
  pids: { self: number; foreign: number };
  statuses: string[];
  acquire(options?: AcquireLockOptions): Promise<boolean>;
  blocking(options: BlockingLockOptions): Promise<void>;
  release(): Promise<void>;
  plant(owners: Record<string, Planted>): Promise<void>;
  drop(names: string[]): Promise<void>;
  tree(): Promise<Record<string, string> | null>;
}

/** A planted owner's text on a side: the live foreign holder, the dead one, or one byte over the cap. */
function plantedText(owner: Planted, foreign: number): string {
  if (owner === "<foreign>") return String(foreign);
  return owner === "<dead>" ? String(DEAD_PID) : "9".repeat(MAX_LOCK_FILE_BYTES + 1);
}

/** A lock leaf's text shown by role, so the disk's real pids and memory's fixed ones compare. */
function shownOwner(text: string, pids: Side["pids"]): string {
  if (text.length > MAX_LOCK_FILE_BYTES) return "<oversize>";
  const pid = lockOwner.parseOwner(text)?.pid;
  if (pid === pids.self) return "<self>";
  return pid === pids.foreign ? "<foreign>" : pid === DEAD_PID ? "<dead>" : text;
}

const sorted = (entries: Array<readonly [string, string]>): Record<string, string> =>
  Object.fromEntries([...entries].sort(([a], [b]) => a.localeCompare(b)));

type Step = readonly [name: string, act: (side: Side) => Promise<unknown>];
const FREE = { timeoutMs: 1_000, intervalMs: 1 };
const STEPS: readonly Step[] = [
  ["release-without-dir", (s) => s.release()], ["acquire-free", (s) => s.acquire()], ["acquire-held", (s) => s.acquire()],
  ["release-own", (s) => s.release()], ["acquire-foreign", async (s) => { await s.plant({ lock: "<foreign>" }); return s.acquire(); }],
  ["acquire-foreign-quiet", (s) => s.acquire({ quiet: true })], ["release-foreign", (s) => s.release()],
  ["reclaim-dead", async (s) => { await s.drop(["lock"]); await s.plant({ lock: "<dead>" }); return s.acquire(); }],
  ["release-reclaimed", (s) => s.release()],
  ["reclaim-past-stale-reclaim", async (s) => { await s.plant({ lock: "<dead>", "lock.reclaim": "<dead>" }); return s.acquire(); }],
  ["release-again", (s) => s.release()],
  ["reclaim-blocked", async (s) => { await s.plant({ lock: "<dead>", "lock.reclaim": "<foreign>" }); return s.acquire(); }],
  ["reclaim-unreadable", async (s) => { await s.drop(["lock", "lock.reclaim"]); await s.plant({ lock: "<oversize>" }); return s.acquire(); }],
  ["release-last", (s) => s.release()], ["blocking-free", (s) => s.blocking(FREE)], ["release-blocking", (s) => s.release()],
  ["blocking-after-release", (s) => s.blocking(FREE)], ["release-blocking-again", (s) => s.release()],
  ["blocking-busy", async (s) => { await s.plant({ lock: "<foreign>" }); return s.blocking({ timeoutMs: 20, intervalMs: 5 }); }],
  ["blocking-after-failure", async (s) => { await s.drop(["lock"]); return s.blocking(FREE); }], ["release-final", (s) => s.release()],
];

/** Every step, settled once: `true`/`false`, `ok`, or the error's name and message; then the tree and the drained statuses. */
async function runScenario(side: Side): Promise<string[]> {
  const out: string[] = [];
  for (const [name, act] of STEPS) {
    const settled = await act(side).then((value) => value ?? "ok", (error: Error) => `${error.name}: ${error.message}`);
    out.push(JSON.stringify({ name, settled, tree: await side.tree(), statuses: side.statuses.splice(0) }));
  }
  return out;
}

/** The root functions over a real project, with the real host. */
function diskSide(root: string, statuses: string[]): Side {
  const dir = path.join(root, ".llmwiki");
  const pids = { self: process.pid, foreign: process.ppid };
  const tree = async (): Promise<Record<string, string> | null> => {
    const names = await readdir(dir).catch(() => null);
    if (names === null) return null;
    return sorted(await Promise.all(names.map(async (name) => [name, shownOwner(await readFile(path.join(dir, name), "utf-8"), pids)] as const)));
  };
  return {
    pids, statuses, tree,
    acquire: (options) => acquireLock(root, options), blocking: (options) => acquireLockBlocking(root, options), release: () => releaseLock(root),
    plant: async (owners) => { for (const [name, owner] of Object.entries(owners)) await writeFile(path.join(dir, name), plantedText(owner, pids.foreign)); },
    drop: async (names) => { for (const name of names) await rm(path.join(dir, name)); },
  };
}

const tracker = tempRootTracker();
const minted = mintSingle<string[]>(tracker, () => mintCopiedBeforeAsk(tracker, PREFIX, (root) => writeFiles(root, SEED), async (root) => {
  const statuses: string[] = [];
  const status = captureStatusLines(statuses);
  try {
    return await runScenario(diskSide(root, statuses));
  } finally {
    status.mockRestore();
  }
}));

/** MEMORY faults with no disk twin — not real guards. */
interface Faults { escape?: boolean; realPathFails?: boolean; removeFails?: boolean }
const raw = (code: string): Error => Object.assign(new Error(`${code}: memory fault`), { code });

/** The memory project: held files and directories (POSIX keys under `MEM_ROOT`, the root as ""), from the seeded copy. */
interface Held { files: Map<string, string>; dirs: Set<string> }

/** The copy, after requiring LITERALLY that it holds exactly the seed and no private directory. */
function seededCopy(): Held {
  expect([[...minted.copy.files.keys()], [...minted.copy.files.values()], [...minted.copy.listings.keys()]])
    .toEqual([Object.keys(SEED), Object.values(SEED), [""]]);
  return { files: new Map(minted.copy.files), dirs: new Set(minted.copy.listings.keys()) };
}

const keyOf = (abs: string): string => posix(path.relative(MEM_ROOT, abs));
const shownKey = (abs: string): string => keyOf(abs) || ".";

/** The private-dir probes over memory, every call logged. */
function memoryDirIo(log: string[], held: Held, faults: Faults): Pick<LockIo, "confineTarget" | "makeDirectoryTree" | "safeRealPath" | "probeEntryNoFollow" | "realPath"> {
  const exists = (abs: string): boolean => held.dirs.has(keyOf(abs)) || held.files.has(keyOf(abs));
  return {
    confineTarget: async (target, root) => {
      log.push(`confine ${target}`);
      if (faults.escape) throw new Error(`path escapes project root: ${target}`);
      return path.resolve(root, target);
    },
    makeDirectoryTree: async (dir) => { log.push(`mkdir ${shownKey(dir)}`); held.dirs.add(keyOf(dir)); },
    // The memory store has no links, so a realpath is the location's normalized spelling.
    safeRealPath: async (location) => { log.push(`safe-realpath ${shownKey(location)}`); return exists(location) ? path.resolve(location) : null; },
    probeEntryNoFollow: async (location) => { log.push(`probe ${shownKey(location)}`); if (!exists(location)) throw raw("ENOENT"); },
    realPath: async (location) => {
      log.push(`realpath ${shownKey(location)}`);
      if (faults.realPathFails || !exists(location)) throw raw(faults.realPathFails ? "EIO" : "ENOENT");
      return path.resolve(location);
    },
  };
}

/** The leaf I/O over memory (publication's three members and the capped read), every call logged. */
function memoryLeafIo(log: string[], held: Held, faults: Faults): Omit<LockIo, keyof ReturnType<typeof memoryDirIo>> {
  return {
    readLeafCapped: async (leaf, maxBytes) => {
      log.push(`read ${keyOf(leaf)}`);
      const text = held.files.get(keyOf(leaf));
      if (text === undefined) return { kind: "absent" };
      return Buffer.byteLength(text) > maxBytes ? { kind: "unavailable" } : { kind: "ok", body: text };
    },
    createLeafExclusive: async (leaf, text) => {
      log.push(`create ${keyOf(leaf)}`);
      if (!held.dirs.has(path.posix.dirname(keyOf(leaf)))) throw raw("ENOENT");
      if (held.files.has(keyOf(leaf))) throw raw("EEXIST");
      held.files.set(keyOf(leaf), text);
    },
    linkLeafNoReplace: async (from, to) => {
      log.push(`link ${keyOf(from)} -> ${keyOf(to)}`);
      if (held.files.has(keyOf(to))) throw new AtomicWriteCollisionError();
      held.files.set(keyOf(to), held.files.get(keyOf(from))!);
    },
    removeLeaf: async (leaf) => {
      log.push(`remove ${keyOf(leaf)}`);
      if (faults.removeFails && !leaf.endsWith(".publishing")) throw raw("EIO");
      if (!held.files.delete(keyOf(leaf))) throw raw("ENOENT");
    },
  };
}

/** A host with fixed pids (memory's self and one live foreign holder), counting entropy, a fake clock and a one-holder FIFO. */
function memoryHost(log: string[], statuses: string[]): LockHost {
  const clock = { now: 0 };
  const queued = new Set<string>();
  const parked = new Map<string, () => void>();
  let drawn = 0;
  return {
    processId: () => MEM_SELF,
    serializeOwner: (pid) => { log.push(`serialize ${pid}`); return JSON.stringify({ pid }); },
    isOwnerProcessStale: (owner) => { log.push(`liveness ${owner.pid}`); return ![MEM_SELF, MEM_FOREIGN].includes(owner.pid); },
    entropy: (bytes) => { log.push(`entropy ${bytes}`); drawn += 1; return drawn.toString(16).padStart(bytes * 2, "0"); },
    now: () => clock.now,
    sleep: async (ms) => { log.push(`sleep ${ms}`); clock.now += ms; },
    admit: async (key, _timeoutMs, timeoutError) => {
      log.push(`admit ${key}`);
      if (queued.has(key)) throw timeoutError();
      queued.add(key);
      return () => { log.push(`dequeue ${key}`); queued.delete(key); };
    },
    park: (key, release) => { log.push(`park ${key}`); parked.set(key, release); },
    releaseParked: (key) => { log.push(`release-parked ${key}`); parked.get(key)?.(); parked.delete(key); },
    hasParked: () => parked.size > 0,
    status: (icon, message) => { statuses.push(`${icon} ${plain(message)}`); },
  };
}

/** The bound bodies over memory I/O and the memory host, on the seeded copy. */
function memorySide(log: string[], faults: Faults = {}, root = MEM_ROOT): Side {
  const held = seededCopy();
  const io: LockIo = { ...memoryDirIo(log, held, faults), ...memoryLeafIo(log, held, faults) };
  const statuses: string[] = [];
  const host = memoryHost(log, statuses);
  const pids = { self: MEM_SELF, foreign: MEM_FOREIGN };
  const tree = async (): Promise<Record<string, string> | null> => !held.dirs.has(".llmwiki") ? null
    : sorted([...held.files].filter(([rel]) => rel.startsWith(".llmwiki/")).map(([rel, text]) => [rel.slice(".llmwiki/".length), shownOwner(text, pids)] as const));
  return {
    pids, statuses, tree,
    acquire: (options) => acquireLockFrom(io, host, root, options),
    blocking: (options) => acquireLockBlockingFrom(io, host, root, options),
    release: () => releaseLockFrom(io, host, root),
    plant: async (owners) => { for (const [name, owner] of Object.entries(owners)) held.files.set(`.llmwiki/${name}`, plantedText(owner, MEM_FOREIGN)); },
    drop: async (names) => { for (const name of names) held.files.delete(`.llmwiki/${name}`); },
  };
}

/** Replay the scenario in memory, require the disk's outcomes, and index them by name. */
async function expectDiskParity(): Promise<Record<string, { settled: unknown; tree: unknown; statuses: string[] }>> {
  const outcomes = await runScenario(memorySide([]));
  expect(outcomes).toEqual(minted.onDisk);
  return Object.fromEntries(outcomes.map((line) => JSON.parse(line)).map((step) => [step.name, step]));
}

/** The named steps' `[settled, tree, statuses]`, in the order given. */
const pick = (steps: Awaited<ReturnType<typeof expectDiskParity>>, names: string[]): unknown[] =>
  names.map((name) => [steps[name]!.settled, steps[name]!.tree, steps[name]!.statuses]);

const BUSY = "! Another compilation is running.";
const RECLAIMED = "i Reclaimed stale lock from dead process.";
const SELF_HELD = { lock: "<self>" };

/** One publication of `rel` with the `n`th entropy draw: owner record, entropy, create, link, scratch removal (won or lost). */
const published = (rel: string, n: number): string[] => {
  const scratch = `${rel}.${n.toString(16).padStart(16, "0")}.publishing`;
  return [`serialize ${MEM_SELF}`, "entropy 8", `create ${scratch}`, `link ${scratch} -> ${rel}`, `remove ${scratch}`];
};
// The re-check compares against the root the confinement judged under (the confined dir's parent), so the root is not resolved again.
const RESOLVED = ["confine .llmwiki", "mkdir .llmwiki", "safe-realpath .llmwiki"];

describe("the project lock over a copied project, with the minting directory gone", () => {
  it("L1 runs after the minting directory was removed, on a copy holding exactly the seed and no private directory", () => {
    expectMintingDirectoryRemoved(minted.dir, PREFIX);
    seededCopy();
  });

  it("L2 releases without creating the directory, acquires, refuses a held lock (quietly when asked), and releases only its own pid, as the disk did", async () => {
    const steps = await expectDiskParity();
    const foreign = { lock: "<foreign>" };
    expect(pick(steps, ["release-without-dir", "acquire-free", "acquire-held", "release-own", "acquire-foreign", "acquire-foreign-quiet", "release-foreign"]))
      .toEqual([["ok", null, []], [true, SELF_HELD, []], [false, SELF_HELD, [BUSY]], ["ok", {}, []],
        [false, foreign, [BUSY]], [false, foreign, []], ["ok", foreign, []]]);
  });

  it("L3 reclaims a dead holder, converges past a stale reclaim lock, backs off a live reclaimer, and reclaims an unreadable owner, as the disk did", async () => {
    const steps = await expectDiskParity();
    expect(pick(steps, ["reclaim-dead", "release-reclaimed", "reclaim-past-stale-reclaim", "release-again", "reclaim-blocked", "reclaim-unreadable", "release-last"]))
      .toEqual([[true, SELF_HELD, [RECLAIMED]], ["ok", {}, []], [true, SELF_HELD, [RECLAIMED]], ["ok", {}, []],
        [false, { lock: "<dead>", "lock.reclaim": "<foreign>" }, ["! Could not acquire lock after retrying."]],
        [true, SELF_HELD, [RECLAIMED]], ["ok", {}, []]]);
  });

  it("L4 blocks to acquire, frees the queue on release and on a busy timeout, and times out quietly, as the disk did", async () => {
    const steps = await expectDiskParity();
    expect(pick(steps, ["blocking-free", "release-blocking", "blocking-after-release", "release-blocking-again", "blocking-busy", "blocking-after-failure", "release-final"]))
      .toEqual([["ok", SELF_HELD, []], ["ok", {}, []], ["ok", SELF_HELD, []], ["ok", {}, []],
        ["LockBusyError: relation store busy after 20ms", { lock: "<foreign>" }, []], ["ok", SELF_HELD, []], ["ok", {}, []]]);
  });

  it("L5 orders a fresh acquisition and a release with no directory: mkdir only on acquire, publication on the same I/O (memory only)", async () => {
    const acquired: string[] = [];
    await memorySide(acquired).acquire();
    expect(acquired).toEqual([...RESOLVED, ...published(".llmwiki/lock", 1)]);
    const released: string[] = [];
    await memorySide(released).release();
    // Nothing is parked, so release neither resolves a queue key nor releases a permit.
    expect(released).toEqual(["confine .llmwiki", "probe .llmwiki"]);
  });

  it("L6 cleans a stale reclaim lock WITHOUT re-acquiring it, then converges on the second attempt under reclaim ownership (memory only)", async () => {
    const log: string[] = [];
    const side = memorySide(log);
    await side.acquire();
    await side.release();
    await side.plant({ lock: "<dead>", "lock.reclaim": "<dead>" });
    log.length = 0;
    expect(await side.acquire()).toBe(true);
    const [lock, reclaim] = [".llmwiki/lock", ".llmwiki/lock.reclaim"];
    const staleLock = [`read ${lock}`, `liveness ${DEAD_PID}`];
    expect(log).toEqual([
      ...RESOLVED, ...published(lock, 2), ...staleLock, ...published(reclaim, 3), `read ${reclaim}`, `liveness ${DEAD_PID}`, `remove ${reclaim}`,
      ...published(lock, 4), ...staleLock, ...published(reclaim, 5), ...staleLock, `remove ${lock}`, ...published(lock, 6), `remove ${reclaim}`,
    ]);
  });

  it("L7 polls quietly on the host clock until the deadline, then frees the queue (memory only)", async () => {
    const log: string[] = [];
    const side = memorySide(log);
    await side.acquire();
    await side.plant({ lock: "<foreign>" });
    await side.release();
    log.length = 0;
    await expect(side.blocking({ timeoutMs: 10, intervalMs: 5 })).rejects.toThrow("relation store busy after 10ms");
    // Polls at t=0, 5 and 10; the third fails at the deadline, so only two sleeps.
    const poll = (n: number): string[] => [...RESOLVED, ...published(".llmwiki/lock", n), "read .llmwiki/lock", `liveness ${MEM_FOREIGN}`];
    expect(log).toEqual(["realpath .", `admit ${MEM_ROOT}`, ...poll(2), "sleep 5", ...poll(3), "sleep 5", ...poll(4), `dequeue ${MEM_ROOT}`]);
    expect(side.statuses).toEqual([]);
  });

  it("L8 refuses an escaping directory (warning unless quiet), keys the queue by the resolved spelling when realpath fails, and swallows a failed unlink (memory faults)", async () => {
    const escaping = memorySide([], { escape: true });
    expect([await escaping.acquire(), await escaping.acquire({ quiet: true }), await escaping.release(), escaping.statuses, await escaping.tree()])
      .toEqual([false, false, undefined, ["! Lock directory escapes project root — refusing to lock."], null]);
    const log: string[] = [];
    const unresolved = memorySide(log, { realPathFails: true }, `${MEM_ROOT}${path.sep}.`);
    await unresolved.blocking(FREE);
    await unresolved.release();
    expect(log.filter((call) => /^(admit|park|release-parked|dequeue) /u.test(call)))
      .toEqual([`admit ${MEM_ROOT}`, `park ${MEM_ROOT}`, `release-parked ${MEM_ROOT}`, `dequeue ${MEM_ROOT}`]);
    const stuck: string[] = [];
    const failing = memorySide(stuck, { removeFails: true });
    await failing.blocking(FREE);
    await expect(failing.release()).resolves.toBeUndefined();
    expect([stuck.slice(-3), await failing.tree()]).toEqual([[`remove .llmwiki/lock`, `release-parked ${MEM_ROOT}`, `dequeue ${MEM_ROOT}`], SELF_HELD]);
  });
});

describe("the bound lock route reaches no disk binding", () => {
  /** Every incumbent the disk I/O and the local host call, spied at the module seam. */
  const spyAll = () => [
    vi.spyOn(confine, "confineUnderRoot"), vi.spyOn(confine, "safeRealpath"), vi.spyOn(diskLocations, "locationRealPath"),
    vi.spyOn(privateLeaves, "readPrivateLeafText"), vi.spyOn(privateLeaves, "createPrivateLeafExclusive"),
    vi.spyOn(privateLeaves, "linkPrivateLeafNoReplace"), vi.spyOn(diskLeaves, "removeLeaf"), vi.spyOn(publication, "publishLockRecord"),
    vi.spyOn(lockOwner, "serializeOwner"), vi.spyOn(lockOwner, "isLockRecordStale"), vi.spyOn(fifo, "acquireKeyedFifo"),
    vi.spyOn(output, "status").mockImplementation(() => {}),
  ];

  it("L9 makes no ambient call in the bound bodies, while the root forms reach every primitive but the root publication", async () => {
    const spies = spyAll();
    taps.calls.length = 0;
    taps.on = true;
    await runScenario(memorySide([]));
    taps.on = false;
    expect([spies.map((spy) => spy.mock.calls.length), taps.calls]).toEqual([spies.map(() => 0), []]);
    const root = await tracker.create(PREFIX);
    taps.on = true;
    await acquireLockBlocking(root, FREE);
    expect(await acquireLock(root)).toBe(false);
    await releaseLock(root);
    taps.on = false;
    expect(spies.map((spy) => spy.mock.calls.length > 0)).toEqual([true, true, true, true, true, true, true, false, true, true, true, true]);
    expect([...new Set(taps.calls)].sort()).toEqual(["lstat", "mkdir"]);
  });
});
