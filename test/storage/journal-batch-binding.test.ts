/**
 * @file test/storage/journal-batch-binding.test.ts
 * @description The legacy journal's BATCH LIFECYCLE, WHOLE, over raw I/O held
 * in memory: `openBatchFrom` confines the journal dir and persists an empty
 * pending batch; `recordPreStateFrom` and `recordBinaryPreStateFrom` dedupe
 * FIRST, read the target root-anchored and capped, refuse an `unavailable`
 * read (never `absent`), record text as UTF-8 and bytes as base64 ALWAYS, admit
 * the opt-in aggregate budget BEFORE appending, and persist the whole batch
 * (`JSON.stringify(payload, null, 2)`), withdrawing the entry and its charge
 * when that persist fails; `commitBatchFrom` sets `committed` BEFORE removing
 * the journal file and swallows ENOENT only. The bodies exist only after the
 * lifecycle was given bodies of its own, so this file has NO before-edit run.
 *
 * HOW IT IS BUILT. One project is minted on real disk, once. The text seed is
 * copied BEFORE the disk ask (`mintCopiedBeforeAsk`), and that copied text seeds
 * the memory side after a literal guard. The copy holds files as UTF-8 text, so
 * the one binary seed is instead read back as raw bytes INSIDE the seed callback
 * — before the copy and before the ask — and that retained snapshot, guarded
 * literally as base64, seeds the memory side. The ask runs the whole scenario
 * through the real ROOT forms with the incumbent clock and `Math.random` frozen
 * around each open only (the batch id; no runtime change), settling each step
 * exactly once: `ok` or the error, and the one journal file's bytes (or null).
 * Only the root is normalised, to `<root>`, and in its JSON-escaped spelling,
 * so the journal bytes are compared exactly as the platform writes them; the
 * expected target paths are joined with the native separator and JSON-escaped
 * the same way. The memory replay must give the same outcomes, and both must
 * equal journal bytes written out literally here.
 *
 * WHAT IS MEMORY ONLY. The operation order, the injected faults (an
 * `unavailable` read, a failing persist then retry, a failing removal), and the
 * proof that the bound bodies make no ambient disk call. Real confinement,
 * links, the parent-swap race and replay stay with the incumbent journal
 * suites; canonical root aliasing is only exercised implicitly there (and by
 * this file's non-canonical temp root), never asserted. No Windows run is claimed.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "bun:test";
import * as diskLeaves from "../../src/storage/disk-guarded-leaves.js";
import * as diskLocations from "../../src/storage/disk-locations.js";
import {
  commitBatch, commitBatchFrom, openBatch, openBatchFrom, recordBinaryPreState, recordBinaryPreStateFrom,
  recordPreState, recordPreStateFrom, type JournalBatch, type JournalBatchIo, type OpenBatchOptions,
} from "../../src/trust/journal.js";
import type { CappedLeafReadBuffer } from "../../src/utils/confined-read.js";
import * as confine from "../../src/utils/path-confine.js";
import { tempRootTracker } from "../temp-roots.js";
import { mintCopiedBeforeAsk, mintOnceThenRemove, writeFiles, type Minted } from "./copied-project.js";
import { expectMintingDirectoryRemoved } from "./minted-directory.js";
import { confinedUnder, rootShown, target } from "./journal-paths.js";

const PREFIX = "journal-batch-binding-";
const MEM_ROOT = path.resolve("/memory/project");
const NOW = 1_700_000_000_000;
/** The batch id under the frozen clock: `Math.random()` at 0.5 is `0.i` in base 36. */
const ID = `${NOW}-${process.pid}-i`;
const ALPHA = "alpha\n";
/** Not valid UTF-8; base64 `//4AgMM=`. */
const BIN = Uint8Array.from([0xff, 0xfe, 0x00, 0x80, 0xc3]);
const JOURNAL = `.llmwiki/journal/${ID}.json`;


const EMPTY = `{\n  "batchId": "${ID}",\n  "status": "pending",\n  "entries": []\n}`;
const TEXT = `    {\n      "targetPath": "${target("wiki", "concepts", "a.md")}",\n      "preState": {\n        "absent": false,\n        "content": "alpha\\n"\n      }\n    }`;
const ABSENT = `    {\n      "targetPath": "${target("wiki", "concepts", "new.md")}",\n      "preState": {\n        "absent": true\n      }\n    }`;
const BINARY = `    {\n      "targetPath": "${target("raw", "blob.bin")}",\n      "preState": {\n        "absent": false,\n        "content": "//4AgMM=",\n        "encoding": "base64"\n      }\n    }`;
const pending = (...entries: string[]): string => `{\n  "batchId": "${ID}",\n  "status": "pending",\n  "entries": [\n${entries.join(",\n")}\n  ]\n}`;
const UNREADABLE = (...parts: string[]): string =>
  `JournalPreStateUnreadableError: journal pre-state for "${target(...parts)}" is unreadable (symlinked leaf or parent, non-regular, raced, or over 16777216 bytes) — refusing the mutation`;

/** One lifecycle, root or bound, over project-relative POSIX targets. */
interface Side {
  base: string;
  open(opts?: OpenBatchOptions): Promise<JournalBatch>;
  text(batch: JournalBatch, rel: string): Promise<void>;
  binary(batch: JournalBatch, rel: string, maxPreStateBytes?: number): Promise<void>;
  commit(batch: JournalBatch): Promise<void>;
  journal(): Promise<string | null>;
}
interface Step { name: string; settled: string; journal: string | null }

/** Open with the incumbent clock and `Math.random` frozen, restoring both at once. */
async function frozenOpen(side: Side, opts?: OpenBatchOptions): Promise<JournalBatch> {
  const clock = vi.spyOn(Date, "now").mockReturnValue(NOW);
  const random = vi.spyOn(Math, "random").mockReturnValue(0.5);
  try { return await side.open(opts); } finally { clock.mockRestore(); random.mockRestore(); }
}

/** `ok`, or the error's name and message with the side's root (JSON-escaped, as the messages quote it) shown as `<root>`. */
function settledOf(side: Side, act: Promise<unknown>): Promise<string> {
  return act.then(() => "ok", (error: Error) => `${error.name}: ${rootShown(error.message, side.base)}`);
}

/** The whole lifecycle: an unbudgeted batch, then an opt-in budgeted one; each step settled once. */
async function runScenario(side: Side): Promise<string[]> {
  const steps: Step[] = [];
  const settle = async (name: string, act: () => Promise<unknown>): Promise<void> => {
    steps.push({ name, settled: await settledOf(side, act()), journal: await side.journal() });
  };
  let plain!: JournalBatch, budgeted!: JournalBatch;
  await settle("open", async () => { plain = await frozenOpen(side); });
  await settle("text", () => side.text(plain, "wiki/concepts/a.md"));
  await settle("absent", () => side.text(plain, "wiki/concepts/new.md"));
  await settle("binary", () => side.binary(plain, "raw/blob.bin"));
  await settle("dedupe", () => side.text(plain, "wiki/concepts/a.md"));
  await settle("commit", () => side.commit(plain));
  await settle("open-budget", async () => { budgeted = await frozenOpen(side, { maxAggregatePreStateBytes: 8 }); });
  await settle("text-in-budget", () => side.text(budgeted, "wiki/concepts/a.md"));
  await settle("binary-over-budget", () => side.binary(budgeted, "raw/blob.bin"));
  await settle("commit-budget", () => side.commit(budgeted));
  const final = { statuses: [plain.status, budgeted.status], bytes: [plain.aggregatePreStateBytes, budgeted.aggregatePreStateBytes], entries: [plain.entries.length, budgeted.entries.length] };
  return [...steps.map((step) => JSON.stringify(step)), JSON.stringify(final)];
}

/** The ROOT forms on a real project at `root`. */
function diskSide(root: string): Side {
  const at = (rel: string): string => path.join(root, rel);
  return {
    base: root,
    open: (opts) => openBatch(root, opts),
    text: (batch, rel) => recordPreState(batch, at(rel)),
    binary: (batch, rel, maxPreStateBytes) => recordBinaryPreState(batch, at(rel), maxPreStateBytes === undefined ? {} : { maxPreStateBytes }),
    commit: (batch) => commitBatch(batch),
    journal: () => readFile(at(JOURNAL), "utf-8").then((text) => rootShown(text, root), () => null),
  };
}

const tracker = tempRootTracker();
let minted: Minted<string[]>;
/** The binary seed's raw bytes, read back inside the seed callback: before the copy and before the ask. */
let seededBlob: Buffer;
mintOnceThenRemove(tracker, async () => {
  const seed = async (root: string): Promise<void> => {
    await writeFiles(root, { "wiki/concepts/a.md": ALPHA });
    await mkdir(path.join(root, "raw"));
    await writeFile(path.join(root, "raw/blob.bin"), BIN);
    seededBlob = await readFile(path.join(root, "raw/blob.bin"));
  };
  minted = await mintCopiedBeforeAsk(tracker, PREFIX, seed, (root) => runScenario(diskSide(root)));
});

/** The memory seed: the copied text and the retained binary snapshot, each after a LITERAL guard. */
function seededBytes(): Map<string, Buffer> {
  expect([...minted.copy.files.keys()].sort()).toEqual(["raw/blob.bin", "wiki/concepts/a.md"]);
  const copiedText = minted.copy.files.get("wiki/concepts/a.md");
  expect([copiedText, seededBlob.toString("base64")]).toEqual([ALPHA, "//4AgMM="]);
  return new Map([["wiki/concepts/a.md", Buffer.from(copiedText!, "utf-8")], ["raw/blob.bin", Buffer.from(seededBlob)]]);
}

/** Faults with no disk twin: every read `unavailable`, the next N persists failing, or a failing removal. */
interface Faults { unavailable?: boolean; persistFailures?: number; remove?: Error }

/** Raw journal I/O over one map seeded from the copy (POSIX keys under `MEM_ROOT`), every call logged. */
function memoryIo(log: string[], held: Map<string, Buffer>, faults: Faults): JournalBatchIo {
  const key = (abs: string): string => path.relative(MEM_ROOT, abs).split(path.sep).join("/");
  const read = (kind: string, leaf: string, expectedDir: string, maxBytes: number): CappedLeafReadBuffer => {
    log.push(`read-${kind} ${key(leaf)} under ${key(expectedDir)} max ${maxBytes}`);
    const bytes = held.get(key(leaf));
    if (faults.unavailable || (bytes !== undefined && bytes.length > maxBytes)) return { kind: "unavailable" };
    return bytes === undefined ? { kind: "absent" } : { kind: "ok", body: bytes };
  };
  return {
    confineTarget: async (targetPath, root) => {
      log.push(`confine ${targetPath.split(path.sep).join("/")}`);
      return confinedUnder(root, targetPath);
    },
    realPath: async (location) => { log.push(`realpath ${location.split(MEM_ROOT).join("<root>")}`); return location; },
    readConfinedLeafText: async (_root, leaf, dir, max) => {
      const got = read("text", leaf, dir, max);
      return got.kind === "ok" ? { kind: "ok", body: got.body.toString("utf-8") } : got;
    },
    readConfinedLeafBytes: async (_root, leaf, dir, max) => read("bytes", leaf, dir, max),
    replaceLeafAtomicWithin: async (confineRoot, leaf, text) => {
      log.push(`replace ${key(leaf)} within ${confineRoot.split(MEM_ROOT).join("<root>")}`);
      if ((faults.persistFailures ?? 0) > 0) {
        faults.persistFailures = (faults.persistFailures ?? 0) - 1;
        throw Object.assign(new Error("EIO: persist refused"), { code: "EIO" });
      }
      held.set(key(leaf), Buffer.from(text, "utf-8"));
    },
    removeLeaf: async (leaf) => {
      log.push(`remove ${key(leaf)}`);
      if (faults.remove) throw faults.remove;
      if (!held.delete(key(leaf))) throw Object.assign(new Error("ENOENT: not held"), { code: "ENOENT" });
    },
  };
}

/** The bound bodies over {@link memoryIo}, on the seeded copy. */
function memorySide(log: string[], faults: Faults = {}): Side {
  const held = seededBytes();
  const io = memoryIo(log, held, faults);
  const at = (rel: string): string => path.join(MEM_ROOT, rel);
  return {
    base: MEM_ROOT,
    open: (opts) => openBatchFrom(io, MEM_ROOT, opts),
    text: (batch, rel) => recordPreStateFrom(io, batch, at(rel)),
    binary: (batch, rel, maxPreStateBytes) => recordBinaryPreStateFrom(io, batch, at(rel), maxPreStateBytes === undefined ? {} : { maxPreStateBytes }),
    commit: (batch) => commitBatchFrom(io, batch),
    journal: async () => { const text = held.get(JOURNAL)?.toString("utf-8"); return text === undefined ? null : rootShown(text, MEM_ROOT); },
  };
}

/** Replay the scenario in memory and require the disk's outcomes, parsed. */
async function expectDiskParity(): Promise<Step[]> {
  const outcomes = await runScenario(memorySide([]));
  expect(outcomes).toEqual(minted.onDisk);
  return outcomes.map((outcome) => JSON.parse(outcome) as Step);
}

describe("the journal batch lifecycle over a copied project, with the minting directory gone", () => {
  it("B1 runs after the minting directory was removed, on the copied text seed and the retained before-copy binary snapshot", () => {
    expectMintingDirectoryRemoved(minted.dir, PREFIX);
    seededBytes();
  });

  it("B2 opens, records text, absent and non-UTF-8 bytes (base64), dedupes, and commits, with literal journal bytes, as the disk did", async () => {
    const steps = await expectDiskParity();
    expect(steps.slice(0, 6)).toEqual([
      { name: "open", settled: "ok", journal: EMPTY },
      { name: "text", settled: "ok", journal: pending(TEXT) },
      { name: "absent", settled: "ok", journal: pending(TEXT, ABSENT) },
      { name: "binary", settled: "ok", journal: pending(TEXT, ABSENT, BINARY) },
      { name: "dedupe", settled: "ok", journal: pending(TEXT, ABSENT, BINARY) },
      { name: "commit", settled: "ok", journal: null },
    ]);
  });

  it("B3 refuses a capture over the opt-in budget BEFORE persisting it, uncharged, and both batches end committed, as the disk did", async () => {
    const steps = await expectDiskParity();
    const overBudget = `JournalAggregateBudgetExceededError: journal pre-state for "${target("raw", "blob.bin")}" would put the batch at 11 aggregate decoded bytes, over its 8-byte budget — refusing the mutation`;
    expect(steps.slice(6, 10)).toEqual([
      { name: "open-budget", settled: "ok", journal: EMPTY },
      { name: "text-in-budget", settled: "ok", journal: pending(TEXT) },
      { name: "binary-over-budget", settled: overBudget, journal: pending(TEXT) },
      { name: "commit-budget", settled: "ok", journal: null },
    ]);
    expect(steps[10]).toEqual({ statuses: ["committed", "committed"], bytes: [11, 6], entries: [3, 1] });
  });

  it("B4 confines then persists on open, dedupes before any I/O, reads before persisting, and persists nothing for a refusal (memory only)", async () => {
    const log: string[] = [];
    await runScenario(memorySide(log));
    const open = ["confine .llmwiki/journal", `replace ${JOURNAL} within <root>`];
    const capture = (kind: string, rel: string): string[] =>
      ["realpath <root>", `read-${kind} ${rel} under ${path.posix.dirname(rel)} max 16777216`, `replace ${JOURNAL} within <root>`];
    expect(log).toEqual([
      ...open, ...capture("text", "wiki/concepts/a.md"), ...capture("text", "wiki/concepts/new.md"), ...capture("bytes", "raw/blob.bin"), `remove ${JOURNAL}`,
      ...open, ...capture("text", "wiki/concepts/a.md"), ...capture("bytes", "raw/blob.bin").slice(0, 2), `remove ${JOURNAL}`,
    ]);
  });

  it("B5 refuses an unavailable text or binary read (never absent), and passes a raw byte cap through exactly (memory only)", async () => {
    const refused = memorySide([], { unavailable: true });
    const batch = await frozenOpen(refused);
    const unreadable = [await settledOf(refused, refused.text(batch, "wiki/concepts/a.md")), await settledOf(refused, refused.binary(batch, "raw/blob.bin"))];
    expect([unreadable, batch.entries, await refused.journal()]).toEqual([[UNREADABLE("wiki", "concepts", "a.md"), UNREADABLE("raw", "blob.bin")], [], EMPTY]);
    const log: string[] = [];
    const capped = memorySide(log);
    const cappedBatch = await frozenOpen(capped);
    const outcomes = [await settledOf(capped, capped.binary(cappedBatch, "raw/blob.bin", 4)), await settledOf(capped, capped.binary(cappedBatch, "raw/blob.bin", 5))];
    expect([outcomes, await capped.journal()]).toEqual([[UNREADABLE("raw", "blob.bin"), "ok"], pending(BINARY)]);
    expect(log.filter((call) => call.startsWith("read-"))).toEqual(["read-bytes raw/blob.bin under raw max 4", "read-bytes raw/blob.bin under raw max 5"]);
  });

  it("B6 withdraws an entry and its charge when its persist fails, so a retry really re-reads and records it (memory only)", async () => {
    const log: string[] = [];
    const faults: Faults = {};
    const side = memorySide(log, faults);
    const batch = await frozenOpen(side, { maxAggregatePreStateBytes: 100 });
    faults.persistFailures = 1;
    const failed = await settledOf(side, side.text(batch, "wiki/concepts/a.md"));
    const afterFailure = [batch.entries.length, batch.aggregatePreStateBytes, await side.journal()];
    const retried = await settledOf(side, side.text(batch, "wiki/concepts/a.md"));
    expect([failed, afterFailure, retried, batch.aggregatePreStateBytes, await side.journal()]).toEqual(["Error: EIO: persist refused", [0, 0, EMPTY], "ok", 6, pending(TEXT)]);
    const attempt = ["realpath <root>", "read-text wiki/concepts/a.md under wiki/concepts max 16777216", `replace ${JOURNAL} within <root>`];
    expect(log.slice(2)).toEqual([...attempt, ...attempt]);
  });

  it("B7 marks a batch committed before removing its journal, propagates a non-ENOENT removal failure, and swallows ENOENT (memory only)", async () => {
    const refusal = Object.assign(new Error("EACCES: remove refused"), { code: "EACCES" });
    const refused = memorySide([], { remove: refusal });
    const batch = await frozenOpen(refused);
    expect([await settledOf(refused, refused.commit(batch)), batch.status, await refused.journal()]).toEqual(["Error: EACCES: remove refused", "committed", EMPTY]);
    const side = memorySide([]);
    const again = await frozenOpen(side);
    expect([await settledOf(side, side.commit(again)), await settledOf(side, side.commit(again)), again.status]).toEqual(["ok", "ok", "committed"]);
  });

  it("B8 makes no ambient disk call in the bound bodies, while the root forms still reach every disk primitive", async () => {
    const spies = [vi.spyOn(confine, "confineUnderRoot"), vi.spyOn(diskLocations, "locationRealPath"), vi.spyOn(diskLeaves, "readConfinedLeafText"),
      vi.spyOn(diskLeaves, "readConfinedLeafBytes"), vi.spyOn(diskLeaves, "replaceLeafAtomicWithin"), vi.spyOn(diskLeaves, "removeLeaf")];
    await runScenario(memorySide([]));
    expect(spies.map((spy) => spy.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0]);
    const root = await tracker.create(PREFIX);
    const batch = await openBatch(root);
    await recordPreState(batch, path.join(root, "absent.md"));
    await recordBinaryPreState(batch, path.join(root, "absent.bin"));
    await commitBatch(batch);
    expect(spies.map((spy) => spy.mock.calls.length > 0)).toEqual([true, true, true, true, true, true]);
  });
});
