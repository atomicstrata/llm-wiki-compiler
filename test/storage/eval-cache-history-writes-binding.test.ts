/**
 * @file test/storage/eval-cache-history-writes-binding.test.ts
 * @description The citation cache's public load and clear, and the history
 * writer, as WHOLE consumers with no project directory: `loadCitationCacheFrom`,
 * `clearCitationCacheFrom` and `appendHistoryFrom`, over `EvalFileReads` and
 * `EvalFileWrites`. They exist only after those three were given reads and
 * writes of their own, so this file has NO before-edit run.
 *
 * HOW IT IS BUILT. Three default-profile projects are minted on real disk.
 * `kept` has a cache file with a duplicate key, a blank line, a torn line and a
 * score no judge returns; the real load answers and the real writer appends two
 * reports. `cleared` has the same cache; the real clear is asked twice. `linked`
 * has its cache and its history as LINKS to files outside `.llmwiki/`; the real
 * load, writer and clear answer through them. Every directory a file or link
 * needs is made explicitly before it. Each tree is copied AFTER those calls, as
 * raw text and listings, so a copy holds exactly the bytes the disk was left
 * with, and the directories are removed before any case runs.
 *
 * WHAT RUNS FOR REAL IN MEMORY. The line split, filter and parse of the load;
 * the ask-then-remove of the clear; the make-serialize-append of the writer.
 * The double is a map of texts and a set of directories with a call log. It
 * answers raw facts only: is a path there, its text, and what an append, a
 * directory make or a removal does to the map. No parsed cache, no serialized
 * line and no "removed" answer is handed in.
 *
 * WHAT IS NOT SHOWN. The judge's own keyed cache reader, the judge, sampling,
 * `collectStats` and `runEval`: none is reached and NO MODEL IS CALLED. The map
 * shows nothing about atomicity, locking, durability or confinement, and it has
 * no links: what a link does is shown ONLY by the disk answers of `linked`
 * (cases K1 and K2), through the root forms.
 */

import { mkdir, symlink } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import { clearCitationCache, clearCitationCacheFrom, loadCitationCache, loadCitationCacheFrom } from "../../src/eval/cache.js";
import type { EvalFileReads } from "../../src/eval/file-reads.js";
import type { EvalFileWrites } from "../../src/eval/file-writes.js";
import { appendHistory, appendHistoryFrom } from "../../src/eval/stats.js";
import type { CitationJudgement } from "../../src/eval/types.js";
import { makeEvalReport } from "../fixtures/eval-report.js";
import { tempRootTracker } from "../temp-roots.js";
import { enoent, expectRemovedDefaultCopies, mintCopied, mintOnceThenRemove, writeFiles, type Copy, type Minted } from "./copied-project.js";

const PREFIX = "eval-cache-history-writes-";
const EVAL_DIR = ".llmwiki/eval";
const CACHE = `${EVAL_DIR}/citation-cache.jsonl`;
const HISTORY = `${EVAL_DIR}/history.jsonl`;
const line = (claimHash: string, score: number, pageSlug: string): string => JSON.stringify({ claimHash, score, pageSlug });
/** Three lines parse: the first key, the same key again with another score, and a score of 7. A blank line and a torn line do not. */
const CACHE_TEXT = `${line("a", 2, "p")}\n\n{ torn\n${line("a", 0, "p")}\n${line("b", 7, "q")}\n`;
const FIRST = makeEvalReport({ timestamp: "first" });
const SECOND = makeEvalReport({ suite: "full", timestamp: "second" });
const TWO_LINES = `${JSON.stringify(FIRST)}\n${JSON.stringify(SECOND)}\n`;

/** What the disk answered for one project. */
interface OnDisk { loaded: CitationJudgement[]; cleared: boolean[] }
type Project = Minted<OnDisk>;

const tracker = tempRootTracker();
let kept: Project;
let cleared: Project;
let linked: Project;

mintOnceThenRemove(tracker, async () => {
  const seedCache = (root: string): Promise<void> => writeFiles(root, { [CACHE]: CACHE_TEXT });
  kept = await mintCopied(tracker, PREFIX, seedCache, async (root) => {
    const loaded = await loadCitationCache(root);
    await appendHistory(root, FIRST);
    await appendHistory(root, SECOND);
    return { loaded, cleared: [] };
  });
  cleared = await mintCopied(tracker, PREFIX, seedCache, async (root) =>
    ({ loaded: [], cleared: [await clearCitationCache(root), await clearCitationCache(root)] }));
  linked = await mintCopied(tracker, PREFIX, async (root) => {
    await writeFiles(root, { "cache-target.jsonl": CACHE_TEXT, "history-target.jsonl": "" });
    await mkdir(path.join(root, EVAL_DIR), { recursive: true });
    await symlink("../../cache-target.jsonl", path.join(root, CACHE));
    await symlink("../../history-target.jsonl", path.join(root, HISTORY));
  }, async (root) => {
    const loaded = await loadCitationCache(root);
    await appendHistory(root, FIRST);
    return { loaded, cleared: [await clearCitationCache(root)] };
  });
});

/** A map of texts and a set of directories, with every call logged. An append needs its directory; a removal needs its file. */
function memoryFiles(copy: Copy, events: string[]): { texts: Map<string, string>; reads: EvalFileReads; writes: EvalFileWrites } {
  const texts = new Map(copy.files);
  const directories = new Set(copy.listings.keys());
  const reads: EvalFileReads = {
    existsSync: (rel) => { events.push(`exists ${rel}`); return texts.has(rel) || directories.has(rel); },
    readText: async (rel) => { events.push(`read ${rel}`); return texts.get(rel) ?? Promise.reject(enoent()); },
  };
  const writes: EvalFileWrites = {
    makeDirectoryTree: async (relDir) => { events.push(`mkdir ${relDir}`); directories.add(relDir); },
    appendText: async (rel, text) => {
      events.push(`append ${rel}`);
      if (!directories.has(path.posix.dirname(rel))) throw enoent();
      texts.set(rel, (texts.get(rel) ?? "") + text);
    },
    removeFile: async (rel) => { events.push(`remove ${rel}`); if (!texts.delete(rel)) throw enoent(); },
  };
  return { texts, reads, writes };
}

const EMPTY: Copy = { files: new Map(), listings: new Map() };
/** The doubles over a project that holds nothing, with their call log. */
function fromNothing(): ReturnType<typeof memoryFiles> & { events: string[] } {
  const events: string[] = [];
  return { events, ...memoryFiles(EMPTY, events) };
}

describe("the citation cache's load and clear over copied projects, with the directories gone", () => {
  it("W1 runs after every minting directory was removed, on copies holding what the disk was left with", () => {
    expectRemovedDefaultCopies([kept, cleared, linked], PREFIX);
    expect([kept.copy.files.get(CACHE), kept.copy.files.get(HISTORY), cleared.copy.files.has(CACHE)]).toEqual([CACHE_TEXT, TWO_LINES, false]);
  });

  it("L1 loads what the disk load did: every line that parses, in order, a repeated key and an odd score kept", async () => {
    const events: string[] = [];
    const loaded = await loadCitationCacheFrom(memoryFiles(kept.copy, events).reads);
    expect(loaded).toEqual(kept.onDisk.loaded);
    expect(loaded.map((entry) => [entry.claimHash, entry.score])).toEqual([["a", 2], ["a", 0], ["b", 7]]);
    expect(events).toEqual([`exists ${CACHE}`, `read ${CACHE}`]);
  });

  it("L2 loads nothing, with no read, where there is no cache, and rejects with a read's own error", async () => {
    const events: string[] = [];
    expect(await loadCitationCacheFrom(memoryFiles(EMPTY, events).reads)).toEqual([]);
    expect(events).toEqual([`exists ${CACHE}`]);
    const failure = new Error("planted read failure");
    const reads: EvalFileReads = { existsSync: () => true, readText: async () => { throw failure; } };
    await expect(loadCitationCacheFrom(reads)).rejects.toBe(failure);
  });

  it("C1 trusts the existence answer and passes a removal failure on untouched", async () => {
    const events: string[] = [];
    const { reads, writes } = memoryFiles(kept.copy, events);
    expect(await clearCitationCacheFrom({ ...reads, existsSync: () => false }, writes)).toBe(false);
    expect(events).toEqual([]);
    const failure = new Error("planted removal failure");
    await expect(clearCitationCacheFrom(reads, { ...writes, removeFile: async () => { throw failure; } })).rejects.toBe(failure);
  });

  it("C2 clears as the disk clear did: true once, then false, asking before it removes", async () => {
    const events: string[] = [];
    const { texts, reads, writes } = memoryFiles(kept.copy, events);
    expect([await clearCitationCacheFrom(reads, writes), await clearCitationCacheFrom(reads, writes)]).toEqual(cleared.onDisk.cleared);
    expect(cleared.onDisk.cleared).toEqual([true, false]);
    expect(events).toEqual([`exists ${CACHE}`, `remove ${CACHE}`, `exists ${CACHE}`]);
    expect([texts.has(CACHE), texts.get(HISTORY)]).toEqual([false, TWO_LINES]);
  });
});

describe("the history writer over the same doubles", () => {
  it("H1 appends the exact bytes the disk writer did: one JSON line per report, each ended by a newline", async () => {
    const { events, texts, writes } = fromNothing();
    await appendHistoryFrom(writes, FIRST);
    await appendHistoryFrom(writes, SECOND);
    expect(texts.get(HISTORY)).toBe(kept.copy.files.get(HISTORY));
    expect(texts.get(HISTORY)).toBe(TWO_LINES);
    expect(events).toEqual([`mkdir ${EVAL_DIR}`, `append ${HISTORY}`, `mkdir ${EVAL_DIR}`, `append ${HISTORY}`]);
  });

  it("H2 makes the directory, then serializes, then appends, and appends nothing when serializing fails", async () => {
    const { events, texts, writes } = fromNothing();
    await appendHistoryFrom(writes, Object.assign({ ...FIRST }, { toJSON: () => { events.push("serialize"); return { mark: 1 }; } }));
    expect(events).toEqual([`mkdir ${EVAL_DIR}`, "serialize", `append ${HISTORY}`]);
    expect(texts.get(HISTORY)).toBe('{"mark":1}\n');
    const failure = new Error("planted serialization failure");
    await expect(appendHistoryFrom(writes, Object.assign({ ...FIRST }, { toJSON: () => { throw failure; } }))).rejects.toBe(failure);
    expect([events.slice(3), texts.get(HISTORY)]).toEqual([[`mkdir ${EVAL_DIR}`], '{"mark":1}\n']);
  });

  it("H3 passes a directory failure on before anything is appended, and an append failure on after the directory was made", async () => {
    const { events, texts, writes } = fromNothing();
    const failure = new Error("planted write failure");
    await expect(appendHistoryFrom({ ...writes, makeDirectoryTree: async () => { throw failure; } }, FIRST)).rejects.toBe(failure);
    expect([events, texts.has(HISTORY)]).toEqual([[], false]);
    await expect(appendHistoryFrom({ ...writes, appendText: async () => { throw failure; } }, FIRST)).rejects.toBe(failure);
    expect([events, texts.has(HISTORY)]).toEqual([[`mkdir ${EVAL_DIR}`], false]);
  });
});

describe("what a link does, from the disk's answers only", () => {
  it("K1 the disk load and the disk writer went THROUGH the links: the cache target was read and the history target was written", () => {
    expect(linked.onDisk.loaded).toEqual(kept.onDisk.loaded);
    expect(linked.copy.files.get("history-target.jsonl")).toBe(`${JSON.stringify(FIRST)}\n`);
    expect(linked.copy.listings.get(EVAL_DIR)).toEqual([{ name: "history.jsonl", kind: "link" }]);
  });

  it("K2 the disk clear removed the cache LINK and left its target as it was", () => {
    expect(linked.onDisk.cleared).toEqual([true]);
    expect([linked.copy.files.get("cache-target.jsonl"), linked.copy.files.has(CACHE)]).toEqual([CACHE_TEXT, false]);
  });
});
