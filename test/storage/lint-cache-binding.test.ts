/**
 * @file test/storage/lint-cache-binding.test.ts
 * @description The lint cache as a WHOLE consumer with no project directory,
 * both halves: `writeLintCacheFrom` and `readLintCacheFrom`. They exist only
 * after the cache was given sources of its own, so this file has NO
 * before-edit run.
 *
 * HOW IT IS BUILT. One directory is minted on real disk, once. At a fixed
 * clock the real `writeLintCache(root, summary)` writes two caches there, a
 * full one and a clean one, and each file's bytes are read back; the real
 * `readLintCache(root)` then answers for the full cache, for a table of
 * hand-written cache texts planted one at a time, and for no cache at all.
 * The directory is removed before any case runs.
 *
 * WHAT RUNS FOR REAL IN MEMORY. Each half's one body. Writing: the aggregation,
 * which paths are made relative, the field that is omitted on a clean run, the
 * exact bytes, and this much of the order: the directory is made before any
 * path is made relative, the clock is read after aggregation, and the write is
 * last. No case separates the clock from the directory step or from the write.
 * Reading: the one read, the parse, and ONLY the validation branches the eleven
 * texts below reach. Many branches are not reached here, among them a
 * non-integer count, a non-array `rules`, and most malformed-row shapes. The inputs are raw: a lint summary whose findings
 * name files under the minted directory, and raw cache TEXT. No entry and no
 * aggregate is handed to a body.
 *
 * WHAT IS COMPARED. The bytes written in memory against the bytes the disk
 * writer wrote; each entry read in memory against what the disk reader
 * answered for the same text; and both against values written out here.
 *
 * WHAT THE DOUBLE IS. A map of texts and a call log. Its `projectRelative` is
 * `path.relative` from the minted directory's NAME: arithmetic on a string,
 * which opens nothing. It is not a writer: it shows nothing about atomic
 * replacement, a temporary file, a parent check, confinement or durability,
 * and nothing about what a link or a directory in the cache's place does to a
 * read. `lint-reads.test.ts` pins, on real files, the disk writer's calls and a
 * read of a missing cache, of a directory in its place and of malformed text.
 * It has NO link case, so a linked cache is pinned nowhere. The double is not a hosted store, not an access-control layer
 * and not `ProjectStore`.
 */

import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, setSystemTime } from "bun:test";
import {
  readLintCache, readLintCacheFrom, writeLintCache, writeLintCacheFrom, type LintCacheEntry, type LintCacheSources,
} from "../../src/linter/cache.js";
import type { LintResult, LintSummary } from "../../src/linter/types.js";
import { LAST_LINT_FILE, LLMWIKI_DIR } from "../../src/utils/constants.js";
import { tempRootTracker } from "../temp-roots.js";
import { enoent, mintOnceThenRemove } from "./copied-project.js";
import { expectMintingDirectoryRemoved } from "./minted-directory.js";

const PREFIX = "lint-cache-";
const AT = "2026-01-02T03:04:05.678Z";
const page = (name: string): string => `wiki/concepts/${name}.md`;
const JOURNAL = ".llmwiki/journal";

/**
 * A run in which two rules tie on count, two files tie within a rule, one
 * finding already names a project-relative file, one is `info`, and the
 * freshness rules both fire. `under` is where the absolute files are located.
 */
function fullSummary(under: string): LintSummary {
  const found = (rule: string, severity: LintResult["severity"], files: string[]): LintResult[] =>
    files.map((file) => ({ rule, severity, file: file === JOURNAL ? file : path.join(under, file), message: "m" }));
  return { errors: 3, warnings: 6, info: 1, results: [
    ...found("missing-summary", "warning", [page("b"), page("a")]),
    ...found("broken-wikilink", "error", [page("a"), page("b"), page("a")]),
    ...found("pending-target", "info", [page("a")]),
    ...found("journal-health", "warning", [JOURNAL]),
    ...found("orphaned-page", "warning", [page("e"), page("d")]),
    ...found("stale-page", "warning", [page("c")]),
  ] };
}
const CLEAN: LintSummary = { errors: 0, warnings: 0, info: 0, results: [] };
const row = (rule: string, severity: string, count: number, fileCount: number, topFile: string, topFileCount: number) =>
  ({ rule, severity, count, fileCount, topFile, topFileCount });
/** The full run's entry, written out: rows by count then rule name, the top file by count then path, every file project-relative. */
const FULL_ENTRY = { warnings: 6, errors: 3, at: AT, freshness: { stalePages: 1, orphanedPages: 2 }, rules: [
  row("broken-wikilink", "error", 3, 2, page("a"), 2), row("missing-summary", "warning", 2, 2, page("a"), 1),
  row("orphaned-page", "warning", 2, 2, page("d"), 1), row("journal-health", "warning", 1, 1, JOURNAL, 1), row("stale-page", "warning", 1, 1, page("c"), 1),
] };
const bytesOf = (entry: unknown): string => `${JSON.stringify(entry, null, 2)}\n`;

const CORE = { warnings: 2, errors: 1, at: AT };
const FRESH = { stalePages: 0, orphanedPages: 0 };
/** Hand-written cache texts and what a read of each must answer. */
const TEXTS: Array<{ name: string; text: string; entry: LintCacheEntry | null }> = [
  { name: "text that is not JSON", text: "{ not json", entry: null },
  { name: "JSON that is not an object", text: "\"last-lint\"", entry: null },
  { name: "the required fields alone", text: JSON.stringify(CORE), entry: CORE },
  { name: "an unknown extra field, which is left out", text: JSON.stringify({ ...CORE, extra: true }), entry: CORE },
  { name: "a timestamp without a time", text: JSON.stringify({ ...CORE, at: "2026-01-02" }), entry: null },
  { name: "a negative count", text: JSON.stringify({ ...CORE, errors: -1 }), entry: null },
  { name: "a malformed freshness", text: JSON.stringify({ ...CORE, freshness: { stalePages: "1", orphanedPages: 0 } }), entry: null },
  { name: "a rule row missing its count", text: JSON.stringify({ ...CORE, rules: [{ rule: "r", severity: "error", fileCount: 1, topFile: "f", topFileCount: 1 }] }), entry: null },
  { name: "rows that do not sum to the totals, which drops the rows only", text: JSON.stringify({ ...CORE, freshness: FRESH, rules: [row("r", "error", 2, 1, "f", 1)] }), entry: { ...CORE, freshness: FRESH } },
  { name: "a row whose top file exceeds its count, which drops the rows only", text: JSON.stringify({ ...CORE, rules: [row("r", "error", 3, 1, "f", 4)] }), entry: CORE },
  { name: "rows that agree with the totals", text: JSON.stringify({ ...CORE, rules: [row("r", "error", 3, 2, "f", 2)] }), entry: { ...CORE, rules: [row("r", "error", 3, 2, "f", 2)] as LintCacheEntry["rules"] } },
];

/** What the disk writer wrote and the disk reader answered, in the directory that no longer exists. */
interface OnDisk { dir: string; fullBytes: string; cleanBytes: string; fullEntry: LintCacheEntry | null; texts: Array<LintCacheEntry | null>; missing: LintCacheEntry | null }
const tracker = tempRootTracker();
let disk: OnDisk;

mintOnceThenRemove(tracker, async () => {
  const dir = await tracker.create(PREFIX);
  const cache = path.join(dir, LAST_LINT_FILE);
  setSystemTime(new Date(AT));
  await writeLintCache(dir, fullSummary(dir));
  const [fullBytes, fullEntry] = [await readFile(cache, "utf-8"), await readLintCache(dir)];
  await writeLintCache(dir, CLEAN);
  const cleanBytes = await readFile(cache, "utf-8");
  const texts: Array<LintCacheEntry | null> = [];
  for (const { text } of TEXTS) { await writeFile(cache, text); texts.push(await readLintCache(dir)); }
  await rm(cache);
  disk = { dir, fullBytes, cleanBytes, fullEntry, texts, missing: await readLintCache(dir) };
  setSystemTime();
});
afterEach(() => { setSystemTime(); });

/** Which member rejects, and with what. */
type Failing = Partial<Record<"mkdir" | "write" | "read", Error>>;
/** A cache store in memory: held texts, every call in order, and the sources over them. `onRelative` runs each time a path is made relative. */
function memory(failing: Failing = {}, onRelative: () => void = () => {}): { files: Map<string, string>; log: string[]; sources: LintCacheSources } {
  const [files, log] = [new Map<string, string>(), [] as string[]];
  const sources: LintCacheSources = {
    makeDirectoryTree: async (relDir) => { log.push(`mkdir ${relDir}`); if (failing.mkdir) throw failing.mkdir; },
    projectRelative: (file) => { log.push(`relative ${path.relative(disk.dir, file)}`); onRelative(); return path.relative(disk.dir, file); },
    writeAtomic: async (relPath, text) => { log.push(`write ${relPath}`); if (failing.write) throw failing.write; files.set(relPath, text); },
    readText: async (relPath) => { log.push(`read ${relPath}`); if (failing.read) throw failing.read; return files.get(relPath) ?? (() => { throw enoent(); })(); },
  };
  return { files, log, sources };
}
const atFixedClock = (): void => { setSystemTime(new Date(AT)); };

describe("writing the lint cache with no project directory", () => {
  it("K1 runs after the minting directory was removed, and the disk writer wrote the entry written out here", () => {
    expectMintingDirectoryRemoved(disk.dir, PREFIX);
    expect([disk.fullBytes, disk.cleanBytes]).toEqual([bytesOf(FULL_ENTRY), bytesOf({ warnings: 0, errors: 0, at: AT, freshness: FRESH })]);
  });

  it("K2 writes, for the full run and for the clean run, exactly the bytes the disk writer wrote: same fields, order, indentation and final newline", async () => {
    atFixedClock();
    const full = memory();
    await writeLintCacheFrom(full.sources, fullSummary(disk.dir));
    const clean = memory();
    await writeLintCacheFrom(clean.sources, CLEAN);
    expect([full.files.get(LAST_LINT_FILE), clean.files.get(LAST_LINT_FILE)]).toEqual([disk.fullBytes, disk.cleanBytes]);
    expect([clean.files.get(LAST_LINT_FILE)!.includes("rules"), [...full.files.keys()]]).toEqual([false, [LAST_LINT_FILE]]);
  });

  it("K3 makes the directory, then asks only for ABSOLUTE files of error and warning findings to be made relative, then writes once", async () => {
    atFixedClock();
    const { sources, log } = memory();
    await writeLintCacheFrom(sources, fullSummary(disk.dir));
    const relative = log.slice(1, -1);
    expect([log[0], log.at(-1), relative.length, relative.every((call) => call.startsWith("relative wiki/concepts/"))]).toEqual([`mkdir ${LLMWIKI_DIR}`, `write ${LAST_LINT_FILE}`, 8, true]);
    expect(relative.slice(0, 2)).toEqual([`relative ${page("b")}`, `relative ${page("a")}`]);
  });

  it("K4 reads the clock AFTER the findings are aggregated: a clock moved during aggregation is the one written", async () => {
    setSystemTime(new Date("2026-01-02T00:00:00.000Z"));
    const { files, sources } = memory({}, () => { setSystemTime(new Date(AT)); });
    await writeLintCacheFrom(sources, fullSummary(disk.dir));
    expect(files.get(LAST_LINT_FILE)).toBe(disk.fullBytes);
  });

  it("K5 rejects with the directory's own error before aggregating or writing, and with the write's own error after both", async () => {
    const [mkdir, write] = [new Error("planted mkdir failure"), new Error("planted write failure")];
    const refused = memory({ mkdir });
    await expect(writeLintCacheFrom(refused.sources, fullSummary(disk.dir))).rejects.toBe(mkdir);
    expect(refused.log).toEqual([`mkdir ${LLMWIKI_DIR}`]);
    const unwritten = memory({ write });
    await expect(writeLintCacheFrom(unwritten.sources, fullSummary(disk.dir))).rejects.toBe(write);
    expect([unwritten.log.length, unwritten.log.at(-1), unwritten.files.size]).toEqual([10, `write ${LAST_LINT_FILE}`, 0]);
  });
});

describe("reading the lint cache with no project directory", () => {
  /** A read of `text` held as the cache, with the calls it made. */
  const readOf = async (text: string): Promise<{ entry: LintCacheEntry | null; log: string[] }> => {
    const { files, log, sources } = memory();
    files.set(LAST_LINT_FILE, text);
    return { entry: await readLintCacheFrom(sources), log };
  };

  it("K6 reads the bytes the disk writer wrote back to the entry the disk reader answered, with one whole-file read", async () => {
    const { entry, log } = await readOf(disk.fullBytes);
    expect(entry).toEqual(disk.fullEntry);
    expect([entry, log]).toEqual([FULL_ENTRY, [`read ${LAST_LINT_FILE}`]]);
  });

  it.each(TEXTS.map((one, index) => ({ ...one, index })))("K7 $name: answers what the disk reader answered", async ({ text, entry, index }) => {
    const read = await readOf(text);
    expect(read.entry).toEqual(disk.texts[index]);
    expect(read.entry).toEqual(entry);
  });

  it("K8 answers null, as the disk reader did for no cache, when the read rejects for any reason", async () => {
    expect([disk.missing, await readLintCacheFrom(memory().sources), await readLintCacheFrom(memory({ read: new Error("planted read failure") }).sources)]).toEqual([null, null, null]);
  });
});
