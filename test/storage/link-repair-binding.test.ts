/**
 * @file test/storage/link-repair-binding.test.ts
 * @description The WHOLE read-and-plan link repair pass, `repairLinksFrom`,
 * with no project directory: both page listings, every page read, the pending
 * candidate records, and the writes it plans. It exists only after the pass
 * was given sources of its own, so this file has NO before-edit run.
 *
 * HOW IT IS BUILT. Two projects are minted on real disk, once. The wiki has
 * concept and query pages and three pending candidates persisted by the real
 * `writeCandidate`: one typed, two default. The bare project has a pending
 * candidate and NO page. The real `repairLinks(root)` plans each project's
 * writes, the trees are copied into memory, and the directories are removed
 * before any case runs. See `copied-project.ts`.
 *
 * WHAT RUNS FOR REAL IN MEMORY. The whole pass: the listing order and its
 * failure rule, the `.md` filter, the dropped-page policy, the return before
 * the pending read, the real tolerant candidate list and its typed-candidate
 * rule over the RAW candidate records, the real resolver, the body rewrite and
 * the write planning. The inputs are raw page texts, raw listings and raw
 * candidate records. No repaired text and no slug set is copied in: the pass
 * plans writes and writes nothing, so the copies hold the pages as seeded, and
 * L1 shows it.
 *
 * WHAT IS COMPARED. The writes planned in memory against the writes the disk
 * pass planned, deeply and byte for byte, and against bodies written out here.
 *
 * WHAT IT DOES NOT SHOW. Nothing about APPLYING the writes: `repairAndApplyLinks`
 * still takes a root and writes through the journalled page writer under the
 * caller's lock. Nothing here shows what the disk decides: confinement, links,
 * special files or no-follow opens. A double cannot make a real read drop, so
 * L9 is ONE real disk case, a concept page that is a link to a file outside
 * the concept directory, through the default binding, and nothing wider.
 *
 * The doubles are not a hosted store, not an access-control layer and not
 * `ProjectStore`.
 */

import { symlink } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "bun:test";
import { writeCandidate } from "../../src/compiler/candidates.js";
import type { CompilePageWrite } from "../../src/compiler/compile-write.js";
import { repairLinks, repairLinksFrom, type LinkRepairSources } from "../../src/compiler/link-repair.js";
import type { LegacyLocalRecordDirs } from "../../src/storage/legacy-local-record-dirs.js";
import type { LegacyLocalReads } from "../../src/storage/legacy-local-reads.js";
import { CANDIDATES_DIR, CONCEPTS_DIR, QUERIES_DIR } from "../../src/utils/constants.js";
import * as output from "../../src/utils/output.js";
import { tempRootTracker } from "../temp-roots.js";
import { enoent, heldText, mintCopied, mintOnceThenRemove, pageScanOf, unasked, writeFiles, type Copy, type Minted } from "./copied-project.js";
import { expectMintingDirectoryRemoved } from "./minted-directory.js";

const PREFIX = "link-repair-";
const ARGO = "argo-cd-image-update-ownership-model";
const FRONT = "---\ntitle: Deployment\nsummary: \"See [[Argo CD]] here\"\n---\n\n";
/** Every rule in one body: two repairs, a fenced link, the four refusals, a mixed-case target, and text a replacement pattern would mangle. */
const DEPLOYMENT_BODY = [
  "Managed by [[Argo CD]] and [[Argo CD|the tool]]. Costs $& more.", "", "```md", "[[Argo CD]]", "```", "",
  "Typed [[Paper Notes]]; pending [[Kube Ops]]; exact [[Queue]]; both [[Shared Name]]; blank [[Blank Page]]; registry [[Tool Registry]].", "",
].join("\n");
const REPAIRED_BODY = DEPLOYMENT_BODY
  .replace("[[Argo CD]] and [[Argo CD|the tool]]", `[[${ARGO}|Argo CD]] and [[${ARGO}|the tool]]`)
  .replace("[[Paper Notes]]", "[[paper-notes-archive|Paper Notes]]")
  .replace("[[Tool Registry]]", "[[tool-registry-surface|Tool Registry]]");

const tracker = tempRootTracker();
let wiki: Minted<CompilePageWrite[]>;
let bare: Minted<CompilePageWrite[]>;

/** A default pending candidate, or a typed one when `typed` names its entity type. */
const pend = (root: string, slug: string, typed?: string): Promise<unknown> =>
  writeCandidate(root, { slug, title: slug, summary: "Pending", sources: [], body: "Pending body.", ...(typed ? { targetEntityType: typed } : {}) });

/**
 * Concept and query pages, a file that is not a page, an empty page, one slug
 * live in BOTH namespaces, and three pending candidates: a typed one that
 * would make `paper-notes` ambiguous if it counted, a default one that does
 * make `kube-ops` ambiguous, and a default one named exactly `queue`.
 */
async function seedWiki(root: string): Promise<void> {
  await writeFiles(root, {
    [`${CONCEPTS_DIR}/${ARGO}.md`]: "Details.\n", [`${CONCEPTS_DIR}/deployment.md`]: FRONT + DEPLOYMENT_BODY,
    [`${CONCEPTS_DIR}/paper-notes-archive.md`]: "Archive.\n", [`${CONCEPTS_DIR}/kube-ops-guide.md`]: "Guide.\n",
    [`${CONCEPTS_DIR}/queue-workers.md`]: "Workers.\n", [`${CONCEPTS_DIR}/shared-name-guide.md`]: "Concept.\n",
    [`${CONCEPTS_DIR}/blank-page-one.md`]: "", [`${CONCEPTS_DIR}/blank-page-two.md`]: "Two.\n",
    [`${CONCEPTS_DIR}/Tool-Registry-Surface.md`]: "Surface.\n", [`${CONCEPTS_DIR}/notes.txt`]: "Not a page: [[Argo CD]].\n",
    [`${QUERIES_DIR}/shared-name-guide.md`]: "Query.\n", [`${QUERIES_DIR}/saved-answer.md`]: "See [[Argo CD]].\n",
  });
  await pend(root, "paper-notes-draft", "papers");
  await pend(root, "kube-ops-runbook");
  await pend(root, "queue");
}

/** A concept directory holding no page, no query directory, and one pending candidate. */
async function seedBare(root: string): Promise<void> {
  await writeFiles(root, { [`${CONCEPTS_DIR}/notes.txt`]: "Not a page.\n" });
  await pend(root, "waiting");
}

mintOnceThenRemove(tracker, async () => {
  wiki = await mintCopied(tracker, PREFIX, seedWiki, repairLinks);
  bare = await mintCopied(tracker, PREFIX, seedBare, repairLinks);
});

/** One pass over a copy: its sources, and every call and status report in order. */
interface Pass { log: string[]; sources: LinkRepairSources }
/** Page reads that stand in for some of a pass's own, given those and the pass's log. */
type Replaced = (pages: LegacyLocalReads, log: string[]) => Partial<LegacyLocalReads>;

/** Record each status report in `log` as `status <icon> <message>`, in place among the reads. */
const recordStatusInto = (log: string[]): void => { vi.spyOn(output, "status").mockImplementation((icon, message) => { log.push(`status ${icon} ${message}`); }); };

/** The candidate records over the copy: the directory when the copy lists it, and each leaf's raw text. */
function candidateRecordsOf(copy: Copy, log: string[]): LegacyLocalRecordDirs {
  return {
    directory: async (relDir) => {
      log.push(`directory ${relDir}`);
      const held = copy.listings.get(relDir);
      return held === undefined ? null : { exists: async () => true, listEntries: async () => held };
    },
    leaf: async (relDir, fileName) => {
      const rel = `${relDir}/${fileName}`;
      return { location: `memory:${rel}`, readText: async () => { log.push(`leaf ${rel}`); return heldText(copy, rel); } };
    },
  };
}

/**
 * The sources of one pass over `copy`. A page read answers the held text; a
 * no-follow look answers `file` for a held path and rejects as an absent path
 * does otherwise. `replaced` swaps in other page reads. Status reports are
 * recorded in the same log as `status <icon> <message>`.
 */
function passOver(copy: Copy, replaced: Replaced = () => ({})): Pass {
  const log: string[] = [];
  const scan = (relDir: string) => pageScanOf(copy, relDir, (call) => { log.push(call); });
  const pages: LegacyLocalReads = {
    listNames: (relDir) => scan(relDir).listNames(),
    readConfinedPage: (relDir, slug) => scan(relDir).readPage(slug),
    statNoFollow: async (rel) => { log.push(`stat ${rel}`); if (!copy.files.has(rel)) throw enoent(); return "file"; },
    readText: unasked("readText"), exists: unasked("exists"), realDirectory: unasked("realDirectory"),
    readConfinedFile: unasked("readConfinedFile"), locate: unasked("locate"),
  };
  recordStatusInto(log);
  return { log, sources: { pages: { ...pages, ...replaced(pages, log) }, candidates: candidateRecordsOf(copy, log) } };
}

/** The deployment page's read answers `dropped`; with `presence`, the no-follow look rejects with it. */
const droppingDeployment = (presence?: Error): Replaced => (pages, log) => ({
  readConfinedPage: async (relDir, slug) => {
    if (relDir !== CONCEPTS_DIR || slug !== "deployment") return pages.readConfinedPage(relDir, slug);
    log.push(`page ${relDir}/${slug}`);
    return { dropped: "escapes-dir" };
  },
  ...(presence ? { statNoFollow: async (rel: string) => { log.push(`stat ${rel}`); throw presence; } } : {}),
});

/** The reads one page directory of the wiki costs: its listing, then one read per `.md` name in the order the disk listed them. */
const readsOf = (relDir: string): string[] => [`list ${relDir}`, ...wiki.copy.listings.get(relDir)!
  .map((entry) => entry.name).filter((name) => name.endsWith(".md")).map((name) => `page ${relDir}/${name.slice(0, -3)}`)];
const DEPLOYMENT_FILE = path.join(CONCEPTS_DIR, "deployment.md");
const refused = (): Error => Object.assign(new Error("EACCES: refused"), { code: "EACCES" });

describe("link repair planning over copied projects, with the directories gone", () => {
  it("L1 runs after both minting directories were removed, on copies holding the pages as seeded and the raw candidate records", () => {
    for (const minted of [wiki, bare]) expectMintingDirectoryRemoved(minted.dir, PREFIX);
    expect(wiki.copy.files.get(`${CONCEPTS_DIR}/deployment.md`)).toBe(FRONT + DEPLOYMENT_BODY);
    expect(wiki.copy.files.get(`${QUERIES_DIR}/saved-answer.md`)).toBe("See [[Argo CD]].\n");
    const records = wiki.copy.listings.get(CANDIDATES_DIR)!.filter((entry) => entry.kind === "file" && entry.name.endsWith(".json"))
      .map((entry) => JSON.parse(heldText(wiki.copy, `${CANDIDATES_DIR}/${entry.name}`)) as Record<string, unknown>);
    expect(records.map((record) => [record.slug, record.targetEntityType]).sort()).toEqual([["kube-ops-runbook", undefined], ["paper-notes-draft", "papers"], ["queue", undefined]]);
  });

  it("L2 plans exactly the writes the disk pass planned, for the wiki and for the project with no page", async () => {
    expect(await repairLinksFrom(passOver(wiki.copy).sources)).toEqual(wiki.onDisk);
    expect(await repairLinksFrom(passOver(bare.copy).sources)).toEqual(bare.onDisk);
  });

  it("L3 repairs unique prefixes only: aliases, frontmatter, fenced text and `$&` kept; typed pending ignored; pending, exact-pending, two-namespace and empty-page ambiguity refused; the query page written to queries", async () => {
    expect(await repairLinksFrom(passOver(wiki.copy).sources)).toEqual([
      { namespace: "concepts", slug: "deployment", body: FRONT + REPAIRED_BODY },
      { namespace: "queries", slug: "saved-answer", body: `See [[${ARGO}|Argo CD]].\n` },
    ]);
  });
});

describe("the reads a link repair pass makes, and when", () => {
  it("L4 lists concepts and reads each .md page in listing order, then queries, then the candidate records, and reports the count last", async () => {
    const { sources, log } = passOver(wiki.copy);
    await repairLinksFrom(sources);
    const pages = [...readsOf(CONCEPTS_DIR), ...readsOf(QUERIES_DIR)];
    const [records, report] = [log.slice(pages.length + 1, -1), log.at(-1)!];
    expect([log.slice(0, pages.length + 1), pages.length]).toEqual([[...pages, `directory ${CANDIDATES_DIR}`], 13]);
    expect([records.length > 0, records.filter((call) => !call.startsWith(`leaf ${CANDIDATES_DIR}/`))]).toEqual([true, []]);
    expect([report.startsWith("status 🔗 "), report.includes("Repaired 5 wikilink(s) in 2 page(s)")]).toEqual([true, true]);
  });

  it("L5 returns no write for a project with no page BEFORE the pending candidates are read, treating the missing query directory as empty", async () => {
    const { sources, log } = passOver(bare.copy);
    expect(await repairLinksFrom(sources)).toEqual([]);
    expect([log, bare.copy.listings.has(CANDIDATES_DIR), bare.copy.listings.has(QUERIES_DIR)]).toEqual([[`list ${CONCEPTS_DIR}`, `list ${QUERIES_DIR}`], true, false]);
  });

  it("L6 fails the pass with the listing's own error when a listing fails for any reason but absence, reading no candidate", async () => {
    const fault = refused();
    const { sources, log } = passOver(wiki.copy, (pages, calls) => ({ listNames: async (relDir) => {
      if (relDir !== QUERIES_DIR) return pages.listNames(relDir);
      calls.push(`list ${relDir}`);
      throw fault;
    } }));
    await expect(repairLinksFrom(sources)).rejects.toBe(fault);
    expect(log).toEqual([...readsOf(CONCEPTS_DIR), `list ${QUERIES_DIR}`]);
  });

  it("L7 warns once about a dropped page that is physically there, naming its directory-qualified path, before the next read, and plans the rest", async () => {
    const { sources, log } = passOver(wiki.copy, droppingDeployment());
    expect(await repairLinksFrom(sources)).toEqual([wiki.onDisk[1]]);
    const warnings = log.filter((call) => call.startsWith("status ! "));
    expect([warnings.length, warnings[0]!.includes(`Dropped wiki read (escapes-dir): ${DEPLOYMENT_FILE} — `)]).toEqual([1, true]);
    const at = log.indexOf(`page ${CONCEPTS_DIR}/deployment`);
    expect(log.slice(at, at + 3)).toEqual([`page ${CONCEPTS_DIR}/deployment`, `stat ${DEPLOYMENT_FILE}`, warnings[0]]);
    expect(log.slice(0, at + 1)).toEqual(readsOf(CONCEPTS_DIR).slice(0, at + 1));
  });

  it.each([{ look: "absent", presence: enoent() }, { look: "refused", presence: refused() }])("L8 does NOT warn about a dropped page when the no-follow look is $look, and carries on", async ({ presence }) => {
    const { sources, log } = passOver(wiki.copy, droppingDeployment(presence));
    expect(await repairLinksFrom(sources)).toEqual([wiki.onDisk[1]]);
    expect([log.filter((call) => call.startsWith("status ! ")), log.filter((call) => call.startsWith("stat "))]).toEqual([[], [`stat ${DEPLOYMENT_FILE}`]]);
  });
});

describe("link repair planning on real disk, through the default binding", () => {
  it("L9 drops a concept page that links outside the concept directory, warns once naming its directory-qualified path, and plans no write from the linked text", async () => {
    const root = await tracker.create(PREFIX);
    const escape = path.join(CONCEPTS_DIR, "escape.md");
    await writeFiles(root, { [`${CONCEPTS_DIR}/argo-cd-guide.md`]: "Details.\n", "elsewhere.md": "Secret [[Argo CD]].\n" });
    await symlink(path.join(root, "elsewhere.md"), path.join(root, escape));
    const reports: string[] = [];
    recordStatusInto(reports);
    expect(await repairLinks(root)).toEqual([]);
    expect(reports).toEqual([expect.stringContaining(`Dropped wiki read (escapes-dir): ${escape} — `)]);
    expect(reports[0]!.startsWith("status ! ")).toBe(true);
  });
});
