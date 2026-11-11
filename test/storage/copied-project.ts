/**
 * @file test/storage/copied-project.ts
 * @description What the WHOLE-CONSUMER storage tests share:
 * `status-consumer-binding.test.ts`, `page-read-binding.test.ts`,
 * `index-generation-binding.test.ts` and `moc-generation-binding.test.ts`. Each mints
 * small projects on real disk once, takes the disk's own answers, copies every
 * regular file's text and every directory listing into memory, and removes the
 * directories before any case runs. Each then runs a root-free consumer body
 * over doubles on that copy and requires the answers the disk gave.
 *
 * WHAT IS HERE. The copy and its minting: `mintCopied` copies the tree AFTER
 * the disk ask, and `mintCopiedBeforeAsk` copies it BEFORE, so a suite whose
 * ask writes can replay from the seeded state; the doubles both suites need (the
 * page-scan reads of one directory, the legacy profile leaf, and a journal
 * that is not there); the state record, the candidate record directories and
 * the sources directory the status, export and import suites read; the entity-directory scans the page suite's typed
 * project needs; the assertions the suites open with; the two readers of an
 * ordered call log; and, for the two GENERATION suites, the capture of what a
 * generator publishes, the one run of a generator body over it, and the hooks
 * that mint once and then remove the directories.
 *
 * WHAT A CAPTURED PUBLICATION IS. An array the test owns. It records the text a
 * generator hands to its publishing member, in order, and can refuse instead.
 * It is not a writer: it shows nothing about atomic replacement, confinement,
 * durability, locking or recovery, and it is not a hosted commit.
 *
 * WHAT THE DOUBLES DECIDE. Only what a copy can: whether a path is held, what
 * a directory lists, and a held file's text. Two answers do not come from the
 * copy: the profile binding leaf is `absent` (the shared `noBindingLeafDouble`)
 * and the journal is `absent`. A suite that uses them shows its copies hold
 * neither. Every double logs its call through the caller's `note` first.
 *
 * WHAT IT IS NOT. The doubles are not a hosted store, not an access-control
 * layer and not `ProjectStore`. Nothing here shows what the local disk decides:
 * confinement, links, special files, size caps or no-follow opens. It is not a
 * general test framework; it holds what those four suites need.
 */

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeAll, expect, vi } from "bun:test";
import type { WikiPageScanReads } from "../../src/compiler/indexgen.js";
import type { SourceFreshnessSources } from "../../src/freshness/index.js";
import type { EffectiveProfileSources } from "../../src/profile/load.js";
import type { LegacyLocalRecordDirs } from "../../src/storage/legacy-local-record-dirs.js";
import type { LegacyLocalEntityScans, LocalEntry } from "../../src/storage/legacy-local-reads.js";
import type { LegacyLocalRecords } from "../../src/storage/legacy-local-records.js";
import type { JournalReadSources } from "../../src/trust/journal-classify.js";
import { LLMWIKI_DIR, PROFILE_FILE, SOURCES_DIR } from "../../src/utils/constants.js";
import { noBindingLeafDouble } from "../fixtures/no-binding-leaf-double.js";
import type { TempRootTrackerV1 } from "../temp-roots.js";
import { expectMintingDirectoryRemoved } from "./minted-directory.js";

/** A project copied off disk: each regular file's text, and each directory's entries in the order the disk listed them. */
export interface Copy { files: Map<string, string>; listings: Map<string, LocalEntry[]> }
/** What one minted project left behind: where it was, what the disk answered, and its copy. */
export interface Minted<Answer> { dir: string; onDisk: Answer; copy: Copy }
/** Records one call line in a suite's ordered log. */
export type Note = (call: string) => void;
/** One generation over a copy: the generator's sources, what they published, and every call in order. */
export interface Generation<Sources> { published: string[]; log: string[]; sources: Sources }
/** The publishing member of a captured generation: log `call`, then refuse or keep `content`. */
type CapturedPublish = (call: string, content: string) => Promise<void>;

/**
 * One generation whose publication is CAPTURED. `build` makes the generator's
 * sources and is handed the generation's ordered log and its `publish`: each
 * publication logs its call line FIRST, then rejects with `refusal` when one
 * is given, and otherwise keeps the text in `published`.
 *
 * @param build - Makes the generator's sources over the shared log and the capturing publish.
 * @param refusal - When given, every publication rejects with exactly this error and keeps nothing.
 * @returns The sources, with the log they write to and the texts they published.
 */
export function captureGeneration<Sources>(build: (log: string[], publish: CapturedPublish) => Sources, refusal?: Error): Generation<Sources> {
  const published: string[] = [];
  const log: string[] = [];
  const publish: CapturedPublish = async (call, content) => {
    log.push(call);
    if (refusal) throw refusal;
    published.push(content);
  };
  return { published, log, sources: build(log, publish) };
}

/** Run a generator `body` once over a captured generation's sources, and hand that generation back. */
export async function ranGeneration<Sources>(generation: Generation<Sources>, body: (sources: Sources) => Promise<void>): Promise<Generation<Sources>> {
  await body(generation.sources);
  return generation;
}

/**
 * The hooks of a generation suite. Before any case: `mintAll`, then the
 * tracker removes every minted directory. After all cases: the tracker removes
 * whatever a case created later. After each case: every spy is restored.
 *
 * @param tracker - The suite's temp-root tracker.
 * @param mintAll - Mints the suite's projects, in the suite's own order.
 */
export function mintOnceThenRemove(tracker: TempRootTrackerV1, mintAll: () => Promise<void>): void {
  beforeAll(async () => { await mintAll(); await tracker.cleanup(); });
  afterAll(() => tracker.cleanup());
  afterEach(() => { vi.restoreAllMocks(); });
}

/** What a copy must NOT hold for the absent-journal and no-binding-leaf doubles to be true of it: the journal directory, the binding leaf, a legacy profile. */
const DEFAULT_ONLY_ABSENT = [`${LLMWIKI_DIR}/journal`, `${LLMWIKI_DIR}/active-product.json`, PROFILE_FILE];

/**
 * The case each whole-consumer suite opens with. For every minted project, in
 * the order given: its minting directory carries the suite's prefix and is
 * gone, and its copy holds no journal directory, no binding leaf and no
 * profile, as a listing or as a file.
 *
 * @param minted - Every project the suite minted.
 * @param prefix - The prefix the suite gave the temp-root tracker.
 */
export function expectRemovedDefaultCopies(minted: ReadonlyArray<Minted<unknown>>, prefix: string): void {
  expectRemovedCopiesWithout(minted, prefix, DEFAULT_ONLY_ABSENT);
}

/**
 * The opening case for projects that carry a LEGACY CUSTOM PROFILE and no
 * active product: each minting directory is gone, each copy HOLDS the profile
 * file, and each copy still holds no journal directory and no binding leaf.
 *
 * @param minted - Every legacy-profile project the suite minted.
 * @param prefix - The prefix the suite gave the temp-root tracker.
 */
export function expectRemovedLegacyProfileCopies(minted: ReadonlyArray<Minted<unknown>>, prefix: string): void {
  expectRemovedCopiesWithout(minted, prefix, DEFAULT_ONLY_ABSENT.filter((rel) => rel !== PROFILE_FILE));
  expect(minted.filter((one) => !one.copy.files.has(PROFILE_FILE))).toEqual([]);
}

/** For every minted project, in the order given: its directory carries `prefix` and is gone, and its copy holds none of `absent`, as a listing or as a file. */
function expectRemovedCopiesWithout(minted: ReadonlyArray<Minted<unknown>>, prefix: string, absent: readonly string[]): void {
  for (const one of minted) {
    expectMintingDirectoryRemoved(one.dir, prefix);
    expect(absent.filter((rel) => one.copy.listings.has(rel) || one.copy.files.has(rel))).toEqual([]);
  }
}

/** Write `files` (project-relative path to text) under `root`, creating directories as needed. */
export async function writeFiles(root: string, files: Record<string, string>): Promise<void> {
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await writeFile(path.join(root, rel), text, "utf-8");
  }
}

/** Copy the tree at `root` into memory: texts of regular files, and every directory's listing. */
async function copyTree(root: string, rel = "", copy: Copy = { files: new Map(), listings: new Map() }): Promise<Copy> {
  // Name order, as the disk adapter lists (Node's libuv sorted; Bun's readdir
  // does not). Names in one directory are unique, so no tie case.
  const entries = (await readdir(path.join(root, rel), { withFileTypes: true }))
    .sort((a, b) => (a.name < b.name ? -1 : 1));
  const kindOf = (entry: (typeof entries)[number]): LocalEntry["kind"] =>
    entry.isDirectory() ? "directory" : entry.isFile() ? "file" : entry.isSymbolicLink() ? "link" : "other";
  copy.listings.set(rel, entries.map((entry) => ({ name: entry.name, kind: kindOf(entry) })));
  for (const entry of entries) {
    const child = rel === "" ? entry.name : `${rel}/${entry.name}`;
    if (entry.isDirectory()) await copyTree(root, child, copy);
    else if (entry.isFile()) copy.files.set(child, await readFile(path.join(root, child), "utf-8"));
  }
  return copy;
}

/**
 * Mint one project with `seed`, take the disk's own answer with `ask`, then
 * copy the tree. The tracker removes the directory when the suite cleans up.
 *
 * @param tracker - The suite's temp-root tracker, which owns the directory.
 * @param prefix - The directory-name prefix the suite gives the tracker.
 * @param seed - Writes the project under the new root.
 * @param ask - Asks the real disk consumer, before the copy is taken.
 * @returns Where the project was, what the disk answered, and the copy.
 */
export async function mintCopied<Answer>(
  tracker: TempRootTrackerV1, prefix: string, seed: (root: string) => Promise<void>, ask: (root: string) => Promise<Answer>,
): Promise<Minted<Answer>> {
  const dir = await tracker.create(prefix);
  await seed(dir);
  return { dir, onDisk: await ask(dir), copy: await copyTree(dir) };
}

/**
 * {@link mintCopied} for a disk ask that WRITES: mint one project with `seed`,
 * copy the tree FIRST, then take the disk's own answer with `ask`. The copy is
 * the seeded INITIAL state, so a memory replay starts where the disk did, not
 * from what the ask left behind. The tracker removes the directory when the
 * suite cleans up.
 *
 * @param tracker - The suite's temp-root tracker, which owns the directory.
 * @param prefix - The directory-name prefix the suite gives the tracker.
 * @param seed - Writes the project under the new root.
 * @param ask - Asks the real disk consumer, after the copy is taken.
 * @returns Where the project was, what the disk answered, and the copy of its seeded state.
 */
export async function mintCopiedBeforeAsk<Answer>(
  tracker: TempRootTrackerV1, prefix: string, seed: (root: string) => Promise<void>, ask: (root: string) => Promise<Answer>,
): Promise<Minted<Answer>> {
  const dir = await tracker.create(prefix);
  await seed(dir);
  const copy = await copyTree(dir);
  return { dir, onDisk: await ask(dir), copy };
}

/** A held text as one capped leaf read: `absent` when not held, `unavailable` over `maxBytes` UTF-8 bytes, else `ok`. */
export function cappedHeldText(text: string | undefined, maxBytes: number) {
  if (text === undefined) return { kind: "absent" as const };
  return Buffer.byteLength(text) > maxBytes ? { kind: "unavailable" as const } : { kind: "ok" as const, body: text };
}

/** The error a read of a path the copy does not hold rejects with. */
export const enoent = (): Error => Object.assign(new Error("ENOENT: not held"), { code: "ENOENT" });
/** A member the journey under test never asks; asking it fails the case. */
export const unasked = (name: string) => (): never => { throw new Error(`${name} is not a read of this journey`); };

/** A held file's text; rejects as an absent file does when the copy does not hold it. */
export function heldText(copy: Copy, rel: string): string {
  const held = copy.files.get(rel);
  if (held === undefined) throw enoent();
  return held;
}

/** The scan reads of one page directory over the copy: its listing, and each page's whole text. */
export function pageScanOf(copy: Copy, relDir: string, note: Note): WikiPageScanReads {
  return {
    listNames: async () => {
      note(`list ${relDir}`);
      const held = copy.listings.get(relDir);
      if (held === undefined) throw enoent();
      return held.map((entry) => entry.name);
    },
    readPage: async (slug) => { note(`page ${relDir}/${slug}`); return { content: heldText(copy, `${relDir}/${slug}.md`) }; },
  };
}

/**
 * The entity-directory scans over the copy. A directory the copy lists opens
 * `ok`; any other is `missing`. An entry's locator is `<realRoot>/<relDir>/<name>`,
 * shaped as a resolved path is on disk, because the collector reports it as a
 * page's file path. Nothing here can answer `invalid` or refuse an entry: what
 * a link or an escaping directory becomes is decided on disk only.
 *
 * @param copy - The copied project.
 * @param realRoot - The path the suite also gives as the project's real root.
 * @param note - Records each open and each whole-text read.
 */
export function entityScansOf(copy: Copy, realRoot: string, note: Note): LegacyLocalEntityScans {
  const held = (entry: string): string => heldText(copy, entry.slice(realRoot.length + 1));
  return { openEntityDirectory: async (relDir) => {
    note(`open ${relDir}`);
    const names = copy.listings.get(relDir)?.map((entry) => entry.name);
    if (names === undefined) return { status: "missing" };
    return { status: "ok", directory: {
      listNames: async () => names,
      resolveEntry: async (name) => `${realRoot}/${relDir}/${name}`,
      readPrefix: async (entry, maxBytes) => Buffer.from(held(entry)).subarray(0, maxBytes),
      readText: async (entry) => { note(`read ${entry.slice(realRoot.length + 1)}`); return held(entry); },
    } };
  } };
}

/** The effective-profile sources over the copy: no binding leaf, and the legacy profile leaf when the copy holds one. */
export function effectiveProfileOf(copy: Copy, note: Note): EffectiveProfileSources {
  return {
    activeProduct: { root: "memory:project", binding: noBindingLeafDouble(note), packages: {} } as unknown as EffectiveProfileSources["activeProduct"],
    readPrivateLeafText: async (_dir, name) => {
      note(`leaf ${name}`);
      const rel = `${LLMWIKI_DIR}/${name}`;
      return copy.files.has(rel) ? { kind: "text", text: heldText(copy, rel) } : { kind: "not-opened", error: enoent() };
    },
  };
}

/** The state record over the copy: whether a path is held, and its text. Nothing is copied or written. */
export function recordsOf(copy: Copy, note: Note): LegacyLocalRecords {
  return {
    exists: async (rel) => { note(`exists ${rel}`); return copy.files.has(rel); },
    readTextNoFollow: async (rel) => { note(`read ${rel}`); return heldText(copy, rel); },
    copy: unasked("records.copy"), writeAtomic: unasked("records.writeAtomic"), locate: (rel) => `memory:${rel}`,
  };
}

/** The sources directory over the copy: a source is located when the copy holds it as a FILE under `sources/`, and its text is read. */
export function sourceFreshnessOf(copy: Copy, note: Note): SourceFreshnessSources {
  return { openSources: async () => { note("open"); return {
    resolveSource: async (file) => { note(`resolve ${file}`); return copy.files.has(`${SOURCES_DIR}/${file}`) ? `${SOURCES_DIR}/${file}` : null; },
    readText: async (token) => { note(`read ${token}`); return heldText(copy, token); },
  }; } };
}

/** The candidate record directories over the copy: a listed directory, its entries, and a held leaf's text. Each call is noted first. */
export function recordDirsOf(copy: Copy, note: Note): LegacyLocalRecordDirs {
  const list = (relDir: string): LocalEntry[] => { const held = copy.listings.get(relDir); if (held === undefined) throw enoent(); return held; };
  return {
    directory: async (relDir) => { note(`directory ${relDir}`); return copy.listings.has(relDir) ? { exists: async () => true, listEntries: async () => list(relDir) } : null; },
    leaf: async (relDir, fileName) => ({ location: `memory:${relDir}/${fileName}`, readText: async () => { note(`leaf ${relDir}`); return heldText(copy, `${relDir}/${fileName}`); } }),
  };
}

/** A journal that is not there. The calling suite shows its copies hold no journal directory. */
export function absentJournalOf(note: Note): JournalReadSources {
  return { openJournal: async () => { note("journal.open"); return { kind: "absent" }; } };
}

/** The steps a log of `<step>:<call>` lines passed through, in order, each named once per run of consecutive calls. */
export const stepsOf = (log: string[]): string[] => log.map((call) => call.split(":")[0]!).filter((step, at, all) => step !== all[at - 1]);
/** How many times exactly `call` was logged. */
export const countOf = (log: string[], call: string): number => log.filter((made) => made === call).length;
