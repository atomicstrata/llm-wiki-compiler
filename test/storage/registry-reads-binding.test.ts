/**
 * @file test/storage/registry-reads-binding.test.ts
 * @description The live page registry over read bindings. This file uses the
 * registry's `…From` functions and `readLiveContentHashes`, which exist only
 * after the registry was given bindings, so it has NO before-edit run and is
 * not part of the comparison in `registry-reads-legacy.test.ts`.
 *
 * B1 to B4 pass in-memory bindings. Their page text exists nowhere on disk,
 * their directories are not directories of any project, and the `…From`
 * functions take no project root, so whatever comes back can only have come
 * from the binding. B2 and B3 show the typed-page rules from BOTH sides: what
 * a surface must be offered and, more to the point, what it must never be.
 * B5 is the positive control on real files. No expectation in this file is
 * taken from the registry: records are literal and hashes are computed here
 * from the page text with the public hashing functions.
 *
 * An in-memory object here is a test double. It is not a hosted store, not an
 * access-control layer and not `ProjectStore`.
 */

import * as fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import type { LoadedProfile, ProfilePack } from "../../src/profile/types.js";
import { diskLocalEntityScans, diskLocalReads } from "../../src/storage/disk-local-reads.js";
import type { LegacyLocalEntityScans, LegacyLocalReads, LocalEntityDirectory } from "../../src/storage/legacy-local-reads.js";
import { buildEmbeddingText } from "../../src/utils/embeddings-pages.js";
import {
  buildLiveIdSetFrom, buildLiveRegistryEntry, buildNamespaceDirs, buildSurfaceEligibleCandidatesFrom,
  loadPageRecordPairsByPageIdFrom, loadPageRecordsByPageIdFrom, readLiveContentHashes, readLiveContentHashesFrom,
} from "../../src/utils/page-registry.js";
import { hashChunkText, splitIntoChunks } from "../../src/utils/retrieval.js";
import { useTempRoot } from "../fixtures/temp-root.js";

const project = useTempRoot();
const PAGE = (title: string, summary: string): string => `---\ntitle: ${title}\nsummary: ${summary}\n---\n\nBody of ${title}.\n`;
const recordOf = (slug: string, title: string, summary: string) => ({ slug, title, summary, body: `Body of ${title}.` });
const PADDED_BODY = "\n\n  First paragraph.\n\nSecond paragraph.\n\n\n";
const UNTITLED = `---\nsummary: Only a summary\n---\n${PADDED_BODY}`;
const UNTITLED_HASHES = {
  embeddingTextHash: hashChunkText(buildEmbeddingText({ title: "", summary: "Only a summary" })),
  chunkHashes: splitIntoChunks(PADDED_BODY).map(hashChunkText),
};
const titledHashes = (title: string, summary: string) => ({
  embeddingTextHash: hashChunkText(buildEmbeddingText({ title, summary })),
  chunkHashes: splitIntoChunks(`\nBody of ${title}.\n`).map(hashChunkText),
});

const PACK: ProfilePack = {
  schemaVersion: 1,
  profileId: "memory",
  entities: {
    notes: { directory: "vault/notes" },
    papers: { directory: "vault/papers", retrieval: { includeInSearch: false, includeInContext: true } },
    secrets: { directory: "vault/secrets", retrieval: { includeInSearch: false, includeInContext: false } },
    strict: { directory: "vault/strict", requiredFields: ["title"], fields: { title: { type: "string" } } },
    ghosts: { directory: "vault/ghosts" },
  },
};
const PROFILE: LoadedProfile = { profile: PACK, loadedFrom: null, digest: "" };
const DIRS = buildNamespaceDirs(PACK);
const NAMESPACES = ["concepts", "queries", "notes", "papers", "secrets", "strict", "ghosts", "nope"];

/** A memory project: directory, then page stem, then the page's whole text. */
const MEMORY: Record<string, Record<string, string>> = {
  "wiki/concepts": { "c-one": PAGE("Concept One", "cs"), orphan: "---\ntitle: Orphan\norphaned: true\n---\n\nBody.\n", untitled: UNTITLED },
  "wiki/queries": { "q-one": PAGE("Query One", "qs") },
  "vault/notes": { "n-one": PAGE("Note One", "ns"), "n-mismatch": "---\ntitle: Mismatch\nslug: other\n---\n\nBody.\n" },
  "vault/papers": { "p-one": PAGE("Paper One", "ps") },
  "vault/secrets": { "s-one": PAGE("Secret One", "ss") },
  "vault/strict": { ok: PAGE("Strict OK", "os"), bad: "---\nsummary: no title\n---\n\nBody.\n" },
};

/** Every method of the read binding except the confined page read; each throws if reached. */
function unreached(): Omit<LegacyLocalReads, "readConfinedPage"> {
  const refuse = (name: string) => (): never => { throw new Error(`${name} reached`); };
  return {
    readText: refuse("readText"), exists: refuse("exists"), statNoFollow: refuse("statNoFollow"), listNames: refuse("listNames"),
    realDirectory: refuse("realDirectory"), readConfinedFile: refuse("readConfinedFile"), locate: refuse("locate"),
  };
}

/** A read binding over {@link MEMORY} that records every confined page read it is asked for. */
function memoryReads(log: string[][]): LegacyLocalReads {
  return {
    ...unreached(),
    readConfinedPage: async (relDir, slug) => {
      log.push([relDir, slug]);
      const text = MEMORY[relDir]?.[slug];
      return text === undefined ? { dropped: "escapes-dir" } : { content: text };
    },
  };
}

/** One memory directory as the scan sees it; locators are not paths on this machine. */
function memoryDirectory(relDir: string, pages: Record<string, string>): LocalEntityDirectory {
  const textAt = (locator: string): string => pages[locator.slice(`mem://${relDir}/`.length)]!;
  return {
    listNames: async () => Object.keys(pages).map((stem) => `${stem}.md`),
    resolveEntry: async (name) => `mem://${relDir}/${name.slice(0, -3)}`,
    readPrefix: async (locator, maxBytes) => Buffer.from(textAt(locator)).subarray(0, maxBytes),
    readText: async (locator) => textAt(locator),
  };
}

/** A scan binding over {@link MEMORY} that records each directory it is asked to open. */
function memoryScans(opened: string[]): LegacyLocalEntityScans {
  return {
    openEntityDirectory: async (relDir) => {
      opened.push(relDir);
      const pages = MEMORY[relDir];
      return pages === undefined ? { status: "invalid" } : { status: "ok", directory: memoryDirectory(relDir, pages) };
    },
  };
}

describe("the live page registry over bindings", () => {
  it("B1 loads records from memory in the order given and never asks for a bad id or an unknown namespace", async () => {
    const log: string[][] = [];
    const ids = ["queries/q-one", "papers/p-one", "concepts/ghost", "../../etc/passwd", "nope/x", "concepts/c-one", "queries/q-one"];
    const query = { pageId: "queries/q-one", record: recordOf("q-one", "Query One", "qs") };
    expect(await loadPageRecordPairsByPageIdFrom(memoryReads(log), ids, DIRS)).toEqual([
      query, { pageId: "papers/p-one", record: recordOf("p-one", "Paper One", "ps") },
      { pageId: "concepts/c-one", record: recordOf("c-one", "Concept One", "cs") }, query,
    ]);
    expect(log).toEqual([["wiki/queries", "q-one"], ["vault/papers", "p-one"], ["wiki/concepts", "ghost"], ["wiki/concepts", "c-one"], ["wiki/queries", "q-one"]]);
    expect(await loadPageRecordsByPageIdFrom(memoryReads([]), ["concepts/untitled", "papers/p-one"])).toEqual([
      { slug: "untitled", title: "untitled", summary: "Only a summary", body: "First paragraph.\n\nSecond paragraph." },
    ]);
  });

  it("B2 offers each surface only its own typed pages and opens only known directories, as the profile spells them", async () => {
    const opened: string[] = [];
    const idsFor = async (surface: "search" | "context"): Promise<string[]> =>
      (await buildSurfaceEligibleCandidatesFrom(memoryScans(opened), surface, NAMESPACES, DIRS, PROFILE)).map((found) => found.pageId);
    expect(await idsFor("search")).toEqual(["concepts/c-one", "queries/q-one", "notes/n-one", "strict/ok"]);
    expect(opened).toEqual(["wiki/concepts", "wiki/queries", "vault/notes", "vault/papers", "vault/secrets", "vault/strict", "vault/ghosts"]);
    expect(await idsFor("context")).toEqual(["concepts/c-one", "queries/q-one", "notes/n-one", "papers/p-one", "strict/ok"]);
    const offered = await buildSurfaceEligibleCandidatesFrom(memoryScans([]), "search", ["queries"], DIRS, PROFILE);
    expect(offered).toEqual([{ pageId: "queries/q-one", slug: "q-one", title: "Query One", summary: "qs" }]);
  });

  it("B3 builds the live id set from memory and keeps the two no-profile rules different", async () => {
    const opened: string[] = [];
    const ids = await buildLiveIdSetFrom(memoryScans(opened), NAMESPACES, DIRS, PROFILE);
    expect([...ids].sort()).toEqual(["concepts/c-one", "notes/n-one", "papers/p-one", "queries/q-one", "strict/ok"]);
    expect(opened).toEqual(["wiki/concepts", "wiki/queries", "vault/notes", "vault/papers", "vault/secrets", "vault/strict", "vault/ghosts"]);
    const withoutProfile = await buildLiveIdSetFrom(memoryScans([]), ["notes"], DIRS);
    expect([...withoutProfile].sort()).toEqual(["notes/n-mismatch", "notes/n-one"]);
    expect(await buildSurfaceEligibleCandidatesFrom(memoryScans([]), "search", ["notes"], DIRS)).toEqual([]);
  });

  it("B4 hashes a page's raw memory text and has no hashes for a dropped page, a bad id or an unknown namespace", async () => {
    const log: string[][] = [];
    const reads = memoryReads(log);
    expect(await readLiveContentHashesFrom(reads, "concepts/untitled")).toEqual(UNTITLED_HASHES);
    expect(await readLiveContentHashesFrom(reads, "papers/p-one", DIRS)).toEqual(titledHashes("Paper One", "ps"));
    for (const pageId of ["concepts/ghost", "../../etc/passwd", "nope/x", "papers/p-one"]) expect(await readLiveContentHashesFrom(reads, pageId), pageId).toBeNull();
    expect(log).toEqual([["wiki/concepts", "untitled"], ["vault/papers", "p-one"], ["wiki/concepts", "ghost"]]);
  });

  it("B5 reads real files through the disk bindings: literal records, independent hashes, the same refusals", async () => {
    const put = async (relative: string, text: string): Promise<void> => {
      await fs.mkdir(path.dirname(path.join(project.dir, relative)), { recursive: true });
      await fs.writeFile(path.join(project.dir, relative), text);
    };
    await put("wiki/queries/b.md", PAGE("B", "sb"));
    await put("wiki/concepts/plain.md", UNTITLED);
    expect(await loadPageRecordPairsByPageIdFrom(diskLocalReads(project.dir), ["queries/b", "concepts/plain"])).toEqual([
      { pageId: "queries/b", record: recordOf("b", "B", "sb") },
      { pageId: "concepts/plain", record: { slug: "plain", title: "plain", summary: "Only a summary", body: "First paragraph.\n\nSecond paragraph." } },
    ]);
    expect(await readLiveContentHashes(project.dir, "concepts/plain")).toEqual(UNTITLED_HASHES);
    expect(await readLiveContentHashesFrom(diskLocalReads(project.dir), "queries/b")).toEqual(titledHashes("B", "sb"));
    expect(await buildLiveRegistryEntry(project.dir, "concepts/plain")).toMatchObject(UNTITLED_HASHES);
    for (const pageId of ["concepts/ghost", "nope/plain", "../../etc/passwd"]) expect(await readLiveContentHashes(project.dir, pageId), pageId).toBeNull();
    expect(await readLiveContentHashes(path.join(project.dir, "no-such-project"), "concepts/plain")).toBeNull();
    expect([...await buildLiveIdSetFrom(diskLocalEntityScans(project.dir), ["concepts", "queries"])]).toEqual(["queries/b"]);
  });
});
