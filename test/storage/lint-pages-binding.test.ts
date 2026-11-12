/**
 * @file test/storage/lint-pages-binding.test.ts
 * @description The WHOLE lint page collection, `collectAllPagesFrom`, with no
 * project directory, in BOTH scopes: the generic concept and query read, and
 * the recursive wiki-wide walk. It exists only after the collection was given
 * sources of its own, so this file has NO before-edit run.
 *
 * HOW IT IS BUILT. Two projects are minted on real disk, once: a wiki with
 * concept, query, nested, dot-named and linked entries and a directory chain
 * seven levels deep, each file holding text derived from its own path; and a
 * project with NO `wiki` directory. The real
 * `collectAllPages(root)` answers both scopes for each, the trees are copied
 * into memory, and the directories are removed before any case runs. See
 * `copied-project.ts`.
 *
 * WHAT RUNS FOR REAL IN MEMORY. The whole collection body: both scopes, the
 * existence checks, the `.md` and dot-name filters, the depth bound, what a
 * link is to the walk, the failure rules, the concurrent reads, the reported
 * paths and the final sort. The inputs are raw page texts and raw listings,
 * each entry carrying the kind the disk gave it. No collected page list is
 * copied in.
 *
 * WHAT IS COMPARED. The pages collected in memory against the pages the disk
 * collection returned, deeply: every reported path, every text and the order.
 * The reported paths are the minting directory's, which no longer exists; in
 * memory they are strings and nothing opens them.
 *
 * WHAT IT DOES NOT SHOW. What the local disk decides: what a listing's order
 * is, what a link resolves to, what a directory read as a page rejects with.
 * `lint-reads.test.ts` pins, on real files and unchanged, the listing order,
 * the raw listing and read errors, a directory read as a page, and the
 * recursive walk SKIPPING linked entries. It does NOT pin the generic scope
 * following a link, nor the existence check: those are unchanged by code
 * inspection only (the same Node call on the same path), with no live witness.
 * Nothing in this file makes a caller of the collection root-free.
 *
 * The doubles are not a hosted store, not an access-control layer and not
 * `ProjectStore`.
 */

import { symlink } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import { collectAllPages, collectAllPagesFrom, type LintPageSources } from "../../src/linter/rules-shared.js";
import { CONCEPTS_DIR, QUERIES_DIR } from "../../src/utils/constants.js";
import { tempRootTracker } from "../temp-roots.js";
import { enoent, heldText, mintCopied, mintOnceThenRemove, writeFiles, type Minted } from "./copied-project.js";
import { expectMintingDirectoryRemoved } from "./minted-directory.js";

const PREFIX = "lint-pages-";
const WIKI = "wiki";
const CHAIN = `${WIKI}/d1/d2/d3/d4/d5`;
type Page = { filePath: string; content: string };
/** What the disk collection returned for one project, per scope. */
interface Collected { generic: Page[]; wide: Page[] }

const tracker = tempRootTracker();
let wiki: Minted<Collected>;
let bare: Minted<Collected>;

/** Every page the wiki-wide scope must return, project-relative: both generic directories, a nested concept directory, a page directly under `wiki`, a nested entity directory, and the chain's sixth level. */
const WIDE_PAGES = [
  `${CONCEPTS_DIR}/a.md`, `${CONCEPTS_DIR}/b.md`, `${CONCEPTS_DIR}/nested/deep.md`, `${QUERIES_DIR}/q.md`, `${QUERIES_DIR}/r.md`,
  `${WIKI}/index.md`, `${WIKI}/research/papers/p.md`, `${CHAIN}/sixth.md`,
];
/** Planted files NO scope may return: a file that is not a page, a page in a dot-directory, a dot-named page, and a page at the seventh level. */
const NEVER_PAGES = [`${CONCEPTS_DIR}/notes.txt`, `${WIKI}/.obsidian/hidden.md`, `${WIKI}/research/.draft.md`, `${CHAIN}/d6/seventh.md`];
/** The text planted at a path: distinct per file, so a page returned with another page's text cannot pass. */
const textAt = (rel: string): string => `text of ${rel}\n`;

/** Every planted file with its own text, then a linked page and a linked directory beside the nested entity directory. */
async function seedWiki(root: string): Promise<void> {
  await writeFiles(root, Object.fromEntries([...WIDE_PAGES, ...NEVER_PAGES].map((rel) => [rel, textAt(rel)])));
  await symlink("../concepts/a.md", path.join(root, WIKI, "research", "linked.md"));
  await symlink("../concepts", path.join(root, WIKI, "research", "linkdir"));
}

/** A project with pages nowhere the collection looks: there is no `wiki` directory. */
const seedBare = (root: string): Promise<void> => writeFiles(root, { "sources/raw.md": "a source\n" });

/** The real disk collection, both scopes. */
const collectedOnDisk = async (root: string): Promise<Collected> => ({ generic: await collectAllPages(root), wide: await collectAllPages(root, "wiki-wide") });

mintOnceThenRemove(tracker, async () => {
  wiki = await mintCopied(tracker, PREFIX, seedWiki, collectedOnDisk);
  bare = await mintCopied(tracker, PREFIX, seedBare, collectedOnDisk);
});

/**
 * The sources of one collection over a minted project's copy, each call
 * logged first. A path resolves when the copy holds it as a directory or a
 * file; a listing the copy does not hold rejects as an absent directory does;
 * a reported path is where the page WAS on disk. `replaced` swaps members in.
 */
function sourcesOver(minted: Minted<Collected>, log: string[], replaced: Partial<LintPageSources> = {}): LintPageSources {
  const { copy, dir } = minted;
  const listing = (relDir: string) => { const held = copy.listings.get(relDir); if (held === undefined) throw enoent(); return held; };
  return {
    exists: async (rel) => { log.push(`exists ${rel}`); return copy.listings.has(rel) || copy.files.has(rel); },
    listNames: async (relDir) => { log.push(`names ${relDir}`); return listing(relDir).map((entry) => entry.name); },
    listEntries: async (relDir) => { log.push(`entries ${relDir}`); return listing(relDir); },
    readText: async (rel) => { log.push(`read ${rel}`); return heldText(copy, rel); },
    locate: (rel) => path.join(dir, rel),
    ...replaced,
  };
}

/** An error no source raises by itself, so seeing the same object again shows it was passed on untouched. */
const planted = (): Error => new Error("planted source failure");

/** Both scopes collected in memory over a minted project's copy. */
const collectedInMemory = async (minted: Minted<Collected>): Promise<Collected> => ({
  generic: await collectAllPagesFrom(sourcesOver(minted, [])), wide: await collectAllPagesFrom(sourcesOver(minted, []), "wiki-wide"),
});

/** The pages' paths relative to the wiki project, in the order given. */
const relative = (pages: readonly Page[]): string[] => pages.map((page) => path.relative(wiki.dir, page.filePath));
/** The `.md` names the copy's listing of `relDir` holds, in the order the disk listed them. */
const listedPages = (relDir: string): string[] => wiki.copy.listings.get(relDir)!.map((entry) => entry.name).filter((name) => name.endsWith(".md")).map((name) => `${relDir}/${name}`);

describe("lint page collection over copied projects, with the directories gone", () => {
  it("P1 runs after both minting directories were removed, on copies holding raw texts and listings that name each link as a link", () => {
    expect([wiki.copy.files.get(`${CONCEPTS_DIR}/a.md`), wiki.copy.files.get(`${CHAIN}/d6/seventh.md`), bare.copy.listings.has(WIKI)]).toEqual([textAt(`${CONCEPTS_DIR}/a.md`), textAt(`${CHAIN}/d6/seventh.md`), false]);
    const research = wiki.copy.listings.get(`${WIKI}/research`)!.map((entry) => `${entry.name}:${entry.kind}`).sort();
    expect(research).toEqual([".draft.md:file", "linkdir:link", "linked.md:link", "papers:directory"]);
    expectMintingDirectoryRemoved(wiki.dir, PREFIX);
    expectMintingDirectoryRemoved(bare.dir, PREFIX);
  });

  it("P2 collects, in both scopes, exactly the pages the disk collection returned: same reported paths, texts and order", async () => {
    expect(await collectedInMemory(wiki)).toEqual(wiki.onDisk);
    expect(await collectedInMemory(bare)).toEqual(bare.onDisk);
    expect(bare.onDisk).toEqual({ generic: [], wide: [] });
  });

  it("P3 generic: the .md names of concepts as listed, then of queries as listed, each with its own text, nothing nested and nothing sorted", async () => {
    const pages = await collectAllPagesFrom(sourcesOver(wiki, []));
    expect(relative(pages)).toEqual([...listedPages(CONCEPTS_DIR), ...listedPages(QUERIES_DIR)]);
    expect(relative(pages).sort()).toEqual([`${CONCEPTS_DIR}/a.md`, `${CONCEPTS_DIR}/b.md`, `${QUERIES_DIR}/q.md`, `${QUERIES_DIR}/r.md`]);
    expect(pages.map((page) => page.content)).toEqual(relative(pages).map(textAt));
  });

  it("P4 wiki-wide: every page to the sixth level, sorted by reported path, with no dot-name, no link, no linked directory and no seventh level", async () => {
    const pages = await collectAllPagesFrom(sourcesOver(wiki, []), "wiki-wide");
    expect(relative(pages).sort()).toEqual([...WIDE_PAGES].sort());
    expect(pages).toEqual([...pages].sort((left, right) => left.filePath.localeCompare(right.filePath)));
  });
});

describe("the order, the calls and the failures of a lint page collection", () => {
  it("P5 keeps each generic listing's order, so a reversed listing reverses that directory only, while wiki-wide sorts whatever the listings' order", async () => {
    const base = sourcesOver(wiki, []);
    const reversed: LintPageSources = {
      ...base, listNames: async (relDir) => (await base.listNames(relDir)).reverse(), listEntries: async (relDir) => [...await base.listEntries(relDir)].reverse(),
    };
    expect(relative(await collectAllPagesFrom(reversed))).toEqual([...listedPages(CONCEPTS_DIR).reverse(), ...listedPages(QUERIES_DIR).reverse()]);
    expect(await collectAllPagesFrom(reversed, "wiki-wide")).toEqual(wiki.onDisk.wide);
  });

  it("P6 generic asks, per directory in turn, whether it resolves, its names, then each page's text; with no wiki it asks only the two existence questions", async () => {
    const log: string[] = [];
    await collectAllPagesFrom(sourcesOver(wiki, log));
    const reads = (relDir: string): string[] => [`exists ${relDir}`, `names ${relDir}`, ...listedPages(relDir).map((rel) => `read ${rel}`)];
    expect(log).toEqual([...reads(CONCEPTS_DIR), ...reads(QUERIES_DIR)]);
    const none: string[] = [];
    await collectAllPagesFrom(sourcesOver(bare, none));
    expect(none).toEqual([`exists ${CONCEPTS_DIR}`, `exists ${QUERIES_DIR}`]);
  });

  it("P7 wiki-wide asks whether wiki resolves, then lists typed entries of real directories only: never a dot-directory, a linked directory or the seventh level", async () => {
    const log: string[] = [];
    await collectAllPagesFrom(sourcesOver(wiki, log), "wiki-wide");
    const listed = [WIKI, CONCEPTS_DIR, `${CONCEPTS_DIR}/nested`, QUERIES_DIR, `${WIKI}/research`, `${WIKI}/research/papers`,
      `${WIKI}/d1`, `${WIKI}/d1/d2`, `${WIKI}/d1/d2/d3`, `${WIKI}/d1/d2/d3/d4`, CHAIN];
    expect([log[0], log.filter((call) => call.startsWith("names ")), log.filter((call) => call.startsWith("exists ")).length]).toEqual([`exists ${WIKI}`, [], 1]);
    expect(log.filter((call) => call.startsWith("entries ")).sort()).toEqual(listed.map((relDir) => `entries ${relDir}`).sort());
    expect(log.filter((call) => call.startsWith("read ")).sort()).toEqual(WIDE_PAGES.map((rel) => `read ${rel}`).sort());
    const none: string[] = [];
    expect([await collectAllPagesFrom(sourcesOver(bare, none), "wiki-wide"), none]).toEqual([[], [`exists ${WIKI}`]]);
  });

  it("P8 generic rejects with the very error a listing or a page read rejects with", async () => {
    const [listingFault, readFault] = [planted(), planted()];
    const failingList = sourcesOver(wiki, [], { listNames: async () => { throw listingFault; } });
    await expect(collectAllPagesFrom(failingList)).rejects.toBe(listingFault);
    const failingRead = sourcesOver(wiki, [], { readText: async (rel) => { if (rel.endsWith("/q.md")) throw readFault; return heldText(wiki.copy, rel); } });
    await expect(collectAllPagesFrom(failingRead)).rejects.toBe(readFault);
  });

  it("P9 wiki-wide swallows one directory's listing failure and returns the other pages, but rejects with the very error a page read rejects with", async () => {
    const base = sourcesOver(wiki, []);
    const research = `${WIKI}/research`;
    const pages = await collectAllPagesFrom({ ...base, listEntries: async (relDir) => { if (relDir === research) throw planted(); return base.listEntries(relDir); } }, "wiki-wide");
    expect(pages).toEqual(wiki.onDisk.wide.filter((page) => !path.relative(wiki.dir, page.filePath).startsWith(`${research}/`)));
    expect(pages.length).toBe(WIDE_PAGES.length - 1);
    const readFault = planted();
    const failingRead = sourcesOver(wiki, [], { readText: async (rel) => { if (rel.endsWith("/p.md")) throw readFault; return heldText(wiki.copy, rel); } });
    await expect(collectAllPagesFrom(failingRead, "wiki-wide")).rejects.toBe(readFault);
  });

  it("P10 starts every page read of a directory before any of them settles, in both scopes", async () => {
    let [open, most] = [0, 0];
    const readText = async (rel: string): Promise<string> => {
      most = Math.max(most, open += 1);
      await Promise.resolve();
      open -= 1;
      return heldText(wiki.copy, rel);
    };
    await collectAllPagesFrom(sourcesOver(wiki, [], { readText }));
    expect(most).toBe(2);
    most = 0;
    await collectAllPagesFrom(sourcesOver(wiki, [], { readText }), "wiki-wide");
    expect(most).toBeGreaterThan(1);
  });
});
