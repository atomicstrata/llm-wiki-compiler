/**
 * @file test/storage/page-read-binding.test.ts
 * @description The WHOLE page-read consumers, `getPageFrom` and
 * `listPagesFrom`, with no project directory. Both exist only after the page
 * functions were given reads of their own, so this file has NO before-edit run.
 *
 * HOW IT IS BUILT. Three projects are minted on real disk, once: a wiki with
 * seven concept and query pages (one archived, one orphaned, one untitled, one
 * empty file), an empty directory, and a typed project with a legacy custom
 * profile. The real `listPages(root, …)` and
 * `getPage(root, …)` answer a fixed set of requests on disk, the trees are
 * copied into memory, and the directories are removed before any case runs.
 * Each case then asks the same request of the root-free body over the copy and
 * requires the answer the disk gave. See `copied-project.ts`.
 *
 * WHAT RUNS FOR REAL IN MEMORY. Both bodies, and under `listPagesFrom` the REAL
 * lower bodies: the page scan, the non-default-profile gate, the entity-page
 * collection with its problem views, and the journal health warning. The
 * filters, the sort, the cursors and the page shape are the production code's.
 * No answer is replayed or written by hand.
 *
 * WHAT THE DOUBLES DECIDE. `readPageText` answers a held page's text and the
 * empty string for a page the copy does not hold: that is the read's stated
 * contract, and the only failure this suite can show is absence.
 *
 * TWO PROFILE SITUATIONS, AND NO MORE. The wiki and the empty project have the
 * built-in default profile: the entity collection is never asked, and P9 shows
 * it. The typed project has a LEGACY CUSTOM PROFILE (`.llmwiki/profile.json`)
 * and NO active product binding: the profile text is loaded and validated for
 * real, its one entity directory is scanned and validated for real, and the
 * collector's problems are mapped to views for real. That is ALL the typed
 * cases show. They say nothing about an active product package, lifecycle or
 * provenance, relations, events, or any authority or access control.
 *
 * NOT SHOWN HERE: anything the local disk decides. That the body re-read
 * follows links and is not confined, what a link, a directory or a failed read
 * becomes, a dropped page and an existing journal are shown only by the disk
 * tests (`pages/list.test.ts`, `storage/read-surface-reads.test.ts`,
 * `journal-health-surfaces.test.ts`).
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { scanWikiPagesFrom } from "../../src/compiler/indexgen.js";
import {
  getPage, getPageFrom, listPages, listPagesFrom,
  type ListPagesOptions, type ListPagesResult, type Page, type PageDirectory, type PageReads, type PageRef,
} from "../../src/pages/list.js";
import {
  collectEntityPagesWithMessagesFrom, loadNonDefaultProfileFrom, type EntityPagesWithMessagesSources,
} from "../../src/profile/block.js";
import { EntityCollectError } from "../../src/profile/collect.js";
import { DEFAULT_PROFILE } from "../../src/profile/default.js";
import { journalHealthWarningFrom } from "../../src/trust/journal-health-warning.js";
import { CONCEPTS_DIR, PROFILE_FILE, QUERIES_DIR } from "../../src/utils/constants.js";
import { PathSafetyError } from "../../src/viewer/path-safety.js";
import { SAMPLE_PROFILE } from "../fixtures/profile-fixtures.js";
import { tempRootTracker } from "../temp-roots.js";
import {
  absentJournalOf, countOf, effectiveProfileOf, entityScansOf, expectRemovedDefaultCopies, expectRemovedLegacyProfileCopies, mintCopied,
  pageScanOf, stepsOf, writeFiles, type Copy, type Minted, type Note,
} from "./copied-project.js";

const PREFIX = "page-read-";
/** The path the typed project's doubles give as the project's real root; entry locators and problem paths are made from it. */
const REAL_ROOT = "/copied/project";
const NOTES_DIR = "wiki/notes";
const RELATIVE: Record<PageDirectory, string> = { concepts: CONCEPTS_DIR, queries: QUERIES_DIR };
const page = (frontmatter: string, body: string): string => `---\n${frontmatter}\n---\n\n${body}\n`;

/** The listings asked of the disk and then of the copy, in this order. */
const LISTINGS: ListPagesOptions[] = [
  {}, { includeBody: true }, { includeArchived: true }, { includeArchived: true, includeOrphaned: true },
  { limit: 2 }, { limit: 2, cursor: "2" }, { limit: 2, cursor: "4" },
];
/** The retrievals asked of the disk and then of the copy: two pages, an absent page, an empty file, a slug in the wrong directory. */
const REFS: PageRef[] = [
  { pageDirectory: "concepts", slug: "alpha" }, { pageDirectory: "queries", slug: "saved" },
  { pageDirectory: "concepts", slug: "absent" }, { pageDirectory: "concepts", slug: "empty" }, { pageDirectory: "queries", slug: "alpha" },
];
/** What the disk answered for every listing and retrieval, in the order asked. */
interface OnDisk { lists: ListPagesResult[]; gets: Array<Page | null> }

/** The typed listings asked of the disk and then of the copy, in this order. */
const TYPED_LISTINGS: ListPagesOptions[] = [
  {}, { includeBody: true }, { limit: 2 }, { limit: 2, profileCursor: "2" }, { limit: 2, problemCursor: "2" },
];

const tracker = tempRootTracker();
let wiki: Minted<OnDisk>;
let empty: Minted<OnDisk>;
let typed: Minted<ListPagesResult[]>;

/**
 * A `SAMPLE_PROFILE` project (`notes` requires a `title`): three valid notes,
 * a note with no title (a field violation; still a page), a file whose name is
 * not slug-safe and a note declaring another slug (identity problems; not
 * pages), a file that is not a page, and one concept page.
 */
function seedTyped(root: string): Promise<void> {
  const note = (index: number): string => page(`title: Note ${index}`, `Body ${index}.`);
  return writeFiles(root, {
    [PROFILE_FILE]: JSON.stringify(SAMPLE_PROFILE),
    [`${NOTES_DIR}/note-00.md`]: note(0), [`${NOTES_DIR}/note-01.md`]: note(1), [`${NOTES_DIR}/note-02.md`]: note(2),
    [`${NOTES_DIR}/untitled.md`]: page("slug: untitled", "Untitled note."),
    [`${NOTES_DIR}/Bad_Name.md`]: page("title: Bad name", "Not slug-safe."),
    [`${NOTES_DIR}/renamed.md`]: page("title: Renamed\nslug: other", "Declares another slug."),
    [`${NOTES_DIR}/README.txt`]: "Not a page.\n", [`${CONCEPTS_DIR}/alpha.md`]: page("title: Alpha", "A concept."),
  });
}

/** Ask the real disk consumer every typed listing, one after another. */
async function askTyped(root: string): Promise<ListPagesResult[]> {
  const answers: ListPagesResult[] = [];
  for (const options of TYPED_LISTINGS) answers.push(await listPages(root, options));
  return answers;
}

/** Five concept files and two queries: plain, archived, orphaned, untitled and empty; plus a file that is not a page. */
function seedWiki(root: string): Promise<void> {
  return writeFiles(root, {
    [`${CONCEPTS_DIR}/alpha.md`]: page("title: Alpha\nsummary: First.", "Links to [[beta]] and [[Saved]]."),
    [`${CONCEPTS_DIR}/beta.md`]: page("title: Beta\narchived: true", "Archived body."),
    [`${CONCEPTS_DIR}/gamma.md`]: page("title: Gamma\norphaned: true", "Orphaned body."),
    [`${CONCEPTS_DIR}/untitled.md`]: page("summary: No title.", "Untitled body."),
    [`${CONCEPTS_DIR}/empty.md`]: "", [`${CONCEPTS_DIR}/README.txt`]: "Not a page.\n",
    [`${QUERIES_DIR}/saved.md`]: page("title: Saved", "An answer citing [[alpha]]."),
    [`${QUERIES_DIR}/zeta.md`]: page("title: Zeta", "Last."),
  });
}

/** Ask the real disk consumers every listing and every retrieval, one after another. */
async function askDisk(root: string): Promise<OnDisk> {
  const answers: OnDisk = { lists: [], gets: [] };
  for (const options of LISTINGS) answers.lists.push(await listPages(root, options));
  for (const ref of REFS) answers.gets.push(await getPage(root, ref));
  return answers;
}

beforeAll(async () => {
  wiki = await mintCopied(tracker, PREFIX, seedWiki, askDisk);
  empty = await mintCopied(tracker, PREFIX, async () => {}, askDisk);
  typed = await mintCopied(tracker, PREFIX, seedTyped, askTyped);
  await tracker.cleanup();
});
afterAll(() => tracker.cleanup());

/** The entity-page sources over one copy: the real-path look answers `realRoot`, and every call is logged. */
function entitySourcesOf(copy: Copy, note: Note, realRoot: string | null = REAL_ROOT): EntityPagesWithMessagesSources {
  return { scans: entityScansOf(copy, REAL_ROOT, note), realRoot: async () => { note("realRoot"); return realRoot; }, root: REAL_ROOT };
}

/** The page reads over one copy: the real lower bodies over doubles, each call logged as `<step>:<call>`. */
function pageReadsOf(copy: Copy, log: string[] = []): PageReads {
  const note = (step: string) => (call: string): void => { log.push(`${step}:${call}`); };
  return {
    readPageText: async (dir, slug) => { note("text")(`${dir}/${slug}`); return copy.files.get(`${RELATIVE[dir]}/${slug}.md`) ?? ""; },
    scanPages: (dir) => scanWikiPagesFrom(pageScanOf(copy, RELATIVE[dir], note("scan"))),
    loadProfile: () => loadNonDefaultProfileFrom(effectiveProfileOf(copy, note("profile"))),
    collectEntityPages: (loaded) => collectEntityPagesWithMessagesFrom(entitySourcesOf(copy, note("entity")), loaded),
    journalWarning: () => journalHealthWarningFrom(absentJournalOf(note("journal"))),
  };
}

/** `<directory>/<slug>` of each listed page, in the order listed. */
const idsOf = (listing: ListPagesResult): string[] => listing.pages.map((entry) => `${entry.pageDirectory}/${entry.slug}`);
const listed = (options: ListPagesOptions): Promise<ListPagesResult> => listPagesFrom(pageReadsOf(wiki.copy), options);

describe("page listing over a copied project, with the directory gone", () => {
  it("P1 runs after both minting directories were removed, on copies holding no journal, binding leaf or profile", () => {
    expectRemovedDefaultCopies([wiki, empty], PREFIX);
  });

  it("P2 answers every listing exactly as the disk did, key for key", async () => {
    for (const [at, options] of LISTINGS.entries()) {
      const inMemory = await listed(options);
      expect(inMemory).toEqual(wiki.onDisk.lists[at]);
      expect(Object.keys(inMemory)).toEqual(Object.keys(wiki.onDisk.lists[at]!));
    }
  });

  it("P3 lists concepts then queries by slug, leaving out archived and orphaned pages unless asked", async () => {
    expect(idsOf(await listed({}))).toEqual(["concepts/alpha", "concepts/empty", "concepts/untitled", "queries/saved", "queries/zeta"]);
    expect(idsOf(await listed({ includeArchived: true }))).toContain("concepts/beta");
    expect(idsOf(await listed({ includeArchived: true }))).not.toContain("concepts/gamma");
    expect(idsOf(await listed({ includeArchived: true, includeOrphaned: true })).slice(0, 5))
      .toEqual(["concepts/alpha", "concepts/beta", "concepts/empty", "concepts/gamma", "concepts/untitled"]);
  });

  it("P4 keeps bodies off the listing unless asked, and puts one on every page when asked", async () => {
    expect((await listed({})).pages.filter((entry) => "body" in entry)).toEqual([]);
    const withBodies = (await listed({ includeBody: true })).pages;
    expect(withBodies.map((entry) => typeof entry.body)).toEqual(["string", "string", "string", "string", "string"]);
  });

  it("P5 pages by offset cursor and drops the cursor key on the last page", async () => {
    const [first, second, last] = [await listed({ limit: 2 }), await listed({ limit: 2, cursor: "2" }), await listed({ limit: 2, cursor: "4" })];
    expect([first.cursor, second.cursor, "cursor" in last]).toEqual(["2", "4", false]);
    expect([idsOf(first), idsOf(second), idsOf(last)]).toEqual([
      ["concepts/alpha", "concepts/empty"], ["concepts/untitled", "queries/saved"], ["queries/zeta"],
    ]);
  });

  it("P6 answers an empty project exactly as the disk did: no pages and no other key", async () => {
    const inMemory = await listPagesFrom(pageReadsOf(empty.copy));
    expect(inMemory).toEqual(empty.onDisk.lists[0]);
    expect([inMemory.pages, Object.keys(inMemory)]).toEqual([[], ["pages"]]);
  });
});

describe("page retrieval over a copied project, with the directory gone", () => {
  it("P7 answers every retrieval exactly as the disk did: a page with its body, or null", async () => {
    for (const [at, ref] of REFS.entries()) expect(await getPageFrom(pageReadsOf(wiki.copy), ref)).toEqual(wiki.onDisk.gets[at]);
    const [alpha, saved, ...none] = wiki.onDisk.gets;
    expect([alpha?.slug, typeof alpha?.body, saved?.pageDirectory]).toEqual(["alpha", "string", "queries"]);
    expect(none).toEqual([null, null, null]);
  });

  it("P8 refuses an unsafe slug before any read", async () => {
    const log: string[] = [];
    await expect(getPageFrom(pageReadsOf(wiki.copy, log), { pageDirectory: "concepts", slug: ".." })).rejects.toBeInstanceOf(PathSafetyError);
    expect(log).toEqual([]);
  });
});

describe("the reads the page functions make over a copy", () => {
  it("P9 scans then re-reads each directory in turn, then the profile, then the journal", async () => {
    const log: string[] = [];
    await listPagesFrom(pageReadsOf(wiki.copy, log));
    expect(stepsOf(log)).toEqual(["scan", "text", "scan", "text", "profile", "journal"]);
    expect([countOf(log, `scan:list ${CONCEPTS_DIR}`), countOf(log, `scan:list ${QUERIES_DIR}`), countOf(log, "journal:journal.open")]).toEqual([1, 1, 1]);
  });

  it("P10 re-reads every scanned page once for its body, the filtered-out pages included, with bodies not asked for", async () => {
    const log: string[] = [];
    await listPagesFrom(pageReadsOf(wiki.copy, log));
    const texts = ["concepts/alpha", "concepts/beta", "concepts/empty", "concepts/gamma", "concepts/untitled", "queries/saved", "queries/zeta"];
    expect(texts.map((id) => countOf(log, `text:${id}`))).toEqual([1, 1, 1, 1, 1, 1, 1]);
    expect(log.filter((call) => call.startsWith("text:")).length).toBe(texts.length);
  });

  it("P11 makes one read for a retrieval, and rejects a bad cursor after the page reads and before the profile and journal", async () => {
    const one: string[] = [];
    await getPageFrom(pageReadsOf(wiki.copy, one), REFS[0]!);
    expect(one).toEqual(["text:concepts/alpha"]);
    const bad: string[] = [];
    await expect(listPagesFrom(pageReadsOf(wiki.copy, bad), { cursor: "x" })).rejects.toThrow("invalid listPages cursor: x");
    expect(stepsOf(bad)).toEqual(["scan", "text", "scan", "text"]);
  });
});

describe("typed page listing over a copied legacy-profile project, with the directory gone", () => {
  const typedListing = (options: ListPagesOptions, log?: string[]): Promise<ListPagesResult> => listPagesFrom(pageReadsOf(typed.copy, log), options);
  const entityIds = (listing: ListPagesResult): string[] => listing.profile!.entityPages.map((entry) => entry.id);

  it("T1 runs after the minting directory was removed, on a copy holding the profile and no journal or binding leaf", () => {
    expectRemovedLegacyProfileCopies([typed], PREFIX);
  });

  it("T2 answers every typed listing exactly as the disk did, key for key in the profile block too", async () => {
    for (const [at, options] of TYPED_LISTINGS.entries()) {
      const inMemory = await typedListing(options);
      expect(inMemory).toEqual(typed.onDisk[at]);
      expect(Object.keys(inMemory.profile!)).toEqual(Object.keys(typed.onDisk[at]!.profile!));
    }
  });

  it("T3 lists the valid and the untitled notes by id beside the legacy concept page, and keeps the identity problems out", async () => {
    const all = await typedListing({});
    expect([idsOf(all), entityIds(all), all.profile!.total]).toEqual([
      ["concepts/alpha"], ["notes/note-00", "notes/note-01", "notes/note-02", "notes/untitled"], 4,
    ]);
    expect(all.profile!.entityPages.map((entry) => entry.title)).toEqual(["Note 0", "Note 1", "Note 2", undefined]);
    expect(all.profile!.entityPages.filter((entry) => "body" in entry || "filePath" in entry)).toEqual([]);
  });

  it("T4 reports one field problem and two identity problems, each under its project-relative path", async () => {
    const { problems, problemTotal } = (await typedListing({})).profile!;
    const seen = problems!.map((problem) => `${problem.kind} ${problem.path}`).sort();
    expect([seen, problemTotal]).toEqual([[
      `field-violation ${NOTES_DIR}/untitled.md`, `non-slug-safe-filename ${NOTES_DIR}/Bad_Name.md`, `slug-mismatch ${NOTES_DIR}/renamed.md`,
    ], 3]);
  });

  it("T5 carries bodies only when asked, and windows pages and problems by their own cursors", async () => {
    expect((await typedListing({ includeBody: true })).profile!.entityPages.map((entry) => entry.body?.trim())).toEqual(["Body 0.", "Body 1.", "Body 2.", "Untitled note."]);
    const [first, nextPages, nextProblems] = [await typedListing({ limit: 2 }), await typedListing({ limit: 2, profileCursor: "2" }), await typedListing({ limit: 2, problemCursor: "2" })];
    expect([first.profile!.cursor, first.profile!.problemCursor, entityIds(first)]).toEqual(["2", "2", ["notes/note-00", "notes/note-01"]]);
    expect([entityIds(nextPages), "cursor" in nextPages.profile!, nextPages.profile!.problems!.length]).toEqual([["notes/note-02", "notes/untitled"], false, 2]);
    expect([nextProblems.profile!.problems!.length, "problemCursor" in nextProblems.profile!, nextProblems.profile!.problemTotal]).toEqual([1, false, 3]);
  });

  it("T6 collects after the profile and before the journal, and looks up the real root once, after the last page read", async () => {
    const log: string[] = [];
    await typedListing({}, log);
    expect(stepsOf(log)).toEqual(["scan", "text", "scan", "profile", "entity", "journal"]);
    const entity = log.filter((call) => call.startsWith("entity:"));
    expect([entity[0], entity[entity.length - 1], countOf(log, "entity:realRoot")]).toEqual([`entity:open ${NOTES_DIR}`, "entity:realRoot", 1]);
    expect(entity.filter((call) => call.startsWith("entity:read ")).length).toBe(6);
  });

  it("T7 falls back to the root as given when the real root is unknown, and refuses the default profile before any read", async () => {
    const loaded = (await loadNonDefaultProfileFrom(effectiveProfileOf(typed.copy, () => {})))!;
    const log: string[] = [];
    const note: Note = (call) => { log.push(call); };
    const withoutRealRoot = await collectEntityPagesWithMessagesFrom(entitySourcesOf(typed.copy, note, null), loaded);
    expect(withoutRealRoot.problems).toEqual((await collectEntityPagesWithMessagesFrom(entitySourcesOf(typed.copy, () => {}), loaded)).problems);
    expect(log[log.length - 1]).toBe("realRoot");
    log.length = 0;
    const builtIn = { profile: DEFAULT_PROFILE, loadedFrom: null, digest: "" };
    await expect(collectEntityPagesWithMessagesFrom(entitySourcesOf(typed.copy, note), builtIn)).rejects.toBeInstanceOf(EntityCollectError);
    expect(log).toEqual([]);
  });
});
