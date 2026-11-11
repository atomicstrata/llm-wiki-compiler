/**
 * @file test/storage/citation-index-binding.test.ts
 * @description The strict citation index over injected sources. This file uses
 * `collectAnswerCitationIndexFrom`, which exists only after the collector was
 * given sources, so it has NO before-edit run and is not part of
 * `citation-index-legacy.test.ts`.
 *
 * N1 to N4 pass in-memory sources. There is no project and no file. The double
 * serves each page as BYTES, so the production frontmatter reader runs, and
 * serves candidate records as JSON text through a memory record-directory
 * binding, so the production candidate admission runs. The double decides
 * nothing about what is indexed: order, the page filter, identity, aliases,
 * which failures are thrown or skipped and which candidates count all come
 * from the collector. An entry is an opaque token that is NOT the listed name,
 * so a slug can only come from the listing.
 *
 * What the double does NOT show: how the local disk read classifies an open or
 * read failure, or an error the reader throws, as absent or unreadable. That
 * classification belongs to the disk read and is stated by the double, not
 * tested here.
 *
 * N1b is about request offsets on two pages only. A page with a closing fence
 * is never asked for a byte past it. A page whose fence never closes is read to
 * its end: there is NO fixed bound on such a page, and none is claimed.
 *
 * N5 is the positive control: the ROOT function on real files, with a literal
 * result. The doubles are test doubles. They are not a hosted store, not an
 * access-control layer and not `ProjectStore`.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import {
  collectAnswerCitationIndex, collectAnswerCitationIndexFrom,
  type AnswerCitationSources, type CitationProject, type StrictPageDirectory,
} from "../../src/citations/answer-index.js";
import type { PositionalBytes } from "../../src/citations/frontmatter-reader.js";
import type { LegacyLocalRecordDirs } from "../../src/storage/legacy-local-record-dirs.js";
import { useTempRoot } from "../fixtures/temp-root.js";

const disk = useTempRoot();
const fault = (code: string): Error => Object.assign(new Error(`${code}: injected`), { code });
const settled = <T>(work: Promise<T>): Promise<T | Error> => work.catch((error: Error) => error);
const entry = (id: string, slug = id.split("/")[1], aliases: string[] = []) => ({ id, pageDirectory: id.split("/")[0], slug, aliases });

/** What one listed name does: page text, or a refusal at the resolve or at the read. */
type Listed = string | { resolve: null | Error } | { read: "absent" | Error } | { rejects: Error };
/** A directory: nothing there (`null`), a fault opening it, or its listing (or listing fault) with its names in order. */
type Shelf = null | Error | { names: Error | Record<string, Listed> };
/** The pending queue: no directory (`null`), a fault resolving it, or each leaf's text or read fault, in listing order. */
type Queue = null | Error | Record<string, string | Error>;

/** Serve `text` as positional bytes, recording where each request ENDS. */
function bytesOf(text: string, ends: number[]): PositionalBytes {
  const bytes = Buffer.from(text);
  return {
    read: async (buffer, offset, length, position) => {
      ends.push(position + length);
      const served = bytes.subarray(position, position + length);
      served.copy(buffer, offset);
      return { bytesRead: served.length };
    },
  };
}

/** One memory page directory. Entry tokens are `#<dir>:<index>`, never the listed name. */
function shelfOf(relDir: string, names: Error | Record<string, Listed>, log: string[], ends: Record<string, number[]>): StrictPageDirectory {
  const listed = names instanceof Error ? [] : Object.keys(names);
  const behind = (token: string): Listed => (names as Record<string, Listed>)[listed[Number(token.split(":")[1])]!]!;
  return {
    listNames: async () => { log.push(`list ${relDir}`); if (names instanceof Error) throw names; return listed; },
    resolveEntry: async (name) => {
      log.push(`resolve ${relDir} ${name}`);
      const page = (names as Record<string, Listed>)[name]!;
      if (typeof page === "object" && "resolve" in page) { if (page.resolve) throw page.resolve; return null; }
      return `#${relDir}:${listed.indexOf(name)}`;
    },
    readEntryThrough: async (token, read) => {
      log.push(`read ${token}`);
      const page = behind(token);
      if (typeof page === "string") return { kind: "ok", value: await read(bytesOf(page, ends[token] = [])) };
      if ("rejects" in page) throw page.rejects;
      if ("read" in page && page.read !== "absent") return { kind: "unreadable", cause: page.read };
      return { kind: "absent" };
    },
  };
}

/** A memory record-directory binding over `queue`; only the pending queue's directory exists. */
function queueOf(queue: Queue, log: string[]): LegacyLocalRecordDirs {
  const leaves = queue === null || queue instanceof Error ? {} : queue;
  return {
    directory: async (relDir) => {
      log.push(`candidates ${relDir}`);
      if (queue instanceof Error) throw queue;
      if (queue === null) return null;
      return { exists: async () => true, listEntries: async () => Object.keys(leaves).map((name) => ({ name, kind: "file" as const })) };
    },
    leaf: async (relDir, fileName) => ({
      location: `memory:${relDir}/${fileName}`,
      readText: async () => { const text = leaves[fileName]!; if (text instanceof Error) throw text; return text; },
    }),
  };
}

/** Memory sources over two shelves and a queue, with the whole conversation in `log`. */
function memory(project: null | Error | { concepts: Shelf; queries: Shelf }, queue: Queue = null) {
  const log: string[] = [];
  const ends: Record<string, number[]> = {};
  const open: CitationProject["openPageDirectory"] = async (relDir) => {
    log.push(`open ${relDir}`);
    const shelf = (project as { concepts: Shelf; queries: Shelf })[relDir === "wiki/concepts" ? "concepts" : "queries"];
    if (shelf instanceof Error) throw shelf;
    return shelf && shelfOf(relDir, shelf.names, log, ends);
  };
  const sources: AnswerCitationSources = {
    resolveProject: async () => {
      log.push("project");
      if (project instanceof Error) throw project;
      return project && { openPageDirectory: open, candidateDirs: queueOf(queue, log) };
    },
  };
  return { sources, log, ends };
}

const FENCED = "---\naliases: [Zeta Alias, 42]\n---";
const UNCLOSED = "---\naliases: [Never Closed]\nmore text and no closing fence";
const CONCEPTS: Record<string, Listed> = {
  "zeta.md": `${FENCED}\n${"body ".repeat(2_000)}`, "notes.txt": "not a page", "Raw Name.md": "---\naliases: [Raw Alias]\n---",
  "alpha.md": "---\naliases: Not A List\n---\n", "broken.md": "---\naliases: [invalid\n---", "plain.md": "no frontmatter", "open.md": UNCLOSED,
};
const QUERIES: Record<string, Listed> = { "question.md": "---\naliases: [Q Alias]\n---" };
const RETAINED_START = ["project", "open wiki/concepts", "list wiki/concepts"];
const record = (id: string, generatedAt: string, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ id, slug: id, title: id, body: "b", sources: [], summary: "", generatedAt, reviewMode: "forced", ...extra });

describe("the strict citation index over injected sources", () => {
  it("N1 keeps listing order, concepts before queries, the listed name as identity and only string aliases, asking for nothing else", async () => {
    const state = memory({ concepts: { names: CONCEPTS }, queries: { names: QUERIES } });
    expect(await collectAnswerCitationIndexFrom(state.sources)).toEqual({
      retained: [
        entry("concepts/zeta", "zeta", ["Zeta Alias"]), entry("concepts/Raw Name", "Raw Name", ["Raw Alias"]), entry("concepts/alpha"),
        entry("concepts/broken"), entry("concepts/plain"), entry("concepts/open"), entry("queries/question", "question", ["Q Alias"]),
      ],
      pending: [],
    });
    const pages = [["zeta.md", 0], ["Raw Name.md", 2], ["alpha.md", 3], ["broken.md", 4], ["plain.md", 5], ["open.md", 6]];
    expect(state.log).toEqual([
      ...RETAINED_START, ...pages.flatMap(([name, index]) => [`resolve wiki/concepts ${name}`, `read #wiki/concepts:${index}`]),
      "open wiki/queries", "list wiki/queries", "resolve wiki/queries question.md", "read #wiki/queries:0", "candidates .llmwiki/candidates",
    ]);
  });

  it("N1b never asks a closed-fence page for a byte past its fence, and reads an unclosed one to its end", async () => {
    const state = memory({ concepts: { names: CONCEPTS }, queries: null });
    await collectAnswerCitationIndexFrom(state.sources);
    const fenced = state.ends["#wiki/concepts:0"]!;
    expect(fenced.every((end) => end <= Buffer.byteLength(FENCED))).toBe(true);
    expect(Math.max(...fenced)).toBe(Buffer.byteLength(FENCED));
    expect(Math.max(...state.ends["#wiki/concepts:6"]!)).toBeGreaterThan(Buffer.byteLength(UNCLOSED));
  });

  it("N2 answers empty for no project, and skips a missing directory, a vanished listing, an unresolved entry and an absent read", async () => {
    const none = memory(null, { "late.json": record("late", "t") });
    expect(await collectAnswerCitationIndexFrom(none.sources)).toEqual({ retained: [], pending: [] });
    expect(none.log).toEqual(["project"]);
    const skipping = { "gone.md": { resolve: null }, "absent.md": { read: "absent" as const }, "kept.md": "plain" };
    const partial = memory({ concepts: null, queries: { names: skipping } });
    expect((await collectAnswerCitationIndexFrom(partial.sources)).retained).toEqual([entry("queries/kept")]);
    expect(partial.log).toEqual([
      "project", "open wiki/concepts", "open wiki/queries", "list wiki/queries", "resolve wiki/queries gone.md",
      "resolve wiki/queries absent.md", "read #wiki/queries:1", "resolve wiki/queries kept.md", "read #wiki/queries:2", "candidates .llmwiki/candidates",
    ]);
    const vanished = memory({ concepts: { names: fault("ENOENT") }, queries: { names: QUERIES } });
    expect((await collectAnswerCitationIndexFrom(vanished.sources)).retained).toEqual([entry("queries/question", "question", ["Q Alias"])]);
  });

  it("N3 rejects with the very error of each genuine fault, and touches neither the queries nor the candidates after it", async () => {
    const page = (listed: Listed) => ({ concepts: { names: { "a.md": listed } }, queries: { names: QUERIES } });
    const resolved = [...RETAINED_START, "resolve wiki/concepts a.md"];
    const cases: Array<[(error: Error) => Parameters<typeof memory>[0], string[]]> = [
      [(error) => error, ["project"]],
      [(error) => ({ concepts: error, queries: { names: QUERIES } }), ["project", "open wiki/concepts"]],
      [(error) => ({ concepts: { names: error }, queries: { names: QUERIES } }), RETAINED_START],
      [(error) => page({ resolve: error }), resolved],
      [(error) => page({ read: error }), [...resolved, "read #wiki/concepts:0"]],
      [(error) => page({ rejects: error }), [...resolved, "read #wiki/concepts:0"]],
    ];
    for (const [project, log] of cases) {
      const error = fault("EIO");
      const state = memory(project(error), { "late.json": record("late", "t") });
      expect(await settled(collectAnswerCitationIndexFrom(state.sources))).toBe(error);
      expect(state.log).toEqual(log);
    }
  });

  it("N4 admits default and query candidates in generation order, by the RECORD's id, and keeps candidate faults strict", async () => {
    const empty = { concepts: null, queries: null };
    const queue: Record<string, string | Error> = {
      "late.json": record("late", "2026-01-03"), "imported.json": record("imported", "2026-01-01", { targetDirectory: "queries", slug: "query-answer" }),
      "typed.json": record("typed", "2026-01-01", { targetEntityType: "papers" }), "bad-dir.json": record("bad-dir", "2026-01-01", { targetDirectory: "papers" }),
      "raw.json": record("raw", "2026-01-01", { slug: "Raw Name" }), "empty.json": record("empty", "2026-01-01", { slug: "" }),
      "renamed.json": record("inner-id", "2026-01-02", { slug: "renamed" }), "vanished.json": fault("ENOENT"), "notes.txt": "not a candidate",
    };
    expect((await collectAnswerCitationIndexFrom(memory(empty, queue).sources)).pending).toEqual([
      { target: "query-answer", candidateId: "imported" }, { target: "renamed", candidateId: "inner-id" }, { target: "late", candidateId: "late" },
    ]);
    const unreadable = fault("EIO");
    expect(await settled(collectAnswerCitationIndexFrom(memory(empty, { "late.json": unreadable }).sources))).toBe(unreadable);
    const unresolvable = fault("EACCES");
    expect(await settled(collectAnswerCitationIndexFrom(memory(empty, unresolvable).sources))).toBe(unresolvable);
  });

  it("N5 runs the root function on real files and gets the literal index", async () => {
    await writeFile(path.join(disk.dir, "wiki/concepts/alpha.md"), "---\naliases: [Alpha Alias]\n---\nbody");
    await writeFile(path.join(disk.dir, "wiki/queries/question.md"), "no frontmatter");
    await mkdir(path.join(disk.dir, ".llmwiki/candidates"), { recursive: true });
    await writeFile(path.join(disk.dir, ".llmwiki/candidates/pending-one.json"), record("pending-one", "2026-01-01"));
    expect(await collectAnswerCitationIndex(disk.dir)).toEqual({
      retained: [entry("concepts/alpha", "alpha", ["Alpha Alias"]), entry("queries/question")],
      pending: [{ target: "pending-one", candidateId: "pending-one" }],
    });
  });
});
