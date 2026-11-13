/**
 * @file test/storage/typed-viewer-binding.test.ts
 * @description The viewer's typed pages, entity pages and relation reads over
 * their sources. This file uses `collectTypedViewerInputsFrom`,
 * `collectEntityPagesFrom`, `readRelationRecordsFrom` and
 * `readLiveValidRelationsFrom`, which exist only after those readers were given
 * sources to read through, so it has NO before-edit run.
 *
 * There is no project directory. Four in-memory doubles decide nothing:
 * `binding` and `profile` (no binding leaf; a legacy profile's text, or none),
 * `scans` (the existing entity-scan binding: a directory, its names, an entry,
 * its text) and `graph` (the graph-store read).
 *
 * WHAT IS LOGGED. Every method of every double, the methods of the directory
 * object a scan hands back included, logs to ONE shared, ordered log BEFORE it
 * returns or throws, under its group name. The typed path makes its calls one
 * after another, so the whole log is asserted in order.
 *
 * The production readers run on what the doubles serve: the default-profile
 * gate, declaration order, the invalid-page filter, the edge projection, "any
 * relation failure is no edges", the relation store's header, checksum and
 * latest-per-id rules, and WHICH ERROR a link or an oversize store becomes. The
 * graph double never chooses that error: it throws what the reader's own
 * configuration builds.
 *
 * NOT SHOWN HERE: how the local disk confines the graph directory, opens the
 * store without following a link, or scans a directory. The relation-store disk
 * tests, `viewer-snapshot-typed-graph.test.ts` and
 * `profile-viewer-legacy.test.ts` show that on real files.
 *
 * The doubles are not a hosted store, not an access-control layer and not
 * `ProjectStore`.
 */

import { describe, expect, it } from "bun:test";
import { collectEntityPagesFrom, EntityCollectError } from "../../src/profile/collect.js";
import { DEFAULT_PROFILE } from "../../src/profile/default.js";
import type { EffectiveProfileSources } from "../../src/profile/load.js";
import type { ProfilePack } from "../../src/profile/types.js";
import { readLiveValidRelationsFrom } from "../../src/relations/live-valid.js";
import { readRelationRecordsFrom } from "../../src/relations/store-read.js";
import { recordChecksum } from "../../src/relations/store-record.js";
import { RelationStoreCorruptError, RelationStoreSymlinkError, type RelationRef } from "../../src/relations/types.js";
import type { LegacyLocalEntityScans } from "../../src/storage/legacy-local-reads.js";
import { GraphDirConfinementError, type GraphStoreReadConfig, type GraphStoreReads } from "../../src/utils/jsonl-store.js";
import { collectTypedViewerInputsFrom } from "../../src/viewer/typed-pages.js";
import { noBindingLeafDouble } from "../fixtures/no-binding-leaf-double.js";

const LAB = {
  schemaVersion: 1, profileId: "lab", displayName: "Lab",
  entities: {
    tasks: { directory: "wiki/tasks", requiredFields: ["title"], fields: { title: { type: "string" } } },
    experiments: { directory: "wiki/experiments" }, ideas: { directory: "wiki/ideas" },
  },
  relations: { tests: { from: ["experiments"], to: ["ideas"], direction: "directed" } },
};
const PAGES: Record<string, Record<string, string>> = {
  "wiki/tasks": { "untitled.md": "No frontmatter.\n", "do-it.md": "---\ntitle: Do it\n---\nBody.\n", "notes.txt": "not a page" },
  "wiki/experiments": { "a.md": "---\ntitle: A\n---\nRun.\n" },
  "wiki/ideas": { "b.md": "---\ntitle: B\n---\nThink.\n" },
};
/** One relation record line with its real checksum. */
const record = (id: string, type: string, from: string, to: string): string => {
  const ref = { id, type, from, to, attributes: {}, contentHash: "c" } as unknown as RelationRef;
  return JSON.stringify({ ...ref, checksum: recordChecksum(ref) });
};
const STORE = [
  JSON.stringify({ kind: "relation-store-header", schemaVersion: 1 }),
  record("rel_one", "tests", "experiments/a", "ideas/b"), record("rel_two", "retired", "experiments/a", "ideas/b"),
].join("\n") + "\n";

/** What the graph double does when read: serve text or `null`, or throw one of four things. */
type GraphAnswer = string | null | "link" | "oversize" | Error;

interface Held { profileText?: string; graph?: GraphAnswer }

/** The effective-profile sources: no binding leaf, and a legacy profile when `text` is given. */
function profileOf(text: string | undefined, note: (call: string) => void): EffectiveProfileSources {
  const absent = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  const binding = noBindingLeafDouble(note);
  return {
    activeProduct: { root: "/display/only/project", binding, packages: {} } as unknown as EffectiveProfileSources["activeProduct"],
    readPrivateLeafText: async (dir, name, maxBytes) => {
      note(`profile.readPrivateLeafText ${dir}/${name} max=${maxBytes}`);
      return text === undefined ? { kind: "not-opened", error: absent } : { kind: "text", text };
    },
  };
}

/** The entity-scan binding over {@link PAGES}; the directory it hands back logs its own methods. */
function scansOf(note: (call: string) => void): LegacyLocalEntityScans {
  return {
    openEntityDirectory: async (relDir) => {
      note(`scans.openEntityDirectory ${relDir}`);
      const held = PAGES[relDir]!;
      return { status: "ok", directory: {
        listNames: async () => { note(`scans.directory.listNames ${relDir}`); return Object.keys(held); },
        resolveEntry: async (name) => { note(`scans.directory.resolveEntry ${relDir}/${name}`); return `mem:${relDir}/${name}`; },
        readPrefix: async (entry, maxBytes) => { note(`scans.directory.readPrefix ${entry} max=${maxBytes}`); return Buffer.from(held[entry.slice(`mem:${relDir}/`.length)]!).subarray(0, maxBytes); },
        readText: async (entry) => { note(`scans.directory.readText ${entry}`); return held[entry.slice(`mem:${relDir}/`.length)]!; },
      } };
    },
  };
}

/** The graph-store read. For a link or an oversize store it throws what the CALLER'S configuration builds. */
function graphOf(answer: GraphAnswer, note: (call: string) => void): GraphStoreReads {
  return { readStore: async (config: GraphStoreReadConfig) => {
    note(`graph.readStore ${config.fileName} max=${config.maxBytes}`);
    if (answer === "link") throw config.makeSymlinkError("store file is a symlink");
    if (answer === "oversize") throw config.makeOversizeError(config.maxBytes + 1);
    if (answer instanceof Error) throw answer;
    return answer;
  } };
}

/** All four groups over one shared log. */
function sourcesOf(held: Held = {}) {
  const calls: string[] = [];
  const note = (call: string): void => { calls.push(call); };
  const graph = graphOf(held.graph === undefined ? STORE : held.graph, note);
  return { sources: { profile: profileOf(held.profileText, note), scans: scansOf(note), graph }, graph, calls };
}

const PROFILE_CALLS = ["binding.readBindingLeaf max=65536", "binding.resolvePrivateDir", "profile.readPrivateLeafText mem:private/profile.json max=1048576"];
const GRAPH_CALL = "graph.readStore relations.jsonl max=67108864";
/** The scan calls for one directory: open, list, then resolve and read each `.md` name in listing order. */
const scanCalls = (relDir: string): string[] => [
  `scans.openEntityDirectory ${relDir}`, `scans.directory.listNames ${relDir}`,
  ...Object.keys(PAGES[relDir]!).filter((name) => name.endsWith(".md"))
    .flatMap((name) => [`scans.directory.resolveEntry ${relDir}/${name}`, `scans.directory.readText mem:${relDir}/${name}`]),
];

describe("the viewer's typed pages over their sources", () => {
  it("T1 answers undefined for the built-in default profile and asks no scan or graph read", async () => {
    const { sources, calls } = sourcesOf();
    expect(await collectTypedViewerInputsFrom(sources)).toBeUndefined();
    expect(calls).toEqual(PROFILE_CALLS);
  });

  it("T2 scans declared directories in declaration order, drops the invalid page, and reads the relations last", async () => {
    const { sources, calls } = sourcesOf({ profileText: JSON.stringify(LAB) });
    const typed = await collectTypedViewerInputsFrom(sources);
    expect(typed?.entityTypes).toEqual(["tasks", "experiments", "ideas"]);
    expect(typed?.pages.map((page) => page.id)).toEqual(["tasks/do-it", "experiments/a", "ideas/b"]);
    expect(typed?.graph.entityPages?.map((node) => node.id)).toEqual(["tasks/do-it", "experiments/a", "ideas/b"]);
    expect(typed?.graph.relations).toEqual([{ type: "tests", from: "experiments/a", to: "ideas/b", direction: "directed" }]);
    expect(calls).toEqual([...PROFILE_CALLS, ...scanCalls("wiki/tasks"), ...scanCalls("wiki/experiments"), ...scanCalls("wiki/ideas"), GRAPH_CALL]);
  });

  it.each([
    ["an unconfined graph directory", new GraphDirConfinementError("graph directory rejected")], ["a linked store", "link"],
    ["an oversize store", "oversize"], ["any other failure", new Error("EIO: read refused")], ["no store", null],
  ] as const)("T3 gives no edges for %s and still returns the pages", async (_label, graph) => {
    const { sources, calls } = sourcesOf({ profileText: JSON.stringify(LAB), graph });
    const typed = await collectTypedViewerInputsFrom(sources);
    expect([typed?.graph.relations, typed?.pages.length, calls.at(-1)]).toEqual([[], 3, GRAPH_CALL]);
  });
});

describe("the relation reads over a graph-store read", () => {
  it("T4 reads every record in file order and keeps only relations the profile still declares", async () => {
    const { graph, calls } = sourcesOf();
    expect((await readRelationRecordsFrom(graph)).records.map((bound) => bound.ref.id)).toEqual(["rel_one", "rel_two"]);
    expect((await readLiveValidRelationsFrom(graph, LAB as unknown as ProfilePack)).map((rel) => rel.id)).toEqual(["rel_one"]);
    expect(await readRelationRecordsFrom(sourcesOf({ graph: null }).graph)).toEqual({ records: [], problems: [] });
    expect(calls).toEqual([GRAPH_CALL, GRAPH_CALL]);
  });

  it("T5 turns a link and an oversize store into the relation store's own errors, built by its own configuration", async () => {
    const link = await readRelationRecordsFrom(sourcesOf({ graph: "link" }).graph).catch((error: unknown) => error);
    const oversize = await readRelationRecordsFrom(sourcesOf({ graph: "oversize" }).graph).catch((error: unknown) => error);
    expect(link).toBeInstanceOf(RelationStoreSymlinkError);
    expect(oversize).toBeInstanceOf(RelationStoreCorruptError);
    expect((oversize as Error).message).toContain("store file 67108865 bytes exceeds the 67108864-byte cap");
  });

  it("T6 rejects with the mechanism's own confinement error, and with any other error, as the same object", async () => {
    const confinement = new GraphDirConfinementError("graph directory rejected");
    const raw = new Error("EIO: read refused");
    await expect(readRelationRecordsFrom(sourcesOf({ graph: confinement }).graph)).rejects.toBe(confinement);
    await expect(readLiveValidRelationsFrom(sourcesOf({ graph: raw }).graph, LAB as unknown as ProfilePack)).rejects.toBe(raw);
  });
});

describe("entity pages over the entity-scan binding", () => {
  it("T7 throws for the default profile before any scan", async () => {
    const { sources, calls } = sourcesOf();
    await expect(collectEntityPagesFrom(sources.scans, DEFAULT_PROFILE)).rejects.toBeInstanceOf(EntityCollectError);
    expect(calls).toEqual([]);
  });

  it("T8 keeps a field-violating page as a page and reports it as a problem", async () => {
    const { sources } = sourcesOf();
    const { pages, problems } = await collectEntityPagesFrom(sources.scans, LAB as unknown as ProfilePack);
    expect(pages.map((page) => page.id)).toEqual(["tasks/untitled", "tasks/do-it", "experiments/a", "ideas/b"]);
    expect(problems.map((problem) => [problem.kind, problem.entityType])).toEqual([["field-violation", "tasks"]]);
  });
});
