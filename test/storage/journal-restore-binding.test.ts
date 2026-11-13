/**
 * @file test/storage/journal-restore-binding.test.ts
 * @description The journal's RESTORATION and trust reads, WHOLE, over raw I/O
 * held in memory: `classifyJournalDirFrom` (a null realpath is `absent`, an
 * escaping one `escape`), `loadBatchFrom` (a no-follow read; null on refusal or
 * bad parse; the caller's root replaces the file's), `targetConfinedUnderRootFrom`
 * and `allTargetsConfinedFrom` (either root spelling; false on any failure;
 * sequential, stopping at the first escape), `confinedUnlinkFrom` (re-confine
 * OUTSIDE the try, then EVERY removal error swallowed) and `revertEntryFrom`
 * (re-confine BEFORE decoding, refuse non-canonical base64, restore text or
 * bytes against the real root). The bodies exist only after the restoration
 * was given bodies of its own, so this file has NO before-edit run.
 *
 * HOW IT IS BUILT. One project is minted on real disk, once. Its text seeds,
 * including two journal files, are copied BEFORE the disk ask
 * (`mintCopiedBeforeAsk`) and seed the memory side after a literal guard. The
 * copy holds UTF-8 text, so the one binary seed is read back as raw bytes INSIDE
 * the seed callback — before the copy and the ask — and that retained snapshot,
 * guarded literally, seeds the memory side. The ask runs the whole scenario
 * through the ROOT forms, settling each step once: `ok`, the value, or the
 * error, and the restorable tree's bytes as base64. Values are normalised
 * structurally (the directory relative to the real root; a batch's root shown
 * as `<root>` only when it IS the caller's root), and messages have only the
 * JSON-escaped root replaced. The memory replay must equal the disk, and both
 * must equal the literals written here.
 *
 * WHAT IS MEMORY ONLY, AND NOT A REAL GUARD. The operation order and the
 * injected faults (a failing removal, a rejecting raw realpath, a null
 * `safeRealPath`, an escaping journal directory, a refused no-follow read) are
 * memory doubles. Real links, the parent-swap race, the no-follow refusal, the
 * symlinked journal and quarantine directories, and replay stay with the
 * incumbent suites. The memory store models one root alias (`MEM_ROOT` →
 * `MEM_REAL`); canonical aliasing on disk is exercised only implicitly. No
 * Windows run is claimed.
 */

import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "bun:test";
import * as diskLeaves from "../../src/storage/disk-guarded-leaves.js";
import * as diskLocations from "../../src/storage/disk-locations.js";
import {
  allTargetsConfined, allTargetsConfinedFrom, classifyJournalDir, classifyJournalDirFrom, confinedUnlink, confinedUnlinkFrom,
  loadBatch, loadBatchFrom, revertEntry, revertEntryFrom, targetConfinedUnderRoot, targetConfinedUnderRootFrom,
  type JournalBatch, type JournalDirState, type JournalEntry, type JournalRestoreIo,
} from "../../src/trust/journal.js";
import * as confine from "../../src/utils/path-confine.js";
import { tempRootTracker } from "../temp-roots.js";
import { mintCopiedBeforeAsk, mintOnceThenRemove, writeFiles, type Minted } from "./copied-project.js";
import { expectMintingDirectoryRemoved } from "./minted-directory.js";
import { diskLeaves as readDiskLeaves } from "./project-tree.js";
import { aliasShown as shown, confinedUnder, MEM_REAL, MEM_ROOT, posix, realKey as key, rootShown, target, toReal } from "./journal-paths.js";

const PREFIX = "journal-restore-binding-";
/** The binary target's CURRENT bytes: not valid UTF-8; base64 `gIE=`. */
const POST_BLOB = Uint8Array.from([0x80, 0x81]);
const B1 = {
  batchId: "b1", root: "/elsewhere", status: "pending",
  entries: [
    { targetPath: "wiki/concepts/a.md", preState: { absent: false, content: "alpha\n" } },
    { targetPath: "raw/blob.bin", preState: { absent: false, content: "//4AgMM=", encoding: "base64" } },
    { targetPath: "wiki/concepts/new.md", preState: { absent: true } },
  ],
};
const SEED_TEXT: Record<string, string> = {
  ".llmwiki/journal/b1.json": JSON.stringify(B1), ".llmwiki/journal/bad.json": "{ not json",
  "wiki/concepts/a.md": "changed\n", "wiki/concepts/keep.md": "keep\n", "wiki/concepts/new.md": "created\n",
};
const BEFORE = { "raw/blob.bin": "gIE=", "wiki/concepts/a.md": "Y2hhbmdlZAo=", "wiki/concepts/keep.md": "a2VlcAo=", "wiki/concepts/new.md": "Y3JlYXRlZAo=" };
const AFTER = { "raw/blob.bin": "//4AgMM=", "wiki/concepts/a.md": "YWxwaGEK", "wiki/concepts/keep.md": "a2VlcAo=" };
const TAMPERED: JournalEntry["preState"] = { absent: false, content: "AB==", encoding: "base64" };

const absentAt = (targetPath: string): JournalEntry => ({ targetPath, preState: { absent: true } });

/** One restoration surface, root or bound. `base` is the root as given; `real` its realpath. */
interface Side {
  base: string; real: string;
  classify(): Promise<JournalDirState>;
  load(batchId: string): Promise<JournalBatch | null>;
  allConfined(batch: JournalBatch): Promise<boolean>;
  confined(targetPath: string): Promise<boolean>;
  revert(entry: JournalEntry): Promise<void>;
  unlink(targetPath: string): Promise<void>;
  tree(): Promise<Record<string, string>>;
}
interface Step { name: string; settled: unknown; tree: Record<string, string> }

/** A settled value with roots normalised STRUCTURALLY, or the error with only its JSON-escaped root replaced. */
function settledOf(side: Side, act: Promise<unknown>): Promise<unknown> {
  const shown = (value: unknown): unknown => {
    if (value === undefined) return "ok";
    const state = value as JournalDirState & JournalBatch;
    if (state !== null && typeof state === "object" && state.kind === "ok") return { kind: "ok", dir: posix(path.relative(side.real, state.dir)) };
    if (state !== null && typeof state === "object" && "batchId" in state) return { ...state, root: state.root === side.base ? "<root>" : state.root };
    return value;
  };
  return act.then(shown, (error: Error) => `${error.name}: ${rootShown(error.message, side.base)}`);
}

/** Classify, load, check confinement, restore every loaded entry, unlink again, and refuse a tampered entry. */
async function runScenario(side: Side): Promise<string[]> {
  const out: string[] = [];
  const at = (...parts: string[]): string => path.join(side.base, ...parts);
  const settle = async (name: string, act: () => Promise<unknown>): Promise<void> => {
    out.push(JSON.stringify({ name, settled: await settledOf(side, act()), tree: await side.tree() }));
  };
  const held: { batch?: JournalBatch } = {};
  await settle("classify", () => side.classify());
  await settle("load-missing", () => side.load("missing"));
  await settle("load-bad", () => side.load("bad"));
  await settle("load-b1", async () => (held.batch = (await side.load("b1")) ?? undefined));
  await settle("all-confined", () => side.allConfined(held.batch!));
  await settle("confined-given-root", () => side.confined(at("wiki", "concepts", "a.md")));
  await settle("confined-real-root", () => side.confined(path.join(side.real, "wiki", "concepts", "a.md")));
  await settle("confined-escape", () => side.confined(at("..", "outside.md")));
  const escapeFirst = { ...held.batch!, root: side.base, entries: [absentAt(at("..", "outside.md")), held.batch!.entries[0]!] };
  await settle("all-confined-escape-first", () => side.allConfined(escapeFirst));
  for (const entry of held.batch!.entries) await settle(`revert ${entry.targetPath}`, () => side.revert(entry));
  await settle("unlink-absent", () => side.unlink(at("wiki", "concepts", "new.md")));
  await settle("revert-tampered", () => side.revert({ targetPath: at("wiki", "concepts", "keep.md"), preState: TAMPERED }));
  return out;
}

/** The restorable tree on disk (`wiki/`, `raw/`), as base64 bytes, keys sorted. */
const diskTree = (root: string, rel: string): Promise<Record<string, string>> => readDiskLeaves(root, { rel, show: (bytes) => bytes.toString("base64") });

/** The ROOT forms on a real project at `root`. */
async function diskSide(root: string): Promise<Side> {
  return {
    base: root, real: await realpath(root),
    classify: () => classifyJournalDir(root),
    load: (batchId) => loadBatch(root, batchId),
    allConfined: (batch) => allTargetsConfined(batch),
    confined: (targetPath) => targetConfinedUnderRoot(targetPath, root),
    revert: (entry) => revertEntry(entry, root),
    unlink: (targetPath) => confinedUnlink(targetPath, root),
    tree: async () => Object.fromEntries(Object.entries({ ...(await diskTree(root, "raw")), ...(await diskTree(root, "wiki")) }).sort(([a], [b]) => a.localeCompare(b))),
  };
}

const tracker = tempRootTracker();
let minted: Minted<string[]>;
/** The binary seed's raw bytes, read back inside the seed callback: before the copy and before the ask. */
let seededBlob: Buffer;
mintOnceThenRemove(tracker, async () => {
  const seed = async (root: string): Promise<void> => {
    await writeFiles(root, SEED_TEXT);
    await mkdir(path.join(root, "raw"));
    await writeFile(path.join(root, "raw/blob.bin"), POST_BLOB);
    seededBlob = await readFile(path.join(root, "raw/blob.bin"));
  };
  minted = await mintCopiedBeforeAsk(tracker, PREFIX, seed, async (root) => runScenario(await diskSide(root)));
});

/** The memory seed: the copied text and the retained binary snapshot, each after a LITERAL guard. */
function seededBytes(): Map<string, Buffer> {
  expect([...minted.copy.files.keys()].sort()).toEqual([...Object.keys(SEED_TEXT), "raw/blob.bin"].sort());
  expect([Object.keys(SEED_TEXT).map((rel) => minted.copy.files.get(rel)), seededBlob.toString("base64")]).toEqual([Object.values(SEED_TEXT), "gIE="]);
  const held = new Map(Object.keys(SEED_TEXT).map((rel) => [rel, Buffer.from(minted.copy.files.get(rel)!, "utf-8")] as const));
  return held.set("raw/blob.bin", Buffer.from(seededBlob));
}

/** MEMORY faults with no disk twin — not real guards. */
interface Faults { remove?: Error; realPathRejects?: boolean; safeNull?: boolean; escapeDir?: boolean; noFollowNull?: boolean }

/** Raw restoration I/O over one map (POSIX keys under the real root `MEM_REAL`, aliased by `MEM_ROOT`), every call logged. */
function memoryIo(log: string[], held: Map<string, Buffer>, faults: Faults): JournalRestoreIo {
  const exists = (k: string): boolean => k === "" || [...held.keys()].some((rel) => rel === k || rel.startsWith(`${k}/`));
  return {
    confineTarget: async (targetPath, root) => {
      log.push(`confine ${shown(targetPath)}`);
      return confinedUnder(toReal(root), targetPath, shown);
    },
    realPath: async (location) => {
      log.push(`realpath ${shown(location)}`);
      if (faults.realPathRejects) throw Object.assign(new Error("ENOENT: realpath refused"), { code: "ENOENT" });
      return toReal(location);
    },
    safeRealPath: async (location) => {
      log.push(`safe-realpath ${shown(location)}`);
      if (faults.safeNull || !exists(key(location))) return null;
      return faults.escapeDir && key(location) === ".llmwiki/journal" ? path.resolve("/memory/outside/journal") : toReal(location);
    },
    removeLeaf: async (leaf) => {
      log.push(`remove ${shown(leaf)}`);
      if (faults.remove) throw faults.remove;
      if (!held.delete(key(leaf))) throw Object.assign(new Error("ENOENT: not held"), { code: "ENOENT" });
    },
    replaceLeafContentWithin: async (confineRoot, leaf, content) => {
      log.push(`replace ${shown(leaf)} within ${shown(confineRoot)}`);
      held.set(key(leaf), typeof content === "string" ? Buffer.from(content, "utf-8") : Buffer.from(content));
    },
    readLeafTextNoFollow: async (leaf) => {
      log.push(`read-nofollow ${shown(leaf)}`);
      return faults.noFollowNull ? null : held.get(key(leaf))?.toString("utf-8") ?? null;
    },
  };
}

/** The restorable part of the memory store (`wiki/`, `raw/`), as base64 bytes, keys sorted. */
function memoryTree(held: Map<string, Buffer>): Record<string, string> {
  const restorable = [...held].filter(([rel]) => rel.startsWith("wiki/") || rel.startsWith("raw/"));
  return Object.fromEntries(restorable.sort(([a], [b]) => a.localeCompare(b)).map(([rel, bytes]) => [rel, bytes.toString("base64")]));
}

/** The bound bodies over {@link memoryIo}, on the seeded copy. */
function memorySide(log: string[], faults: Faults = {}): Side {
  const held = seededBytes();
  const io = memoryIo(log, held, faults);
  return {
    base: MEM_ROOT, real: MEM_REAL,
    classify: () => classifyJournalDirFrom(io, MEM_ROOT),
    load: (batchId) => loadBatchFrom(io, MEM_ROOT, batchId),
    allConfined: (batch) => allTargetsConfinedFrom(io, batch),
    confined: (targetPath) => targetConfinedUnderRootFrom(io, targetPath, MEM_ROOT),
    revert: (entry) => revertEntryFrom(io, entry, MEM_ROOT),
    unlink: (targetPath) => confinedUnlinkFrom(io, targetPath, MEM_ROOT),
    tree: async () => memoryTree(held),
  };
}

/** Replay the scenario in memory, require the disk's outcomes, and index the steps by name. */
async function expectDiskParity(): Promise<Record<string, Step>> {
  const outcomes = await runScenario(memorySide([]));
  expect(outcomes).toEqual(minted.onDisk);
  return Object.fromEntries(outcomes.map((outcome) => JSON.parse(outcome) as Step).map((step) => [step.name, step]));
}

describe("the journal restoration over a copied project, with the minting directory gone", () => {
  it("R1 runs after the minting directory was removed, on the copied text seed and the retained before-copy binary snapshot", () => {
    expectMintingDirectoryRemoved(minted.dir, PREFIX);
    seededBytes();
  });

  it("R2 classifies, loads, and restores text, non-UTF-8 bytes and an absent target, as the disk did", async () => {
    const steps = await expectDiskParity();
    expect([steps["classify"], steps["all-confined"]!.settled]).toEqual([{ name: "classify", settled: { kind: "ok", dir: ".llmwiki/journal" }, tree: BEFORE }, true]);
    expect(steps["revert wiki/concepts/a.md"]!.tree).toEqual({ ...BEFORE, "wiki/concepts/a.md": "YWxwaGEK" });
    expect(steps["revert raw/blob.bin"]!.tree).toEqual({ ...BEFORE, "wiki/concepts/a.md": "YWxwaGEK", "raw/blob.bin": "//4AgMM=" });
    expect([steps["revert wiki/concepts/new.md"], steps["unlink-absent"]]).toEqual([
      { name: "revert wiki/concepts/new.md", settled: "ok", tree: AFTER }, { name: "unlink-absent", settled: "ok", tree: AFTER },
    ]);
  });

  it("R3 loads null for a missing or malformed journal, and replaces the file's own root with the caller's, as the disk did", async () => {
    const steps = await expectDiskParity();
    expect([steps["load-missing"]!.settled, steps["load-bad"]!.settled]).toEqual([null, null]);
    expect(steps["load-b1"]!.settled).toEqual({ ...B1, root: "<root>" });
  });

  it("R4 confines a target under either root spelling, refuses an escape, and fails a batch whose first target escapes, as the disk did", async () => {
    const steps = await expectDiskParity();
    const settled = ["confined-given-root", "confined-real-root", "confined-escape", "all-confined-escape-first"].map((name) => steps[name]!.settled);
    expect(settled).toEqual([true, true, false, false]);
  });

  it("R5 refuses a non-canonical base64 entry without overwriting its target, as the disk did", async () => {
    const steps = await expectDiskParity();
    const message = `JournalPreStateUnreadableError: journal pre-state for "${target("wiki", "concepts", "keep.md")}" is unreadable (symlinked leaf or parent, non-regular, raced, or over 16777216 bytes) — refusing the mutation`;
    expect(steps["revert-tampered"]).toEqual({ name: "revert-tampered", settled: message, tree: AFTER });
  });

  it("R6 re-confines before acting or decoding, stops at the first escape, and classifies with the nullable realpath only (memory only)", async () => {
    const log: string[] = [];
    const side = memorySide(log);
    const traces: string[][] = [];
    const take = (): void => { traces.push(log.splice(0)); };
    await side.revert({ targetPath: path.join(MEM_ROOT, "wiki", "concepts", "a.md"), preState: { absent: false, content: "alpha\n" } }); take();
    await side.revert({ targetPath: path.join(MEM_ROOT, "wiki", "concepts", "keep.md"), preState: TAMPERED }).catch(() => undefined); take();
    await side.unlink(path.join(MEM_ROOT, "wiki", "concepts", "new.md")); take();
    await side.allConfined({ batchId: "x", root: MEM_ROOT, status: "pending", entries: [absentAt(path.join(MEM_ROOT, "..", "outside.md")), absentAt(path.join(MEM_ROOT, "a.md"))] }); take();
    await side.classify(); take();
    await side.load("b1"); take();
    expect(traces).toEqual([
      ["realpath <root>", "confine wiki/concepts/a.md", "safe-realpath <root>", "replace <real>/wiki/concepts/a.md within <real>"],
      ["realpath <root>", "confine wiki/concepts/keep.md"],
      ["realpath <root>", "confine wiki/concepts/new.md", "remove <real>/wiki/concepts/new.md"],
      ["realpath <root>", "confine /memory/outside.md"],
      ["safe-realpath <root>/.llmwiki/journal", "safe-realpath <root>"],
      ["read-nofollow <root>/.llmwiki/journal/b1.json"],
    ]);
  });

  it("R7 keeps the inherited answers under memory faults: removal errors swallowed, confinement failures propagated, null realpath read as absent (memory only)", async () => {
    const shownOf = (side: Side, act: Promise<unknown>): Promise<unknown> => settledOf(side, act);
    const eacces = memorySide([], { remove: Object.assign(new Error("EACCES: remove refused"), { code: "EACCES" }) });
    const log: string[] = [];
    const escaping = memorySide(log);
    const rawRejects = memorySide([], { realPathRejects: true });
    const outcomes = [
      await shownOf(eacces, eacces.unlink(path.join(MEM_ROOT, "wiki", "concepts", "a.md"))),
      await shownOf(escaping, escaping.unlink(path.join(MEM_ROOT, "..", "outside.md"))),
      await rawRejects.confined(path.join(MEM_ROOT, "wiki", "concepts", "a.md")),
      await shownOf(rawRejects, rawRejects.classify()),
      await memorySide([], { safeNull: true }).classify(),
      await memorySide([], { escapeDir: true }).classify(),
      await memorySide([], { noFollowNull: true }).load("b1"),
    ];
    expect(outcomes).toEqual(["ok", "Error: escapes: /memory/outside.md", true, { kind: "ok", dir: ".llmwiki/journal" }, { kind: "absent" }, { kind: "escape" }, null]);
    expect(log.some((call) => call.startsWith("remove"))).toBe(false);
  });

  it("R8 makes no ambient disk call in the bound bodies, while the root forms still reach every disk primitive", async () => {
    const spies = [vi.spyOn(confine, "confineUnderRoot"), vi.spyOn(diskLocations, "locationRealPath"), vi.spyOn(confine, "safeRealpath"),
      vi.spyOn(diskLeaves, "removeLeaf"), vi.spyOn(diskLeaves, "replaceLeafAtomicWithin"), vi.spyOn(diskLeaves, "readLeafTextNoFollow")];
    await runScenario(memorySide([]));
    expect(spies.map((spy) => spy.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0]);
    const root = await tracker.create(PREFIX);
    await writeFiles(root, { ".llmwiki/journal/none.txt": "", "a.md": "x" });
    await classifyJournalDir(root);
    await loadBatch(root, "none");
    await targetConfinedUnderRoot(path.join(root, "a.md"), root);
    await revertEntry({ targetPath: path.join(root, "a.md"), preState: { absent: false, content: "y" } }, root);
    await confinedUnlink(path.join(root, "a.md"), root);
    expect(spies.map((spy) => spy.mock.calls.length > 0)).toEqual([true, true, true, true, true, true]);
  });
});
