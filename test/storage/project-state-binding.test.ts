/**
 * @file test/storage/project-state-binding.test.ts
 * @description The project-state collector over its sources. This file uses
 * `collectProjectStateFrom`, which exists only after the collector was given
 * sources to look through, so it has NO before-edit run.
 *
 * There is no project directory. All four groups of sources are in-memory
 * doubles that decide nothing: the probes, and the three storage bindings
 * (`reads`, `candidateDirs`, `records`).
 *
 * WHAT IS LOGGED. Every method these doubles expose logs its call to ONE
 * shared, ordered log BEFORE it returns or throws, under a name that starts
 * with its group: `probes.`, `reads.`, `candidateDirs.` or `records.`. That
 * includes the methods of the objects the doubles hand back: the source
 * directory's `listEntries`, the candidate directory's `exists` and
 * `listEntries`, and a candidate leaf's `readText`. So `calls` is the COMPLETE
 * record of what the collector asked of its sources, and "this group was not
 * used" is an observation, not an inference. A leaf's `location` is a plain
 * property, not a method, and is not logged. `group(name)` is that log
 * narrowed to one group; the probe assertions use `group("probes")`.
 *
 * WHAT THE ORDER ASSERTIONS CLAIM. The collector starts several reads
 * together, so calls of DIFFERENT groups interleave as the runtime schedules
 * them. This file asserts order only where the collector guarantees it: within
 * one group, the root look before everything, and the presence looks before
 * and the compile-state read after the reads between them. It asserts no
 * interleaving across groups.
 *
 * The probes also stamp each successful look with a later time than the one
 * before, so a result kept from an earlier look would show.
 *
 * The production collector runs on what the doubles serve: the broken-root
 * short circuit, which reads run and in what order, the `.md` regular-file
 * count, the lenient lint-cache parse, both staleness comparisons, every quiet
 * default, the warnings and their order, and the one read it does NOT quiet
 * (the source listing).
 *
 * NOT SHOWN HERE: how the local disk looks at a place (a following `stat`),
 * lists a directory or spells a path. `project-state-reads.test.ts` and
 * `read-observers-legacy.test.ts` show that on real files.
 *
 * `collectProjectStateFrom` and its types are exported for this test only: no
 * production caller passes sources yet. The doubles are not a hosted store, not
 * an access-control layer and not `ProjectStore`.
 */

import { describe, expect, it } from "bun:test";
import { collectProjectStateFrom } from "../../src/project/state.js";
import type { ProjectStateProbe, ProjectStateSources } from "../../src/project/state-sources.js";
import type { LegacyLocalReads } from "../../src/storage/legacy-local-reads.js";
import type { LegacyLocalRecordDirs } from "../../src/storage/legacy-local-record-dirs.js";
import type { LegacyLocalRecords } from "../../src/storage/legacy-local-records.js";

const BASE_MS = Date.parse("2026-01-02T00:00:00.000Z");
const DIRECTORY = { isDirectory: true, isFile: false };
const FILE = { isDirectory: false, isFile: true };
const LINT_CACHE = JSON.stringify({ warnings: 1, errors: 0, at: "2026-01-01T00:00:00.000Z", freshness: { stalePages: 1, orphanedPages: "many" }, extra: true });
const candidate = JSON.stringify({ id: "c1", slug: "c1", title: "C", body: "b", sources: [], summary: "", generatedAt: "2026-01-01", reviewMode: "forced" });

interface Held {
  /** What a look at the root answers; `null` is a failed look. */
  rootLook?: Omit<ProjectStateProbe, "modifiedMs"> | null;
  /** Path to what a look answers; a path not held is a failed look. */
  places?: Record<string, Omit<ProjectStateProbe, "modifiedMs">>;
  /** Directory to its entries; a directory not held makes the listing reject. */
  listings?: Record<string, Array<{ name: string; isFile: boolean }>>;
  /** The lint cache's text, or an `Error` its read rejects with. */
  cache?: string | Error;
  config?: string;
  candidates?: Error;
  state?: string;
}

type Note = (call: string) => void;

/** The probes: each look, listing and cache read is logged as `probes.<call>`. */
function probesOf(held: Held, note: Note): ProjectStateSources["probes"] {
  let looks = 0;
  const stamped = (look: Omit<ProjectStateProbe, "modifiedMs"> | null | undefined): ProjectStateProbe | null =>
    look ? { ...look, modifiedMs: BASE_MS + (looks += 1) } : null;
  return {
    probeRoot: async () => { note("probes.probeRoot"); return stamped(held.rootLook === undefined ? DIRECTORY : held.rootLook); },
    probe: async (relPath) => { note(`probes.probe ${relPath}`); return stamped(held.places?.[relPath]); },
    listEntries: async (relDir) => { note(`probes.list ${relDir}`); const entries = held.listings?.[relDir]; if (!entries) throw new Error(`no listing for ${relDir}`); return entries; },
    readText: async (relPath) => { note(`probes.readText ${relPath}`); if (held.cache instanceof Error) throw held.cache; return held.cache ?? ""; },
  };
}

/** Configuration and one flat sources directory; the directory it hands back logs its own listing. */
function readsOf(held: Held, note: Note): LegacyLocalReads {
  return {
    readText: async (relPath: string) => { note(`reads.readText ${relPath}`); if (held.config === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); return held.config; },
    realDirectory: async (relDir: string) => {
      note(`reads.realDirectory ${relDir}`);
      return { listEntries: async (prefix: string) => { note(`reads.realDirectory.listEntries ${JSON.stringify(prefix)}`); return [{ name: "notes.md", kind: "file" }, { name: "raw.pdf", kind: "file" }]; } };
    },
  } as unknown as LegacyLocalReads;
}

/** One valid pending candidate; the directory and the leaf it hands back log their own methods. */
function candidateDirsOf(held: Held, note: Note): LegacyLocalRecordDirs {
  return {
    directory: async (relDir: string) => {
      note(`candidateDirs.directory ${relDir}`);
      if (held.candidates) throw held.candidates;
      return {
        exists: async () => { note("candidateDirs.directory.exists"); return true; },
        listEntries: async () => { note("candidateDirs.directory.listEntries"); return [{ name: "c1.json", kind: "file" }]; },
      };
    },
    leaf: async (relDir: string, fileName: string) => {
      note(`candidateDirs.leaf ${relDir}/${fileName}`);
      return { location: `mem:${relDir}/${fileName}`, readText: async () => { note(`candidateDirs.leaf.readText ${relDir}/${fileName}`); return candidate; } };
    },
  } as unknown as LegacyLocalRecordDirs;
}

/** The compile state record: always there, served from `held.state` or an empty valid state. */
function recordsOf(held: Held, note: Note): LegacyLocalRecords {
  return {
    exists: async (relPath: string) => { note(`records.exists ${relPath}`); return true; },
    readTextNoFollow: async (relPath: string) => { note(`records.readTextNoFollow ${relPath}`); return held.state ?? JSON.stringify({ version: 1, indexHash: "", sources: {} }); },
  } as unknown as LegacyLocalRecords;
}

/**
 * Sources held in memory. `calls` is the complete log of all four groups, in
 * call order. `group(name)` is its entries for one group, in order, with the
 * `name.` prefix removed.
 */
function sourcesOf(held: Held): { sources: ProjectStateSources; calls: string[]; group: (name: string) => string[] } {
  const calls: string[] = [];
  const note: Note = (call) => { calls.push(call); };
  const sources: ProjectStateSources = {
    root: "/display/only/project", probes: probesOf(held, note), reads: readsOf(held, note),
    candidateDirs: candidateDirsOf(held, note), records: recordsOf(held, note),
  };
  const group = (name: string): string[] => calls.filter((call) => call.startsWith(`${name}.`)).map((call) => call.slice(name.length + 1));
  return { sources, calls, group };
}

const WHOLE: Held = {
  places: { sources: DIRECTORY, wiki: DIRECTORY, ".llmwiki": DIRECTORY, ".llmwiki/last-lint.json": FILE },
  listings: { "wiki/concepts": [{ name: "a.md", isFile: true }, { name: "b.md", isFile: true }, { name: "link.md", isFile: false }, { name: "notes.txt", isFile: true }] },
  cache: LINT_CACHE,
};
const SOURCE_LISTING = ["readText .llmwiki/config.json", "realDirectory sources", 'realDirectory.listEntries ""'];
const STATE_READ = ["exists .llmwiki/state.json", "readTextNoFollow .llmwiki/state.json"];

describe("the project-state collector over its sources", () => {
  it.each([["a failed look", null], ["a file", FILE]])("S1 for a root that is %s, takes that one look and answers the broken state", async (_label, rootLook) => {
    const { sources, calls } = sourcesOf({ ...WHOLE, rootLook });
    expect(await collectProjectStateFrom(sources)).toEqual({
      root: "/display/only/project", hasSourcesDir: false, hasWikiDir: false, hasInternalDir: false,
      sourceCount: 0, conceptCount: 0, queryCount: 0, pendingCandidates: 0, hasIndex: false,
      lint: { present: false, entry: null }, latestWikiMtimeMs: null, latestSourceMtimeMs: null,
      warnings: [{ code: "project-unreadable", message: "Project root is unreadable or could not be inspected: /display/only/project" }],
    });
    // The COMPLETE log of all four groups: no storage binding was asked anything.
    expect(calls).toEqual(["probes.probeRoot"]);
  });

  it("S2 takes its looks in this order, looking at wiki and sources a second time for their times", async () => {
    const { sources, calls, group } = sourcesOf(WHOLE);
    const state = await collectProjectStateFrom(sources);
    expect(group("probes")).toEqual([
      "probeRoot", "probe sources", "probe wiki", "probe .llmwiki",
      "list wiki/concepts", "list wiki/queries", "probe wiki/index.md",
      "probe .llmwiki/last-lint.json", "readText .llmwiki/last-lint.json", "probe wiki", "probe sources",
    ]);
    // Successful looks, in order: root 1, sources 2, wiki 3, .llmwiki 4, the cache 5, wiki 6, sources 7.
    expect([state.latestWikiMtimeMs, state.latestSourceMtimeMs]).toEqual([BASE_MS + 6, BASE_MS + 7]);
    // Each storage group was really used, in its own order. Nothing is claimed about how the groups interleave.
    expect(group("reads")).toEqual(SOURCE_LISTING);
    expect(group("candidateDirs")).toEqual([
      "directory .llmwiki/candidates", "directory.exists", "directory.listEntries",
      "leaf .llmwiki/candidates/c1.json", "leaf.readText .llmwiki/candidates/c1.json",
    ]);
    expect(group("records")).toEqual(STATE_READ);
    // Guaranteed by the collector's own sequence: the root and presence looks come first, the compile state last.
    expect(calls.slice(0, 4)).toEqual(["probes.probeRoot", "probes.probe sources", "probes.probe wiki", "probes.probe .llmwiki"]);
    expect(calls.slice(-2)).toEqual(STATE_READ.map((call) => `records.${call}`));
  });

  it("S3 counts regular .md entries of one directory, quiets a listing that rejects, and parses the cache leniently", async () => {
    const state = await collectProjectStateFrom(sourcesOf(WHOLE).sources);
    expect([state.sourceCount, state.conceptCount, state.queryCount, state.pendingCandidates, state.hasIndex]).toEqual([1, 2, 0, 1, false]);
    expect(state.lint).toEqual({ present: true, entry: { warnings: 1, errors: 0, at: "2026-01-01T00:00:00.000Z" } });
    expect(state.warnings.map((warning) => warning.code)).toEqual(["lint-cache-stale", "index-missing", "pending-candidates", "freshness-cache-stale"]);
  });

  it("S4 skips every read a failed presence look rules out, and still lists sources", async () => {
    const { sources, group } = sourcesOf({});
    const state = await collectProjectStateFrom(sources);
    expect(group("probes")).toEqual(["probeRoot", "probe sources", "probe wiki", "probe .llmwiki", "probe .llmwiki/last-lint.json"]);
    expect([group("reads"), group("candidateDirs"), group("records")]).toEqual([SOURCE_LISTING, [], STATE_READ]);
    expect([state.hasSourcesDir, state.hasWikiDir, state.hasInternalDir, state.sourceCount, state.pendingCandidates]).toEqual([false, false, false, 1, 0]);
    expect([state.lint, state.latestWikiMtimeMs, state.latestSourceMtimeMs, state.warnings]).toEqual([{ present: false, entry: null }, null, null, []]);
  });

  it("S5 quiets a cache read and a candidate count that reject, and reports a corrupt compile state", async () => {
    const held: Held = { ...WHOLE, cache: new Error("EIO: cache read refused"), candidates: new Error("candidate directory refused"), state: "{ not json" };
    const { sources, group } = sourcesOf(held);
    const state = await collectProjectStateFrom(sources);
    expect([state.lint, state.pendingCandidates]).toEqual([{ present: true, entry: null }, 0]);
    expect(state.warnings.map((warning) => warning.code)).toEqual(["lint-cache-unparseable", "index-missing", "state-unreadable"]);
    expect([group("candidateDirs"), group("records")]).toEqual([["directory .llmwiki/candidates"], STATE_READ]);
  });

  it("S6 does NOT quiet the source listing: a bad sources block rejects the collector", async () => {
    const { sources, group } = sourcesOf({ ...WHOLE, config: JSON.stringify({ version: 1, sources: { recursive: "yes" } }) });
    await expect(collectProjectStateFrom(sources)).rejects.toThrow("sources.recursive must be a boolean");
    expect(group("reads")).toEqual(["readText .llmwiki/config.json"]);
  });
});
