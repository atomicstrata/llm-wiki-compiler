/**
 * @file test/storage/lock-publication-binding.test.ts
 * @description Lock-record PUBLICATION, WHOLE, over raw I/O and a host entropy
 * port held in memory: `publishLockRecordFrom` names a scratch leaf from fresh
 * entropy, creates it exclusively with the COMPLETE record OUTSIDE the try,
 * awaits the hook, links it onto the lock name without replacing, answers `false`
 * ONLY for `AtomicWriteCollisionError`, propagates every other failure, and
 * removes its scratch alias best-effort on every outcome after a successful
 * create. The body exists only after publication was given a body of its own,
 * so this file has NO before-edit run.
 *
 * HOW IT IS BUILT. One project is minted on real disk, once, and copied BEFORE
 * its disk ask (`mintCopiedBeforeAsk`); its one seed is text. The ask runs every
 * step through the ROOT `publishLockRecord` with real entropy, settling each once:
 * `true`/`false` or the error's name and code, and the private directory's tree
 * (scratch names shown as `.<entropy>.publishing`). The memory replay must equal
 * the disk, and both must equal the literals written here. The default mode is
 * DISK ONLY: the memory store has no modes.
 *
 * WHAT IS MEMORY ONLY, AND NOT A REAL GUARD. The call order and the injected
 * faults (a create that fails after writing, a raw link failure, a failing
 * removal, an error merely NAMED like a collision). Real races, links and the
 * close fault on disk stay with `lock-publication-race` and `lock-leaves`.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "bun:test";
import * as diskLeaves from "../../src/storage/disk-guarded-leaves.js";
import * as privateLeaves from "../../src/storage/disk-private-leaves.js";
import { AtomicWriteCollisionError } from "../../src/utils/atomic-write-no-replace-durable.js";
import {
  publishLockRecord, publishLockRecordFrom, type LockPublicationHooks, type LockPublicationIo, type ScratchEntropy,
} from "../../src/utils/lock-publication.js";
import { tempRootTracker } from "../temp-roots.js";
import { mintCopiedBeforeAsk, writeFiles } from "./copied-project.js";
import { mintSingle } from "./project-tree.js";
import { expectMintingDirectoryRemoved } from "./minted-directory.js";

const PREFIX = "lock-publication-binding-";
const MEM_ROOT = path.resolve("/memory/project");
const SEED = { ".llmwiki/locked.lock": "OTHER\n" };
const record = (n: number): string => `{"pid":${n},"started":"fixed"}\n`;
const SCRATCH = /\.[0-9a-f]{16}\.publishing$/;
const shownName = (name: string): string => name.replace(SCRATCH, ".<entropy>.publishing");
const posix = (native: string): string => native.split(path.sep).join("/");
/** Leaf names (scratch shown generically) to text, sorted by the SHOWN name on both sides. */
const shownTree = (entries: Array<readonly [string, string]>): Record<string, string> =>
  Object.fromEntries(entries.map(([name, text]) => [shownName(name), text] as const).sort(([a], [b]) => a.localeCompare(b)));

/** One publication surface, root or bound, over project-relative POSIX lock paths. */
interface Side {
  publish(rel: string, ownerRecord: string, hooks?: LockPublicationHooks): Promise<boolean>;
  tree(): Promise<Record<string, string>>;
}

/** `true`/`false`, or the error's name and code (its message when it has no code). */
function settledOf(act: Promise<boolean>): Promise<unknown> {
  return act.then((won) => won, (error: NodeJS.ErrnoException) => `${error.name}: ${error.code ?? error.message}`);
}

/** Free, taken, taken again, a hook that looks, a hook that throws, a missing parent; each settled once. */
async function runScenario(side: Side): Promise<string[]> {
  const out: string[] = [];
  const settle = async (name: string, act: () => Promise<boolean>): Promise<void> => {
    out.push(JSON.stringify({ name, settled: await settledOf(act()), tree: await side.tree() }));
  };
  await settle("publish-free", () => side.publish(".llmwiki/free.lock", record(1)));
  await settle("publish-taken", () => side.publish(".llmwiki/locked.lock", record(2)));
  await settle("publish-again", () => side.publish(".llmwiki/free.lock", record(3)));
  const atHook: { tree?: Record<string, string> } = {};
  await settle("publish-hooked", () => side.publish(".llmwiki/hooked.lock", record(4), { beforePublish: async () => { atHook.tree = await side.tree(); } }));
  out.push(JSON.stringify({ name: "at-hook", tree: atHook.tree }));
  await settle("hook-throws", () => side.publish(".llmwiki/thrown.lock", record(5), { beforePublish: async () => { throw new Error("hook refused"); } }));
  await settle("missing-parent", () => side.publish("missing/x.lock", record(6)));
  return out;
}

/** The private directory on disk: names (scratch shown generically) to text, sorted. */
async function diskTree(root: string): Promise<Record<string, string>> {
  const dir = path.join(root, ".llmwiki");
  const names = await readdir(dir);
  return shownTree(await Promise.all(names.map(async (name) => [name, await readFile(path.join(dir, name), "utf-8")] as const)));
}

const tracker = tempRootTracker();
const minted = mintSingle<{ steps: string[]; defaultMode: boolean }>(tracker, () => mintCopiedBeforeAsk(tracker, PREFIX, (root) => writeFiles(root, SEED), async (root) => {
  const steps = await runScenario({ publish: (rel, text, hooks) => publishLockRecord(path.join(root, rel), text, hooks), tree: () => diskTree(root) });
  const mode = (await stat(path.join(root, ".llmwiki/free.lock"))).mode & 0o777;
  return { steps, defaultMode: mode === (0o666 & ~process.umask()) };
}));

/** The copy, after requiring LITERALLY that it holds exactly the seed. */
function seededCopy(): Map<string, string> {
  expect([[...minted.copy.files.keys()], [...minted.copy.files.values()]]).toEqual([Object.keys(SEED), Object.values(SEED)]);
  return new Map(minted.copy.files);
}

/** MEMORY faults with no disk twin — not real guards. */
interface Faults { closeFailsAfterWrite?: boolean; linkFails?: boolean; removeFails?: boolean; namedCollision?: boolean }
const raw = (code: string): Error => Object.assign(new Error(`${code}: memory fault`), { code });

/** Raw publication I/O over one map (POSIX keys under `MEM_ROOT`), every call logged. */
function memoryIo(log: string[], held: Map<string, string>, faults: Faults): LockPublicationIo {
  const key = (abs: string): string => posix(path.relative(MEM_ROOT, abs));
  const parentExists = (k: string): boolean => [...held.keys()].some((rel) => rel.startsWith(`${path.posix.dirname(k)}/`));
  return {
    createLeafExclusive: async (leaf, text) => {
      log.push(`create ${key(leaf)}`);
      if (!parentExists(key(leaf))) throw raw("ENOENT");
      if (held.has(key(leaf))) throw raw("EEXIST");
      held.set(key(leaf), text);
      if (faults.closeFailsAfterWrite) throw raw("EIO");
    },
    linkLeafNoReplace: async (from, to) => {
      log.push(`link ${key(from)} -> ${key(to)}`);
      if (faults.linkFails) throw raw("EIO");
      if (faults.namedCollision) throw Object.assign(new Error("atomic no-replace destination already exists"), { name: "AtomicWriteCollisionError" });
      if (held.has(key(to))) throw new AtomicWriteCollisionError();
      held.set(key(to), held.get(key(from))!);
    },
    removeLeaf: async (leaf) => {
      log.push(`remove ${key(leaf)}`);
      if (faults.removeFails) throw raw("EIO");
      if (!held.delete(key(leaf))) throw raw("ENOENT");
    },
  };
}

/** The bound body over memory I/O and a counting entropy port, on the seeded copy. */
function memorySide(log: string[], faults: Faults = {}): Side & { held: Map<string, string> } {
  const held = seededCopy();
  const io = memoryIo(log, held, faults);
  let drawn = 0;
  const entropy: ScratchEntropy = (bytes) => { log.push(`entropy ${bytes}`); drawn += 1; return drawn.toString(16).padStart(bytes * 2, "0"); };
  const tree = async (): Promise<Record<string, string>> =>
    shownTree([...held].filter(([rel]) => rel.startsWith(".llmwiki/")).map(([rel, text]) => [rel.slice(".llmwiki/".length), text] as const));
  return { held, tree, publish: (rel, text, hooks) => publishLockRecordFrom(io, entropy, path.join(MEM_ROOT, rel), text, hooks) };
}

/** Replay the scenario in memory, require the disk's outcomes, and index them by name. */
async function expectDiskParity(): Promise<Record<string, { settled?: unknown; tree: Record<string, string> }>> {
  const outcomes = await runScenario(memorySide([]));
  expect(outcomes).toEqual(minted.onDisk.steps);
  return Object.fromEntries(outcomes.map((line) => JSON.parse(line)).map((step) => [step.name, step]));
}

describe("lock publication over a copied project, with the minting directory gone", () => {
  it("P1 runs after the minting directory was removed, on a copy holding exactly the seed", () => {
    expectMintingDirectoryRemoved(minted.dir, PREFIX);
    seededCopy();
  });

  it("P2 publishes a complete record create-only, answers false for a taken name without touching it, leaves no scratch, and uses the default mode (disk), as the disk did", async () => {
    const steps = await expectDiskParity();
    const published = { "free.lock": record(1), "locked.lock": "OTHER\n" };
    expect(["publish-free", "publish-taken", "publish-again"].map((name) => steps[name])).toEqual([
      { name: "publish-free", settled: true, tree: published }, { name: "publish-taken", settled: false, tree: published },
      { name: "publish-again", settled: false, tree: published },
    ]);
    expect(minted.onDisk.defaultMode).toBe(true);
  });

  it("P3 holds the complete scratch record unpublished at the hook, propagates a hook failure and a failed create, as the disk did", async () => {
    const steps = await expectDiskParity();
    const before = { "free.lock": record(1), "locked.lock": "OTHER\n" };
    expect(steps["at-hook"]!.tree).toEqual({ ...before, "hooked.lock.<entropy>.publishing": record(4) });
    const after = { ...before, "hooked.lock": record(4) };
    expect(["publish-hooked", "hook-throws", "missing-parent"].map((name) => [steps[name]!.settled, steps[name]!.tree]))
      .toEqual([[true, after], ["Error: hook refused", after], ["Error: ENOENT", after]]);
  });

  it("P4 draws entropy, creates, waits on the hook, links, then removes the alias; a failed create removes nothing (memory only)", async () => {
    const traces: string[][] = [];
    for (const [rel, faults] of [[".llmwiki/a.lock", {}], [".llmwiki/locked.lock", {}], ["missing/b.lock", {}]] as const) {
      const log: string[] = [];
      await memorySide(log, faults).publish(rel, record(7), { beforePublish: async () => { log.push("hook"); } }).catch(() => undefined);
      traces.push(log);
    }
    const scratch = (rel: string): string => `${rel}.0000000000000001.publishing`;
    expect(traces).toEqual([
      ["entropy 8", `create ${scratch(".llmwiki/a.lock")}`, "hook", `link ${scratch(".llmwiki/a.lock")} -> .llmwiki/a.lock`, `remove ${scratch(".llmwiki/a.lock")}`],
      ["entropy 8", `create ${scratch(".llmwiki/locked.lock")}`, "hook", `link ${scratch(".llmwiki/locked.lock")} -> .llmwiki/locked.lock`, `remove ${scratch(".llmwiki/locked.lock")}`],
      ["entropy 8", `create ${scratch("missing/b.lock")}`],
    ]);
  });

  it("P5 leaves a create that failed after writing, cleans up after a raw link failure, swallows a failed removal, and trusts only the collision CLASS (memory faults)", async () => {
    const outcome = async (faults: Faults): Promise<unknown[]> => {
      const side = memorySide([], faults);
      return [await settledOf(side.publish(".llmwiki/c.lock", record(8))), Object.keys(await side.tree()).sort()];
    };
    expect([await outcome({ closeFailsAfterWrite: true }), await outcome({ linkFails: true }), await outcome({ removeFails: true }), await outcome({ namedCollision: true })])
      .toEqual([
        ["Error: EIO", ["c.lock.<entropy>.publishing", "locked.lock"]], ["Error: EIO", ["locked.lock"]],
        [true, ["c.lock", "c.lock.<entropy>.publishing", "locked.lock"]], ["AtomicWriteCollisionError: atomic no-replace destination already exists", ["locked.lock"]],
      ]);
  });

  it("P6 makes no ambient disk call in the bound body, while the root form reaches every primitive", async () => {
    const spies = [vi.spyOn(privateLeaves, "createPrivateLeafExclusive"), vi.spyOn(privateLeaves, "linkPrivateLeafNoReplace"), vi.spyOn(diskLeaves, "removeLeaf")];
    await runScenario(memorySide([]));
    expect(spies.map((spy) => spy.mock.calls.length)).toEqual([0, 0, 0]);
    const root = await tracker.create(PREFIX);
    await writeFiles(root, SEED);
    expect(await publishLockRecord(path.join(root, ".llmwiki/control.lock"), record(9))).toBe(true);
    expect(spies.map((spy) => spy.mock.calls.length > 0)).toEqual([true, true, true]);
  });
});
