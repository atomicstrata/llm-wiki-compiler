/**
 * @file test/storage/lint-command-binding.test.ts
 * @description The lint command as a WHOLE consumer with no project directory:
 * `lintCommandFrom` over `LintCommandSources`, on its flat, tiered and
 * fix-preview paths. It exists only after the command was given sources of its
 * own, so this file has NO before-edit run.
 *
 * HOW IT IS BUILT. One default-profile project is minted on real disk, with two
 * broken links (one repairable), a low-confidence page and a page outside the
 * generic directories. With the working directory set to it and the clock
 * fixed, the real root-taking `lintCommand` runs three times: flat, tiered and
 * fix-preview. For each, the printed lines, the requested exit codes and the
 * cache file's text are kept. The tree is then copied as raw text and listings
 * and the directory is removed before any case runs.
 *
 * WHAT RUNS FOR REAL IN MEMORY. The command's one body: the schema load, the
 * path selection, the printing, the cache write and the exit. Under it, the
 * real coordinator with every rule, the real fix plan and the real cache
 * writer. Inputs are raw text. No finding, plan or cache entry is handed in.
 *
 * WHAT IS COMPARED. The lines printed in memory against the lines the disk
 * command printed after its two header lines; the cache text against the cache
 * file's; the exit codes; and the order of printing, cache calls and exit.
 *
 * WHAT IS NOT SHOWN. `--fix-propose` itself: it is a locked candidate writer
 * that only the root wrapper reaches, so its path and its precedence over the
 * other flags are NOT run here. L9 shows only that the body over sources
 * refuses that flag. A run with no error (exit not requested), a
 * schema file, a custom profile, and the header, which the root wrapper prints.
 * The printing and exit spies stand in for a terminal and a process; they are
 * not sources. The cache double is a map and a call log: it shows nothing
 * about atomic replacement or durability.
 */

import { readFile, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { afterAll, describe, expect, it, vi, setSystemTime } from "bun:test";
import lintCommand, { lintCommandFrom, type LintCommandOptions, type LintCommandSources } from "../../src/commands/lint.js";
import type { LintCacheSources } from "../../src/linter/cache.js";
import type { LintSources } from "../../src/linter/lint-sources.js";
import { CONCEPTS_DIR, LAST_LINT_FILE, LLMWIKI_DIR, SOURCES_DIR } from "../../src/utils/constants.js";
import { tempRootTracker } from "../temp-roots.js";
import { countOf, expectRemovedDefaultCopies, mintCopied, mintOnceThenRemove, unasked, writeFiles, type Minted } from "./copied-project.js";
import { lintSourcesOver, NO_ENTITIES, type CopiedLintProject } from "./lint-sources-doubles.js";

const PREFIX = "lint-command-";
const AT = "2026-01-02T03:04:05.678Z";
const EXTRA = "wiki/topics/extra.md";
const CITED = "This body is long enough to count as a page and it cites its source. ^[a.md]";
const page = (title: string, front = "summary: A summary.", body = CITED): string => `---\ntitle: ${title}\n${front}\n---\n\n${body}\n`;
const FILES: Record<string, string> = {
  [`${CONCEPTS_DIR}/alpha.md`]: page("Alpha", undefined, "Alpha is long enough to count as a page and links to [[Missing Page]] and [[Real Title]]. ^[a.md]"),
  [`${CONCEPTS_DIR}/real-slug.md`]: page("Real Title"),
  [`${CONCEPTS_DIR}/shaky.md`]: page("Shaky", "summary: A summary.\nconfidence: 0.2"),
  [EXTRA]: page("Extra", undefined, "A page outside the generic directories, linking [[Missing Wide]]. ^[a.md]"),
  [`${SOURCES_DIR}/a.md`]: "A source.\n",
};

/** One run of the command: every printed line, every exit code requested, and the cache text afterwards (`null` when there is none). */
interface Ran { lines: string[]; exits: number[]; cache: string | null }
/** What the disk command did on each of the three paths. */
interface OnDisk { real: string; flat: Ran; tiered: Ran; preview: Ran }
const FLAT: LintCommandOptions = {};
const TIERED: LintCommandOptions = { tiered: true };
const PREVIEW: LintCommandOptions = { fixPreview: true };
/** The header is two printed lines, and the root wrapper prints it, not the body. */
const HEADER_LINES = 2;

const tracker = tempRootTracker();
let project: Minted<OnDisk>;

/** Record printing and exit requests into `events`, in order, for as long as the spies stand. Nothing exits. */
function watchTerminal(events: string[], lines: string[], exits: number[]): void {
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => { lines.push(args.join(" ")); events.push("print"); });
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => { exits.push(code ?? 0); events.push(`exit ${code}`); }) as never);
}

/** Run the real root-taking command once in `root`, from no cache, and keep what it printed, requested and wrote. */
async function ranOnDisk(root: string, options: LintCommandOptions): Promise<Ran> {
  const lines: string[] = [];
  const exits: number[] = [];
  await rm(path.join(root, LAST_LINT_FILE), { force: true });
  watchTerminal([], lines, exits);
  await lintCommand(options);
  vi.restoreAllMocks();
  return { lines, exits, cache: await readFile(path.join(root, LAST_LINT_FILE), "utf8").catch(() => null) };
}

/** With the working directory at `root`, ask the disk command on all three paths, then put the working directory back. */
async function askedOnDisk(root: string): Promise<OnDisk> {
  const cwd = process.cwd();
  process.chdir(root);
  try {
    return { real: await realpath(root), flat: await ranOnDisk(root, FLAT), tiered: await ranOnDisk(root, TIERED), preview: await ranOnDisk(root, PREVIEW) };
  } finally {
    process.chdir(cwd);
  }
}

mintOnceThenRemove(tracker, async () => {
  setSystemTime(new Date(AT));
  project = await mintCopied(tracker, PREFIX, (root) => writeFiles(root, FILES), askedOnDisk);
});
afterAll(() => { setSystemTime(); });

/** The cache over a map: each call logged, a write kept or refused. Relative paths are taken from the project's real root, as the disk command's are. */
function cacheOver(events: string[], written: Map<string, string>, refusal?: Error): LintCacheSources {
  return {
    makeDirectoryTree: async (relDir) => { events.push(`cache.mkdir ${relDir}`); },
    writeAtomic: async (relPath, text) => {
      events.push(`cache.write ${relPath}`);
      if (refusal !== undefined) throw refusal;
      written.set(relPath, text);
    },
    readText: unasked("cache.readText"),
    projectRelative: (file) => path.relative(project.onDisk.real, file),
  };
}

/** One in-memory run and everything it left: the ordered events, and what a disk run leaves. */
interface InMemory extends Ran { events: string[]; failure: unknown }

/** Run the command's body over the copy. Pages are reported under the real root, where the disk command's working directory was. */
async function ranInMemory(options: LintCommandOptions, over: { lint?: Partial<LintSources>; refusal?: Error } = {}): Promise<InMemory> {
  const events: string[] = [];
  const lines: string[] = [];
  const exits: number[] = [];
  const written = new Map<string, string>();
  const reported: CopiedLintProject = { ...project, dir: project.onDisk.real };
  const sources: LintCommandSources = {
    lint: lintSourcesOver(reported, events, NO_ENTITIES, over.lint), cache: cacheOver(events, written, over.refusal),
  };
  watchTerminal(events, lines, exits);
  const failure = await lintCommandFrom(sources, options).then(() => undefined, (error: unknown) => error);
  return { events, lines, exits, cache: written.get(LAST_LINT_FILE) ?? null, failure };
}

const FIRST_SCHEMA_PATH = `schema ${LLMWIKI_DIR}/schema.json`;
const afterHeader = (ran: Ran): string[] => ran.lines.slice(HEADER_LINES);
const printedAndLeft = (ran: Ran): unknown[] => [ran.lines, ran.exits, ran.cache];

describe("the lint command over a copied project, with the directory gone", () => {
  it("L1 runs after the minting directory was removed, and the disk command printed its header first", () => {
    expectRemovedDefaultCopies([project], PREFIX);
    expect(project.onDisk.flat.lines[0]).toContain("Linting wiki");
    expect(project.onDisk.flat.lines[HEADER_LINES]).toContain("Schema: defaults (no schema file)");
    expect([project.onDisk.flat.exits, project.onDisk.tiered.exits, project.onDisk.preview.exits]).toEqual([[1], [1], []]);
    expect(project.onDisk.preview.cache).toBeNull();
  });

  it("L2 flat: prints, writes the cache and requests the exit exactly as the disk command did", async () => {
    const ran = await ranInMemory(FLAT);
    expect(ran.failure).toBeUndefined();
    expect(printedAndLeft(ran)).toEqual([afterHeader(project.onDisk.flat), [1], project.onDisk.flat.cache]);
    expect(ran.lines.filter((line) => line.includes("Missing Wide"))).toEqual([]);
    expect(ran.lines.at(-1)).toContain("2 error(s)");
    expect(JSON.parse(ran.cache ?? "null")).toMatchObject({ errors: 2, warnings: 1, at: AT });
  });

  it("L3 flat: loads the schema twice, prints everything before the cache is touched, and exits last", async () => {
    const { events } = await ranInMemory(FLAT);
    expect(events[0]).toBe(FIRST_SCHEMA_PATH);
    expect(countOf(events, FIRST_SCHEMA_PATH)).toBe(2);
    expect(events.indexOf("print")).toBeLessThan(events.indexOf(FIRST_SCHEMA_PATH, 1));
    expect(events.lastIndexOf("print")).toBeLessThan(events.indexOf(`cache.mkdir ${LLMWIKI_DIR}`));
    expect(events.slice(-3)).toEqual([`cache.mkdir ${LLMWIKI_DIR}`, `cache.write ${LAST_LINT_FILE}`, "exit 1"]);
    expect(countOf(events, `page ${EXTRA}`)).toBe(0);
  });

  it("L4 tiered: prints the three tiers under the wiki-wide scope and writes the flat cache, as the disk command did", async () => {
    const ran = await ranInMemory(TIERED);
    expect(ran.failure).toBeUndefined();
    expect(printedAndLeft(ran)).toEqual([afterHeader(project.onDisk.tiered), [1], project.onDisk.tiered.cache]);
    expect(ran.lines.filter((line) => line.includes("Missing Wide"))).toHaveLength(1);
    expect(ran.lines.at(-1)).toContain("3 deterministic error(s)");
    expect(countOf(ran.events, `page ${EXTRA}`)).toBe(1);
    expect(ran.events.slice(-3)).toEqual([`cache.mkdir ${LLMWIKI_DIR}`, `cache.write ${LAST_LINT_FILE}`, "exit 1"]);
    expect(JSON.parse(ran.cache ?? "null")).toMatchObject({ errors: 3, warnings: 1, at: AT });
  });

  it("L5 fix-preview: prints the plan the disk command printed, touches no cache, requests no exit and loads the schema once", async () => {
    const ran = await ranInMemory(PREVIEW);
    expect(ran.failure).toBeUndefined();
    expect(printedAndLeft(ran)).toEqual([afterHeader(project.onDisk.preview), [], null]);
    expect(ran.lines.filter((line) => line.includes("[1] "))).toHaveLength(1);
    expect(ran.lines.at(-1)).toContain("1 deterministic fix(es) previewed, 2 recommendation(s). Nothing was written.");
    expect(ran.events.filter((event) => event.startsWith("cache."))).toEqual([]);
    expect(countOf(ran.events, FIRST_SCHEMA_PATH)).toBe(1);
    expect(countOf(ran.events, `page ${EXTRA}`)).toBe(1);
  });

  it("L6 fix-preview wins over tiered when both are asked", async () => {
    const ran = await ranInMemory({ tiered: true, fixPreview: true });
    expect(printedAndLeft(ran)).toEqual([afterHeader(project.onDisk.preview), [], null]);
  });

  it("L7 rejects with the cache write's own error after the whole report was printed, and requests no exit", async () => {
    const refusal = new Error("planted cache write failure");
    const ran = await ranInMemory(FLAT, { refusal });
    expect(ran.failure).toBe(refusal);
    expect(ran.lines).toEqual(afterHeader(project.onDisk.flat));
    expect([ran.exits, ran.cache]).toEqual([[], null]);
    expect(ran.events.at(-1)).toBe(`cache.write ${LAST_LINT_FILE}`);
  });

  it("L8 rejects with the schema read's own error before anything is printed or any path is chosen", async () => {
    const failure = new Error("planted schema read failure");
    const schema = { exists: async () => true, readText: async () => { throw failure; } } as unknown as LintSources["schema"];
    const ran = await ranInMemory(TIERED, { lint: { schema } });
    expect(ran.failure).toBe(failure);
    expect([ran.lines, ran.exits, ran.events]).toEqual([[], [], []]);
  });

  it("L9 refuses fix-propose before anything is read, printed or staged, whatever else is asked", async () => {
    const asked: LintCommandOptions[] = [{ fixPropose: 1 }, { fixPropose: 1, fixPreview: true, tiered: true }];
    for (const options of asked) {
      const ran = await ranInMemory(options);
      expect(ran.failure).toBeInstanceOf(Error);
      expect((ran.failure as Error).message).toContain("--fix-propose runs only through lintCommand");
      expect([ran.lines, ran.exits, ran.events, ran.cache]).toEqual([[], [], [], null]);
    }
  });
});
