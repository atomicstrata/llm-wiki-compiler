/**
 * @file test/storage/viewer-snapshot-binding.test.ts
 * @description The viewer snapshot over its sources. This file uses
 * `buildViewerSnapshotFrom`, which exists only after the snapshot was given
 * sources, so it has NO before-edit run and is not part of
 * `viewer-snapshot-legacy.test.ts`.
 *
 * The four BINDINGS are in-memory doubles: there is no project directory. They
 * hold page text, state text, candidate JSON, a configuration file and a
 * sources tree, and decide nothing. The production page collector, frontmatter
 * parser, wikilink and citation resolution, state classifier, candidate
 * admission and source selection all run on what they serve.
 *
 * The index file and source freshness are BOUND too, by two more memory
 * doubles: one serves the index text (or `null`, or a rejection), the other
 * serves source text by key. The production index mapping and the production
 * freshness body (the `ok` gate, order, hash and classification) run on what
 * they serve. Nothing here shows how the DISK finds an index or a source.
 *
 * The journal is BOUND as well, by a memory double that holds one pending
 * batch and answers every target as confined. The production health read and
 * warning mapping run on it, so the `warnings` entry is the real one. Nothing
 * here shows how the DISK resolves a journal directory or confines a target.
 *
 * Typed pages are BOUND too. Their effective-profile double has no binding
 * leaf and no private directory, so the production loader answers the built-in
 * DEFAULT profile and typed pages are `undefined`, exactly what the earlier stub
 * returned. Their graph-store double, and every method of the profile doubles
 * the default path does not use, would LOG and then throw. Typed pages scan
 * through the same `scans` double as the default pages. Typed calls are logged
 * with a `typed ` prefix. Nothing here shows a NON-default profile's typed
 * pages; `typed-viewer-binding.test.ts` does.
 *
 * The profile summary is BOUND too, over the SAME profile double. On the
 * default profile the production summary makes the two profile calls again and
 * answers `undefined`, so there is no `profile` block, exactly as the earlier
 * stub left it. Those two calls carry the `typed ` prefix because they go to
 * that same double. The summary's other doubles (events, entity pages, the real
 * path) are never reached on this path and would LOG and then throw.
 *
 * The summary's artifact health is BOUND too, by two doubles for its two
 * questions (`artifacts`, `provenance`) that are NEVER REACHED here: the
 * default profile ends the summary first, and either would LOG and then throw.
 * NOTHING HERE TESTS ARTIFACT HEALTH. `profile-summary-binding.test.ts` shows
 * when and how it asks; `artifacts/artifact-health-surfaces.test.ts` shows it
 * on real files.
 *
 * Call order: the first seven recorded calls are the six reads starting
 * together (pages open two directories; the seventh is typed pages' FIRST
 * call). Typed pages' later calls fall among the others as the runtime
 * schedules them: they are asserted as their own group, in their own order,
 * and left out of the set comparison. The last nine are freshness (it
 * opens, then resolves and reads its one source), the journal (it opens,
 * lists, reads its one batch and asks about its one target) and the profile
 * summary (its two profile calls), one after another. The calls in between
 * interleave as the runtime schedules them, so they are compared as a set.
 *
 * The doubles are test doubles. They are not a hosted store, not an
 * access-control layer and not `ProjectStore`, and nothing ties any two
 * bindings to one project.
 */

import { afterEach, describe, expect, it, vi } from "bun:test";
import type { EventReadSources } from "../../src/events/store-read.js";
import type { SourceFreshnessSources } from "../../src/freshness/index.js";
import type { EntityPageReads } from "../../src/profile/lifecycle-read.js";
import type { EffectiveProfileSources } from "../../src/profile/load.js";
import type { LegacyLocalEntityScans, LegacyLocalReads, LocalEntry } from "../../src/storage/legacy-local-reads.js";
import type { LegacyLocalRecordDirs } from "../../src/storage/legacy-local-record-dirs.js";
import type { LegacyLocalRecords } from "../../src/storage/legacy-local-records.js";
import type { JournalReadSources } from "../../src/trust/journal-classify.js";
import type { GraphStoreReads } from "../../src/utils/jsonl-store.js";
import * as output from "../../src/utils/output.js";
import { buildViewerSnapshotFrom, type ViewerSnapshotSources } from "../../src/viewer/snapshot.js";

const absent = (): Error => Object.assign(new Error("ENOENT"), { code: "ENOENT" });
/** Any method a double does not define throws, so an unexpected read cannot pass silently. */
const strict = <T extends object>(name: string, defined: Partial<T>): T =>
  new Proxy(defined as T, { get: (held, method) => Reflect.get(held, method) ?? (() => { throw new Error(`${name}.${String(method)} reached`); }) });

const PAGES: Record<string, Record<string, string>> = {
  "wiki/concepts": {
    "alpha.md": "---\ntitle: Alpha\nupdatedAt: \"2026-01-02\"\n---\n\nSee [[question]] and [[Nowhere]]. ^[notes.md] ^[missing.md]\n",
    "untitled.md": "no frontmatter at all\n",
    "notes.txt": "not a page",
  },
  "wiki/queries": { "question.md": "---\ntitle: Question\ncreatedAt: \"2026-01-03\"\n---\n\nBack to [[alpha]].\n" },
};
const STATE = JSON.stringify({ version: 1, indexHash: "", sources: { "notes.md": { hash: "h", concepts: ["alpha"], compiledAt: "t" } } });
const CONFIG = JSON.stringify({ version: 1, sources: { recursive: true, exclude: ["drafts"] } });
const TREE: Record<string, LocalEntry[]> = {
  "": [
    { name: "notes.md", kind: "file" }, { name: "raw.pdf", kind: "file" }, { name: "drafts", kind: "directory" },
    { name: "deep", kind: "directory" }, { name: "alias.md", kind: "link" },
  ],
  deep: [{ name: "inner.md", kind: "file" }],
  drafts: [{ name: "wip.md", kind: "file" }],
};
const record = (id: string): string =>
  JSON.stringify({ id, slug: id, title: id, body: "b", sources: [], summary: "", generatedAt: "2026-01-01", reviewMode: "forced" });
const QUEUE: Record<string, string> = {
  "good.json": record("good"), "malformed.json": JSON.stringify({ id: "malformed", title: "no slug" }), "broken.json": "{ not json",
};

/** Pages served as an entity-scan binding; a directory's token for an entry is `mem:<dir>/<name>`. */
function scansOf(log: string[]): LegacyLocalEntityScans {
  return {
    openEntityDirectory: async (relDir) => {
      log.push(`scans open ${relDir}`);
      const held = PAGES[relDir]!;
      const text = (token: string): string => held[token.slice(`mem:${relDir}/`.length)]!;
      return { status: "ok", directory: {
        listNames: async () => { log.push(`scans list ${relDir}`); return Object.keys(held); },
        resolveEntry: async (name) => `mem:${relDir}/${name}`,
        readPrefix: async (token, maxBytes) => Buffer.from(text(token)).subarray(0, maxBytes),
        readText: async (token) => { log.push(`scans read ${token}`); return text(token); },
      } };
    },
  };
}

/** The compile state as a records binding; `state` null means the record does not exist. */
function recordsOf(log: string[], state: string | null): LegacyLocalRecords {
  return strict<LegacyLocalRecords>("records", {
    exists: async (relPath) => { log.push(`records exists ${relPath}`); return state !== null; },
    readTextNoFollow: async (relPath) => { log.push(`records read ${relPath}`); return state!; },
  });
}

/** The pending queue as a record-directory binding; an `Error` makes resolving the directory reject. */
function queueOf(log: string[], queue: Record<string, string> | Error): LegacyLocalRecordDirs {
  return {
    directory: async (relDir) => {
      log.push(`candidates directory ${relDir}`);
      if (queue instanceof Error) throw queue;
      return { exists: async () => true, listEntries: async () => Object.keys(queue).map((name) => ({ name, kind: "file" as const })) };
    },
    leaf: async (relDir, fileName) => ({
      location: `mem:${relDir}/${fileName}`,
      readText: async () => { log.push(`candidates read ${fileName}`); return (queue as Record<string, string>)[fileName]!; },
    }),
  };
}

/** Configuration and the sources tree as a reads binding; `config` null means no configuration file. */
function readsOf(log: string[], config: string | null): LegacyLocalReads {
  return strict<LegacyLocalReads>("reads", {
    readText: async (relPath) => { log.push(`reads readText ${relPath}`); if (config === null) throw absent(); return config; },
    realDirectory: async (relDir) => {
      log.push(`reads realDirectory ${relDir}`);
      return { listEntries: async (prefix) => { log.push(`reads list ${JSON.stringify(prefix)}`); return TREE[prefix]!; } };
    },
  });
}

/** What a memory double serves for a held value: the text, or a rejection with the held `Error` itself. */
const served = (value: string | Error): string => { if (value instanceof Error) throw value; return value; };

/** Source text by key as freshness sources; a key that is not held cannot be placed, and an `Error` makes its read reject. */
function freshnessOf(log: string[], held: Record<string, string | Error>): SourceFreshnessSources {
  return { openSources: async () => {
    log.push("freshness open");
    return {
      resolveSource: async (file) => { log.push(`freshness resolve ${file}`); return file in held ? `mem:sources/${file}` : null; },
      readText: async (token) => { log.push(`freshness read ${token}`); return served(held[token.slice("mem:sources/".length)]!); },
    };
  } };
}

const PENDING_BATCH = JSON.stringify({ batchId: "pending", status: "pending", entries: [{ targetPath: "wiki/concepts/alpha.md", preState: { absent: true } }] });

/** One pending batch as journal sources; every target is answered as confined. */
function journalOf(log: string[]): JournalReadSources {
  return { openJournal: async () => {
    log.push("journal open");
    return { kind: "ok", journal: {
      listNames: async () => { log.push("journal list"); return ["pending.json"]; },
      readBatchText: async (batchId) => { log.push(`journal read ${batchId}`); return PENDING_BATCH; },
      targetConfined: async (targetPath) => { log.push(`journal confined ${targetPath}`); return true; },
    } };
  } };
}

/** A typed-pages double: a method it defines runs; any other method LOGS `typed <group>.<method> reached`, then throws. */
const typedDouble = <T extends object>(log: string[], group: string, defined: Partial<T>): T =>
  new Proxy(defined as T, { get: (held, method) => Reflect.get(held, method) ?? (() => {
    log.push(`typed ${group}.${String(method)} reached`);
    throw new Error(`typed ${group}.${String(method)} reached`);
  }) });

/** The effective profile for typed pages: no binding leaf and no private directory, so the built-in default. */
function typedProfileOf(log: string[]): EffectiveProfileSources {
  type Product = EffectiveProfileSources["activeProduct"];
  const binding = typedDouble<Product["binding"]>(log, "binding", {
    readBindingLeaf: async (maxBytes) => { log.push(`typed binding.readBindingLeaf max=${maxBytes}`); return { kind: "absent" }; },
    resolvePrivateDir: async () => { log.push("typed binding.resolvePrivateDir"); return null; },
  });
  const activeProduct: Product = { root: "/display/only/project-name", binding, packages: typedDouble<Product["packages"]>(log, "packages", {}) };
  return typedDouble<EffectiveProfileSources>(log, "profile", { activeProduct });
}

type Bound = ViewerSnapshotSources["bindings"];

interface Overrides {
  queue?: Record<string, string> | Error;
  state?: string | null;
  /** The index reader's answer: text, `null`, or an `Error` it rejects with. */
  index?: string | null | Error;
  sourceText?: Record<string, string | Error>;
}

/** Sources with memory bindings for every bound input; artifact health's two questions log and throw if reached. */
function sourcesOf(over: Overrides = {}) {
  const log: string[] = [];
  const index = over.index === undefined ? "[[alpha]] [[question]]" : over.index;
  const sources: ViewerSnapshotSources = {
    root: "/display/only/project-name",
    bindings: {
      scans: scansOf(log), records: recordsOf(log, over.state === undefined ? STATE : over.state),
      candidateDirs: queueOf(log, over.queue ?? QUEUE), reads: readsOf(log, CONFIG),
      readIndexText: async () => { log.push("index readIndexText"); return index === null ? null : served(index); },
      freshness: freshnessOf(log, over.sourceText ?? { "notes.md": "notes\n" }),
      journal: journalOf(log),
      profile: typedProfileOf(log), graph: typedDouble<GraphStoreReads>(log, "graph", {}),
      events: typedDouble<EventReadSources>(log, "events", {}), pages: typedDouble<EntityPageReads>(log, "pages", {}),
      artifacts: typedDouble<Bound["artifacts"]>(log, "artifacts", {}), provenance: typedDouble<Bound["provenance"]>(log, "provenance", {}),
      realRoot: async () => { log.push("typed realRoot reached"); throw new Error("typed realRoot reached"); },
    },
  };
  return { sources, log };
}

const STARTS = [
  "scans open wiki/concepts", "scans open wiki/queries", "scans open wiki/timeline", "records exists .llmwiki/state.json",
  "candidates directory .llmwiki/candidates", "reads readText .llmwiki/config.json", "index readIndexText", "typed binding.readBindingLeaf max=65536",
];
const MIDDLE = [
  "scans list wiki/concepts", "scans list wiki/queries", "scans list wiki/timeline", "scans read mem:wiki/concepts/alpha.md", "scans read mem:wiki/concepts/untitled.md",
  "scans read mem:wiki/queries/question.md", "records read .llmwiki/state.json", "candidates read good.json", "candidates read malformed.json",
  "candidates read broken.json", "reads realDirectory sources", 'reads list ""', 'reads list "deep"',
];
const JOURNAL = ["journal open", "journal list", "journal read pending", "journal confined wiki/concepts/alpha.md"];
/** One default-profile load, in its own order: the binding leaf, then the private directory. Typed pages make it once; the profile summary makes it again. */
const TYPED = ["typed binding.readBindingLeaf max=65536", "typed binding.resolvePrivateDir"];
const ENDS = ["freshness open", "freshness resolve notes.md", "freshness read mem:sources/notes.md", ...JOURNAL, ...TYPED];
const UNAVAILABLE = { available: false, href: "/#/index", body: "", outgoingLinks: [] };
const isTyped = (entry: string): boolean => entry.startsWith("typed ");

describe("the viewer snapshot over its sources", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it("S1 runs the real collectors, classifier, admission and selection over memory bindings", async () => {
    const notes = vi.spyOn(output, "note").mockImplementation(() => {});
    const { sources } = sourcesOf();
    const built = await buildViewerSnapshotFrom(sources);
    expect(built.root).toBe("/display/only/project-name");
    expect(built.project).toEqual({ title: "project-name", rootName: "project-name" });
    expect(built.stateStatus).toBe("ok");
    expect(built.sourceFilenames).toEqual(["deep/inner.md", "notes.md", "raw.pdf"]);
    expect(built.counts).toEqual({ concepts: 2, queries: 1, sourceFiles: 3, pendingReviews: 1, compiledSources: 1, stale: 1, orphaned: 0 });
    expect(built.pages.map((page) => [page.id, page.title, page.filePath, page.outgoingLinks, page.warnings.map((warning) => warning.code)])).toEqual([
      ["concepts/alpha", "Alpha", "mem:wiki/concepts/alpha.md", ["queries/question"], ["unresolved_citation"]],
      ["concepts/untitled", "untitled", "mem:wiki/concepts/untitled.md", [], ["missing_frontmatter", "missing_title"]],
      ["queries/question", "Question", "mem:wiki/queries/question.md", ["concepts/alpha"], []],
    ]);
    expect(built.pages[0]!.body).toBe("\nSee [[question]] and [[Nowhere]]. ^[notes.md] ^[missing.md]\n");
    expect(built.recentPages.map((page) => [page.id, page.updatedAt])).toEqual([["queries/question", "2026-01-03"], ["concepts/alpha", "2026-01-02"], ["concepts/untitled", ""]]);
    expect(built.graph.nodes.map((node) => [node.id, node.kind, node.degree])).toEqual([
      ["concepts/alpha", "concept", 2], ["concepts/untitled", "concept", 0], ["queries/question", "concept", 2], ["concepts/nowhere", "dangling", 1],
    ]);
    expect(notes.mock.calls.flat()).toEqual([
      "[llmwiki] Skipping malformed candidate file: malformed.json (missing required fields)", "[llmwiki] Skipping unparseable candidate file: broken.json",
    ]);
  });

  it("S2 maps the bound index, runs the real freshness and journal warning over memory, and leaves no profile block on the default profile", async () => {
    vi.spyOn(output, "note").mockImplementation(() => {});
    const built = await buildViewerSnapshotFrom(sourcesOf().sources);
    expect(built.index).toEqual({ available: true, href: "/#/index", body: "[[alpha]] [[question]]", outgoingLinks: ["concepts/alpha", "queries/question"] });
    expect(built.pages.map((page) => page.freshness.freshnessStatus)).toEqual(["stale", "unverified", "unverified"]);
    expect(built.warnings).toEqual([{ code: "incomplete-compile", message: "A prior project mutation did not finish; run `llmwiki recover` to recover. The wiki may reflect partial, post-crash state." }]);
    expect(["profile", "entityTypes", "pipeline", "artifactDefinitions"].filter((key) => key in built)).toEqual([]);
  });

  it("S3 starts the seven reads together in order, then runs freshness, journal and the profile summary one after another", async () => {
    vi.spyOn(output, "note").mockImplementation(() => {});
    const { sources, log } = sourcesOf();
    await buildViewerSnapshotFrom(sources);
    expect(log.slice(0, STARTS.length)).toEqual(STARTS);
    expect(log.slice(-ENDS.length)).toEqual(ENDS);
    expect([...log.slice(STARTS.length, -ENDS.length)].filter((entry) => !isTyped(entry)).sort()).toEqual([...MIDDLE].sort());
    expect(log.filter(isTyped)).toEqual([...TYPED, ...TYPED]);
    expect(log.filter((entry) => /^typed (artifacts|provenance)\./.test(entry))).toEqual([]);
  });

  it("S4 makes no freshness call for a missing and for a corrupt state", async () => {
    vi.spyOn(output, "note").mockImplementation(() => {});
    const missing = sourcesOf({ state: null });
    const built = await buildViewerSnapshotFrom(missing.sources);
    expect([built.stateStatus, built.counts.compiledSources, missing.log.slice(-6)]).toEqual(["missing", 0, [...JOURNAL, ...TYPED]]);
    expect(missing.log.filter((entry) => entry.startsWith("freshness"))).toEqual([]);
    expect(missing.log).not.toContain("records read .llmwiki/state.json");
    const corrupt = sourcesOf({ state: "{ not json" });
    expect((await buildViewerSnapshotFrom(corrupt.sources)).stateStatus).toBe("corrupt");
    expect(corrupt.log.filter((entry) => entry.startsWith("freshness"))).toEqual([]);
  });

  it("S5 rejects with the candidate directory's own error, and never reaches freshness, journal or the profile summary", async () => {
    const refused = new Error("candidate directory refused");
    const { sources, log } = sourcesOf({ queue: refused });
    await expect(buildViewerSnapshotFrom(sources)).rejects.toBe(refused);
    expect(log.slice(0, STARTS.length)).toEqual(STARTS);
    expect(log.filter((entry) => /^(freshness|journal|typed (artifacts|provenance)\.)/.test(entry))).toEqual([]);
    expect(log.filter(isTyped).length).toBeLessThanOrEqual(TYPED.length);
  });

  it("S6 maps a null index and a rejecting index reader to unavailable, and builds everything else", async () => {
    vi.spyOn(output, "note").mockImplementation(() => {});
    for (const index of [null, new Error("index refused")]) {
      const { sources, log } = sourcesOf({ index });
      const built = await buildViewerSnapshotFrom(sources);
      expect(built.index).toEqual(UNAVAILABLE);
      expect(built.pages.map((page) => page.id)).toEqual(["concepts/alpha", "concepts/untitled", "queries/question"]);
      expect(log.slice(0, STARTS.length)).toEqual(STARTS);
      expect(log.slice(-ENDS.length)).toEqual(ENDS);
    }
  });

  it("S7 counts a source that cannot be placed as gone, and rejects with a source read's own error before the journal", async () => {
    vi.spyOn(output, "note").mockImplementation(() => {});
    const gone = await buildViewerSnapshotFrom(sourcesOf({ sourceText: {} }).sources);
    expect(gone.pages.map((page) => page.freshness.freshnessStatus)).toEqual(["orphaned", "unverified", "unverified"]);
    expect([gone.counts.stale, gone.counts.orphaned]).toEqual([0, 1]);
    const refused = new Error("source read refused");
    const { sources, log } = sourcesOf({ sourceText: { "notes.md": refused } });
    await expect(buildViewerSnapshotFrom(sources)).rejects.toBe(refused);
    expect(log.slice(-3)).toEqual(ENDS.slice(0, 3));
  });
});
