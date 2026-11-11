/**
 * @file test/storage/journal-replay-binding.test.ts
 * @description The journal's best-effort REPLAY, its quarantine, the STRICT
 * pre-compile recovery and the classifier's read sources, WHOLE, over raw I/O
 * held in memory: `replayJournalFrom` (escape → note; any listing failure →
 * nothing pending; store order; malformed or escaping batch quarantined, or
 * removed in place with the inherited "removed" note; committed untouched;
 * pending reverted entry by entry, then its journal removed),
 * `recoverJournalBeforeCompileFrom` (absent → clean, escape → unsafe, a
 * listing failure propagates, only `JournalUnsafeError` → unsafe, legacy
 * committed pruned, classify-then-load-again with NO recheck), and
 * `journalReadSourcesFrom` (no I/O to build; the RESOLVED directory listed,
 * each batch read by the root AS WRITTEN). These bodies exist only after they
 * were given bodies of their own, so this file has NO before-edit run.
 *
 * HOW IT IS BUILT. Three projects are minted on real disk, once each, and
 * copied BEFORE their disk ask (`mintCopiedBeforeAsk`): A for classification
 * and replay (pending, committed, malformed and escaping batches, plus a
 * non-journal file), B for strict recovery that replays, C for strict recovery
 * that refuses. Every seed is text, so no binary snapshot is needed. Each ask
 * runs the ROOT forms (`diskJournalReadSources`, `replayJournal` twice,
 * `recoverJournalBeforeCompile` twice), with the incumbent `note` captured, and
 * settles each step once: the value or error, the notes (sorted, since the
 * disk's listing order is the platform's), and the whole tree. Only the real
 * root is replaced in notes. The memory replay must equal the disk, and both
 * must equal the literals written here.
 *
 * WHAT IS MEMORY ONLY, AND NOT A REAL GUARD. The call order (including listing
 * order kept unsorted) and every injected fault are memory doubles. Real links,
 * races, the no-follow refusal and the symlinked journal and quarantine
 * directories stay with the incumbent suites. Paths in traces are POSIX; no
 * Windows run is claimed.
 */

import { realpath } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "bun:test";
import * as diskLeaves from "../../src/storage/disk-guarded-leaves.js";
import * as diskLocations from "../../src/storage/disk-locations.js";
import { replayJournal, replayJournalFrom, type JournalReplayIo } from "../../src/trust/journal.js";
import {
  classifyJournalFileFrom, diskJournalReadSources, journalReadSourcesFrom, listBatchIdsFrom, type JournalReadSources,
} from "../../src/trust/journal-classify.js";
import { recoverJournalBeforeCompile, recoverJournalBeforeCompileFrom } from "../../src/trust/journal-recovery.js";
import * as output from "../../src/utils/output.js";
import * as confine from "../../src/utils/path-confine.js";
import { tempRootTracker } from "../temp-roots.js";
import { mintCopiedBeforeAsk, mintOnceThenRemove, writeFiles, type Minted } from "./copied-project.js";
import { diskTree, everyLeaf, sortedTree } from "./project-tree.js";
import { expectMintingDirectoryRemoved } from "./minted-directory.js";
import { aliasShown as shown, confinedUnder, MEM_REAL, MEM_ROOT, realKey as key, toReal } from "./journal-paths.js";

const PREFIX = "journal-replay-binding-";
const J = ".llmwiki/journal";
const BAD = "{ not json";
const P1 = JSON.stringify({ batchId: "p1", status: "pending", entries: [
  { targetPath: "wiki/concepts/a.md", preState: { absent: false, content: "alpha\n" } }, { targetPath: "wiki/concepts/new.md", preState: { absent: true } }] });
const C1 = JSON.stringify({ batchId: "c1", status: "committed", entries: [] });
const ESC = JSON.stringify({ batchId: "esc", status: "pending", entries: [{ targetPath: "../outside.md", preState: { absent: true } }] });
const P2 = JSON.stringify({ batchId: "p2", status: "pending", entries: [{ targetPath: "wiki/concepts/b.md", preState: { absent: false, content: "beta\n" } }] });
const C2 = JSON.stringify({ batchId: "c2", status: "committed", entries: [] });
const SEED_A: Record<string, string> = {
  [`${J}/bad.json`]: BAD, [`${J}/c1.json`]: C1, [`${J}/esc.json`]: ESC, [`${J}/notes.txt`]: "keep\n", [`${J}/p1.json`]: P1,
  "wiki/concepts/a.md": "changed\n", "wiki/concepts/new.md": "created\n",
};
const SEED_B: Record<string, string> = { [`${J}/c2.json`]: C2, [`${J}/p2.json`]: P2, "wiki/concepts/b.md": "changed\n" };
const SEED_C: Record<string, string> = { [`${J}/bad.json`]: BAD, "wiki/concepts/c.md": "keep\n" };
const REPLAYED_A = {
  [`${J}/c1.json`]: C1, [`${J}/notes.txt`]: "keep\n", [`${J}/quarantine/bad.json`]: BAD, [`${J}/quarantine/esc.json`]: ESC, "wiki/concepts/a.md": "alpha\n",
};
const quarantined = (id: string): string => `⚠ Untrusted journal ${id}.json quarantined to ${path.join("<real>", ".llmwiki", "journal", "quarantine", `${id}.json`)} — not replayed.`;
const removedInPlace = (id: string): string => `⚠ Untrusted journal ${id}.json could not be safely quarantined — removed.`;
const ESCAPE_NOTE = "⚠ Journal directory escapes project root — refusing to replay (tampering).";

/** One journal surface, root or bound. `real` is the root's realpath; `notes` collects diagnostics. */
interface Side {
  real: string; notes: string[];
  replay(): Promise<void>;
  recover(): Promise<{ status: string }>;
  sources(): JournalReadSources;
  tree(): Promise<Record<string, string>>;
}

/** Open the sources once and classify every listed batch (ids sorted for comparison only). */
async function classified(side: Side): Promise<unknown> {
  const opened = await side.sources().openJournal();
  if (opened.kind !== "ok") return opened;
  const ids = (await listBatchIdsFrom(opened.journal)).sort();
  return { kind: "ok", classes: Object.fromEntries(await Promise.all(ids.map(async (id) => [id, await classifyJournalFileFrom(opened.journal, id)]))) };
}

/** Settle one act once: its value or error, the notes it produced (real root shown, sorted), and the tree. */
async function step(side: Side, act: () => Promise<unknown>): Promise<string> {
  const before = side.notes.length;
  const settled = await act().then((value) => value ?? "ok", (error: Error) => `${error.name}: ${error.message}`);
  const notes = side.notes.slice(before).map((line) => line.split(side.real).join("<real>")).sort();
  return JSON.stringify({ settled, notes, tree: await side.tree() });
}

/** Project A: classify, then replay twice. Projects B and C: strict recovery twice. */
const scenarioA = async (side: Side): Promise<string[]> => [await step(side, () => classified(side)), await step(side, () => side.replay()), await step(side, () => side.replay())];
const scenarioRecover = async (side: Side): Promise<string[]> => [await step(side, () => side.recover()), await step(side, () => side.recover())];

/** The ROOT forms on a real project, with the incumbent `note` captured into `notes`. */
async function diskSide(root: string): Promise<Side> {
  const notes: string[] = [];
  vi.spyOn(output, "note").mockImplementation((message: string) => { notes.push(message); });
  return {
    real: await realpath(root), notes,
    replay: () => replayJournal(root), recover: () => recoverJournalBeforeCompile(root),
    sources: () => diskJournalReadSources(root), tree: () => diskTree(root, everyLeaf),
  };
}

const tracker = tempRootTracker();
const minted: Record<"A" | "B" | "C", Minted<string[]>> = {} as never;
mintOnceThenRemove(tracker, async () => {
  const mint = async (seed: Record<string, string>, run: (side: Side) => Promise<string[]>): Promise<Minted<string[]>> => {
    const done = await mintCopiedBeforeAsk(tracker, PREFIX, (root) => writeFiles(root, seed), async (root) => run(await diskSide(root)));
    vi.restoreAllMocks();
    return done;
  };
  minted.A = await mint(SEED_A, scenarioA);
  minted.B = await mint(SEED_B, scenarioRecover);
  minted.C = await mint(SEED_C, scenarioRecover);
});

/** The copy of one project, as bytes, after requiring LITERALLY that it holds exactly its seed. */
function seeded(project: "A" | "B" | "C"): Map<string, Buffer> {
  const seed = { A: SEED_A, B: SEED_B, C: SEED_C }[project];
  const copy = minted[project].copy.files;
  expect([[...copy.keys()].sort(), Object.keys(seed).map((rel) => copy.get(rel))]).toEqual([Object.keys(seed).sort(), Object.values(seed)]);
  return new Map([...copy].map(([rel, text]) => [rel, Buffer.from(text, "utf-8")] as const));
}

/** MEMORY faults with no disk twin — not real guards. */
interface Faults {
  listRejects?: boolean; reverseListing?: boolean; escapeDir?: boolean; refuseConfine?: string; refuseRemove?: string; replaceRejects?: boolean;
  secondRead?: "vanish" | "committed";
}
const exists = (held: Map<string, Buffer>, k: string): boolean => k === "" || [...held.keys()].some((rel) => rel === k || rel.startsWith(`${k}/`));
const refused = (what: string): Error => Object.assign(new Error(`EIO: ${what} refused`), { code: "EIO" });
const enoent = (): Error => Object.assign(new Error("ENOENT: not held"), { code: "ENOENT" });

/** Confinement, both realpaths and the no-follow read over the map (alias `MEM_ROOT` → `MEM_REAL`), every call logged. */
function memoryReads(log: string[], held: Map<string, Buffer>, faults: Faults): Pick<JournalReplayIo, "confineTarget" | "realPath" | "safeRealPath" | "readLeafTextNoFollow"> {
  const reads = new Map<string, number>();
  return {
    confineTarget: async (targetPath, root) => {
      log.push(`confine ${shown(targetPath)}`);
      if (faults.refuseConfine && shown(targetPath).includes(faults.refuseConfine)) throw new Error(`refused: ${shown(targetPath)}`);
      return confinedUnder(toReal(root), targetPath, shown);
    },
    realPath: async (location) => { log.push(`realpath ${shown(location)}`); return toReal(location); },
    safeRealPath: async (location) => {
      log.push(`safe-realpath ${shown(location)}`);
      if (!exists(held, key(location))) return null;
      return faults.escapeDir && key(location) === J ? path.resolve("/memory/outside/journal") : toReal(location);
    },
    readLeafTextNoFollow: async (leaf) => {
      log.push(`read-nofollow ${shown(leaf)}`);
      const count = (reads.get(leaf) ?? 0) + 1;
      reads.set(leaf, count);
      const text = held.get(key(leaf))?.toString("utf-8") ?? null;
      if (count < 2 || text === null || faults.secondRead === undefined) return text;
      return faults.secondRead === "vanish" ? null : text.replace('"pending"', '"committed"');
    },
  };
}

/** Listing, removal, restore and the two moves over the map, every call logged. */
function memoryWrites(log: string[], held: Map<string, Buffer>, faults: Faults): Omit<JournalReplayIo, keyof ReturnType<typeof memoryReads>> {
  return {
    listDirectoryNames: async (dir) => {
      if (faults.listRejects) { log.push(`list ${shown(dir)} -> EIO`); throw refused("list"); }
      const prefix = `${key(dir)}/`;
      const stored = [...new Set([...held.keys()].filter((rel) => rel.startsWith(prefix)).map((rel) => rel.slice(prefix.length).split("/")[0]!))];
      const names = faults.reverseListing ? stored.reverse() : stored;
      log.push(`list ${shown(dir)} -> ${names.join(",")}`); // the order actually RETURNED
      return names;
    },
    removeLeaf: async (leaf) => {
      log.push(`remove ${shown(leaf)}`);
      if (faults.refuseRemove && shown(leaf).includes(faults.refuseRemove)) throw refused("remove");
      if (!held.delete(key(leaf))) throw enoent();
    },
    replaceLeafContentWithin: async (confineRoot, leaf, content) => {
      log.push(`replace ${shown(leaf)} within ${shown(confineRoot)}`);
      if (faults.replaceRejects) throw refused("replace");
      held.set(key(leaf), typeof content === "string" ? Buffer.from(content, "utf-8") : Buffer.from(content));
    },
    makeDirectoryTree: async (dir) => { log.push(`mkdir ${shown(dir)}`); },
    renameLeafUnguarded: async (from, to) => {
      log.push(`rename ${shown(from)} -> ${shown(to)}`);
      const bytes = held.get(key(from));
      if (bytes === undefined) throw enoent();
      held.delete(key(from));
      held.set(key(to), bytes);
    },
  };
}

/** The bound bodies over the memory I/O, on one project's seeded copy. */
function memorySide(project: "A" | "B" | "C", log: string[], faults: Faults = {}): Side {
  const held = seeded(project);
  const io: JournalReplayIo = { ...memoryReads(log, held, faults), ...memoryWrites(log, held, faults) };
  const notes: string[] = [];
  return {
    real: MEM_REAL, notes,
    replay: () => replayJournalFrom(io, (message) => { notes.push(message); }, MEM_ROOT),
    recover: () => recoverJournalBeforeCompileFrom(io, MEM_ROOT),
    sources: () => journalReadSourcesFrom(io, MEM_ROOT),
    tree: async () => sortedTree(Object.fromEntries([...held].map(([rel, bytes]) => [rel, bytes.toString("utf-8")]))),
  };
}

/** Replay a project's scenario in memory, require the disk's outcomes, and parse them. */
async function expectDiskParity(project: "A" | "B" | "C"): Promise<Array<{ settled: unknown; notes: string[]; tree: Record<string, string> }>> {
  const outcomes = await (project === "A" ? scenarioA : scenarioRecover)(memorySide(project, []));
  expect(outcomes).toEqual(minted[project].onDisk);
  return outcomes.map((outcome) => JSON.parse(outcome));
}

describe("journal replay, strict recovery and classifier sources over copied projects, minting directories gone", () => {
  it("W1 runs after every minting directory was removed, on copies holding exactly their seeds", () => {
    for (const project of ["A", "B", "C"] as const) { expectMintingDirectoryRemoved(minted[project].dir, PREFIX); seeded(project); }
  });

  it("W2 classifies every listed batch through the opened sources, as the disk did", async () => {
    const [classes] = await expectDiskParity("A");
    expect(classes).toEqual({ settled: { kind: "ok", classes: { bad: "unsafe", c1: "legacy-committed", esc: "unsafe", p1: "pending-revertable" } }, notes: [], tree: SEED_A });
  });

  it("W3 replays: quarantines malformed and escaping batches, leaves committed, reverts pending, and is idempotent, as the disk did", async () => {
    const [, first, second] = await expectDiskParity("A");
    expect(first).toEqual({ settled: "ok", notes: [quarantined("bad"), quarantined("esc")], tree: REPLAYED_A });
    expect(second).toEqual({ settled: "ok", notes: [], tree: REPLAYED_A });
  });

  it("W4 strict recovery replays then is clean, and refuses a malformed batch untouched, as the disk did", async () => {
    const [replayed, clean] = await expectDiskParity("B");
    expect([replayed, clean]).toEqual([
      { settled: { status: "replayed" }, notes: [], tree: { "wiki/concepts/b.md": "beta\n" } }, { settled: { status: "clean" }, notes: [], tree: { "wiki/concepts/b.md": "beta\n" } },
    ]);
    const [refusedC, again] = await expectDiskParity("C");
    expect([refusedC, again]).toEqual([{ settled: { status: "unsafe" }, notes: [], tree: SEED_C }, { settled: { status: "unsafe" }, notes: [], tree: SEED_C }]);
  });

  it("W5 keeps the store's listing order, confines before moving, reverts before removing, and builds sources with no I/O (memory only)", async () => {
    const log: string[] = [];
    await memorySide("A", log, { reverseListing: true }).replay();
    const listed = log[2]!.split(" -> ")[1]!.split(",");
    expect(listed).not.toEqual([...listed].sort()); // a store order that is NOT lexicographic, so a `.sort()` in replay would fail below
    expect(log.slice(0, 2)).toEqual([`safe-realpath <root>/${J}`, "safe-realpath <root>"]);
    expect(log.filter((call) => call.startsWith("read-nofollow"))).toEqual(listed.filter((name) => name.endsWith(".json")).map((name) => `read-nofollow <root>/${J}/${name}`));
    const after = (name: string, count: number): string[] => log.slice(log.indexOf(`read-nofollow <root>/${J}/${name}`) + 1).slice(0, count);
    expect(after("bad.json", 4)).toEqual(["realpath <root>", `confine ${J}/quarantine/bad.json`, `mkdir <real>/${J}/quarantine`, `rename <root>/${J}/bad.json -> <real>/${J}/quarantine/bad.json`]);
    expect(after("p1.json", 8)).toEqual(["confine wiki/concepts/a.md", "confine wiki/concepts/new.md", "confine wiki/concepts/a.md", "safe-realpath <root>",
      "replace <real>/wiki/concepts/a.md within <real>", "confine wiki/concepts/new.md", "remove <real>/wiki/concepts/new.md", `remove <root>/${J}/p1.json`]);
    const sourcesLog: string[] = [];
    const sources = memorySide("A", sourcesLog).sources();
    expect(sourcesLog).toEqual([]);
    const opened = await sources.openJournal();
    if (opened.kind === "ok") { await opened.journal.listNames(); await opened.journal.readBatchText("p1"); }
    expect(sourcesLog.map((call) => call.split(" -> ")[0])).toEqual([`safe-realpath <root>/${J}`, "safe-realpath <root>", `list <real>/${J}`, `read-nofollow <root>/${J}/p1.json`]);
  });

  it("W6 answers replay's listing failure and escape quietly or with a note, where strict recovery propagates or refuses (memory only)", async () => {
    const outcome = async (act: Promise<unknown>): Promise<unknown> => act.then((value) => value ?? "ok", (error: Error) => error.message);
    const listA = memorySide("A", [], { listRejects: true });
    const escapeA = memorySide("A", [], { escapeDir: true });
    expect([await outcome(listA.replay()), listA.notes, await listA.tree()]).toEqual(["ok", [], sortedTree(SEED_A)]);
    expect([await outcome(escapeA.replay()), escapeA.notes]).toEqual(["ok", [ESCAPE_NOTE]]);
    expect([await outcome(memorySide("B", [], { listRejects: true }).recover()), await memorySide("B", [], { escapeDir: true }).recover()])
      .toEqual(["EIO: list refused", { status: "unsafe" }]);
    const inPlace = memorySide("A", [], { refuseConfine: "quarantine", refuseRemove: "bad.json" });
    await inPlace.replay();
    const tree = await inPlace.tree();
    expect([[...inPlace.notes].sort(), `${J}/bad.json` in tree, `${J}/esc.json` in tree]).toEqual([[removedInPlace("bad"), removedInPlace("esc")], true, false]);
  });

  it("W7 keeps the strict classify-then-load gap, and stops replay and recovery at the first raw revert failure (memory only)", async () => {
    expect(await memorySide("B", [], { secondRead: "vanish" }).recover()).toEqual({ status: "unsafe" });
    const unchecked = memorySide("B", [], { secondRead: "committed" });
    expect([await unchecked.recover(), (await unchecked.tree())["wiki/concepts/b.md"]]).toEqual([{ status: "replayed" }, "beta\n"]);
    const replayFails = memorySide("A", [], { replaceRejects: true });
    const strictFails = memorySide("B", [], { replaceRejects: true });
    const settled = [await replayFails.replay().catch((error: Error) => error.message), await strictFails.recover().catch((error: Error) => error.message)];
    const [treeA, treeB] = [await replayFails.tree(), await strictFails.tree()];
    expect([settled, `${J}/p1.json` in treeA, treeA["wiki/concepts/new.md"], `${J}/p2.json` in treeB]).toEqual([["EIO: replace refused", "EIO: replace refused"], true, "created\n", true]);
  });

  it("W8 makes no ambient disk call or note in the bound bodies, while the root forms reach every primitive and the note", async () => {
    const spies = [vi.spyOn(confine, "confineUnderRoot"), vi.spyOn(diskLocations, "locationRealPath"), vi.spyOn(confine, "safeRealpath"),
      vi.spyOn(diskLeaves, "removeLeaf"), vi.spyOn(diskLeaves, "replaceLeafAtomicWithin"), vi.spyOn(diskLeaves, "readLeafTextNoFollow"),
      vi.spyOn(diskLeaves, "listDirectoryNames"), vi.spyOn(diskLeaves, "makeDirectoryTree"), vi.spyOn(diskLeaves, "renameLeafUnguarded"),
      vi.spyOn(output, "note").mockImplementation(() => undefined)];
    await scenarioA(memorySide("A", []));
    await scenarioRecover(memorySide("B", []));
    expect(spies.map((spy) => spy.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    const replayRoot = await tracker.create(PREFIX);
    await writeFiles(replayRoot, { [`${J}/bad.json`]: BAD, [`${J}/p1.json`]: P1, "wiki/concepts/a.md": "changed\n" });
    await replayJournal(replayRoot);
    expect(spies.map((spy) => spy.mock.calls.length > 0)).toEqual(Array(10).fill(true));
    const recoverRoot = await tracker.create(PREFIX);
    await writeFiles(recoverRoot, SEED_B);
    const listedBefore = spies[6]!.mock.calls.length;
    expect(await recoverJournalBeforeCompile(recoverRoot)).toEqual({ status: "replayed" });
    const opened = await diskJournalReadSources(recoverRoot).openJournal();
    if (opened.kind === "ok") await opened.journal.listNames();
    expect([opened.kind, spies[6]!.mock.calls.length - listedBefore]).toEqual(["ok", 2]);
  });
});
