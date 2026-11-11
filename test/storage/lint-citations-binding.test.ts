/**
 * @file test/storage/lint-citations-binding.test.ts
 * @description The two citation lint walkers as WHOLE consumers with no
 * project directory: `checkBrokenCitationsFrom` and
 * `checkMalformedClaimCitationsFrom`. They exist only after the walkers were
 * given sources of their own, so this file has NO before-edit run.
 *
 * HOW IT IS BUILT. One project is minted on real disk, once: pages that cite a
 * present source, an absent one, a present one that cannot be read as a file,
 * and one named with a path that climbs out of `sources/`; an imported page; a
 * query page; and a page outside the generic directories. Both root-taking
 * walkers are asked on that disk, the tree is copied into memory, and the
 * directory is removed before any case runs. See `copied-project.ts`.
 *
 * WHAT RUNS FOR REAL IN MEMORY. Each walker's one body: the real page
 * collection, the imported-page exemption, the one line-count cache of the
 * run, the real marker parsing and the per-page check. The inputs are raw page
 * texts, raw listings and raw source texts. No finding and no line count is
 * copied in, and the double decides no policy: it answers whether the copy
 * holds a path, and a held file's text, and it logs each question.
 *
 * WHAT IS COMPARED. Each walker's findings in memory against the findings its
 * root-taking form gave on disk, deeply, and against findings written out here.
 *
 * WHAT IT DOES NOT SHOW. What the local disk decides. On disk a source that is
 * a directory exists and its read rejects; here the copy holds no text for it,
 * so the read rejects too, but with the double's own error. The body treats
 * every rejected source read alike, so the finding is the same; WHICH error a
 * disk raises is not shown. A cited name is joined under `sources/` as
 * written, on disk and here alike: C3 shows that a climbing name is asked for
 * where it lands, NOT that anything stops it. The doubles are not a hosted
 * store, not an access-control layer and not `ProjectStore`.
 */

import path from "node:path";
import { describe, expect, it } from "bun:test";
import {
  checkBrokenCitations, checkBrokenCitationsFrom, checkMalformedClaimCitations, checkMalformedClaimCitationsFrom,
  type CitationLintSources, type CitedSourceReads,
} from "../../src/linter/rules-citations.js";
import type { LintPageSources } from "../../src/linter/rules-shared.js";
import type { LintResult } from "../../src/linter/types.js";
import { CONCEPTS_DIR, QUERIES_DIR, SOURCES_DIR } from "../../src/utils/constants.js";
import { tempRootTracker } from "../temp-roots.js";
import { enoent, heldText, mintCopied, mintOnceThenRemove, writeFiles, type Minted } from "./copied-project.js";
import { expectMintingDirectoryRemoved } from "./minted-directory.js";

const PREFIX = "lint-citations-";
const FIRST = `${CONCEPTS_DIR}/first.md`;
const SECOND = `${CONCEPTS_DIR}/second.md`;
const IMPORTED = `${CONCEPTS_DIR}/imported.md`;
const QUERY = `${QUERIES_DIR}/asked.md`;
/** A page whose body starts two lines after its front matter closes (line 5 for one front line, line 6 for two), one entry of `body` per line. */
const page = (front: string, body: string[]): string => `---\n${front}\n---\n\n${body.join("\n")}\n`;

/** Every planted file. `a.md` has three lines; `dir.md` is a DIRECTORY, so it exists and cannot be read as a file. */
const PLANTED: Record<string, string> = {
  [`${SOURCES_DIR}/a.md`]: "one\ntwo\nthree",
  [`${SOURCES_DIR}/bare.md`]: "never read\n",
  [`${SOURCES_DIR}/dir.md/keep.txt`]: "inside a directory\n",
  "outside.md": "beside sources, not in it\n",
  [FIRST]: page("title: First", [
    "Bare ^[bare.md] and absent ^[gone.md].",
    "In bounds ^[a.md:1-3] and ^[a.md#L2-L3], out of bounds ^[a.md:2-9].",
    "Two sources ^[a.md, gone.md:1-2].",
    "A directory ^[dir.md] and its span ^[dir.md:1].",
    "A climbing name ^[../outside.md].",
    "Malformed ^[a.md:abc].",
  ]),
  [SECOND]: page("title: Second", ["Again ^[a.md:1-2] and past the end ^[a.md:4]."]),
  [IMPORTED]: page("title: Imported\nprovenanceState: imported", ["Imported ^[gone.md], ^[only-imported.md:1] and malformed ^[a.md:xyz]."]),
  [QUERY]: page("title: Asked", ["A query cites ^[gone.md]."]),
  "wiki/topics/extra.md": page("title: Extra", ["Outside the generic directories ^[gone.md] and ^[a.md:zzz]."]),
};

/** What both root-taking walkers answered on the real disk. */
interface Answers { broken: LintResult[]; malformed: LintResult[] }
const tracker = tempRootTracker();
let wiki: Minted<Answers>;
mintOnceThenRemove(tracker, async () => {
  wiki = await mintCopied(tracker, PREFIX, (root) => writeFiles(root, PLANTED),
    async (root) => ({ broken: await checkBrokenCitations(root), malformed: await checkMalformedClaimCitations(root) }));
});

/**
 * One set of reads over the copy, serving as both the page sources and the
 * cited sources: a path resolves when the copy holds it as a file or a
 * directory, and a read answers a held file's text or rejects. Every existence
 * question and every read is logged first. `failing` makes reads of that one
 * path reject with the given error instead.
 */
function sourcesOver(log: string[] = [], failing?: { rel: string; error: Error }): CitationLintSources {
  const { copy, dir } = wiki;
  const reads: LintPageSources & CitedSourceReads = {
    exists: async (rel) => { log.push(`exists ${rel}`); return copy.files.has(rel) || copy.listings.has(rel); },
    readText: async (rel) => {
      log.push(`read ${rel}`);
      if (failing?.rel === rel) throw failing.error;
      return heldText(copy, rel);
    },
    listNames: async (relDir) => (copy.listings.get(relDir) ?? (() => { throw enoent(); })()).map((entry) => entry.name),
    listEntries: async (relDir) => copy.listings.get(relDir) ?? [],
    locate: (rel) => path.join(dir, rel),
  };
  return { pages: reads, cited: reads };
}

/** A finding as `<project-relative file>:<line> <message>`, sorted, so an expectation does not depend on listing order. */
const told = (findings: LintResult[]): string[] => findings.map((one) => `${path.relative(wiki.dir, one.file)}:${String(one.line)} ${one.message}`).sort();
const absent = (rel: string, line: number, name = "gone.md"): string => `${rel}:${line} Broken citation ^[${name}] — source file not found`;
const outOfBounds = (rel: string, line: number, span: string, lines: number): string => `${rel}:${line} Claim-level span ^[${span}] is out of bounds (source has only ${lines} lines)`;
const malformed = (rel: string, line: number, marker: string): string =>
  `${rel}:${line} Malformed claim citation ^[${marker}] — expected file.md, file.md:N-N, file.md:N,N-M,…, or file.md#LN-LN`;

describe("the citation lint walkers over a copied project, with the directory gone", () => {
  it("C1 runs after the minting directory was removed, on a copy holding every planted text and listing the directory source as a directory", () => {
    expectMintingDirectoryRemoved(wiki.dir, PREFIX);
    expect(Object.keys(PLANTED).filter((rel) => wiki.copy.files.get(rel) !== PLANTED[rel])).toEqual([]);
    expect(wiki.copy.listings.get(SOURCES_DIR)!.map((entry) => `${entry.name}:${entry.kind}`).sort()).toEqual(["a.md:file", "bare.md:file", "dir.md:directory"]);
  });

  it("C2 both bodies find exactly what their root-taking forms found on disk: rule, severity, reported file, line, message and order", async () => {
    expect(await checkBrokenCitationsFrom(sourcesOver())).toEqual(wiki.onDisk.broken);
    expect(await checkMalformedClaimCitationsFrom(sourcesOver().pages)).toEqual(wiki.onDisk.malformed);
    expect(wiki.onDisk.broken.every((one) => one.rule === "broken-citation" && one.severity === "error")).toBe(true);
  });

  it("C3 broken citations: absent sources and out-of-bounds spans in generic pages only, a directory source counted as zero lines, nothing for a climbing name that lands on a file, nothing for the imported page", async () => {
    expect(told(await checkBrokenCitationsFrom(sourcesOver()))).toEqual([
      absent(FIRST, 5), outOfBounds(FIRST, 6, "a.md:2-9", 3), absent(FIRST, 7), outOfBounds(FIRST, 8, "dir.md:1", 0),
      outOfBounds(SECOND, 5, "a.md:4", 3), absent(QUERY, 5),
    ].sort());
  });

  it("C4 malformed citations: the imported page is NOT exempt, and a page outside the generic directories is not walked", async () => {
    expect(told(await checkMalformedClaimCitationsFrom(sourcesOver().pages))).toEqual([malformed(FIRST, 10, "a.md:abc"), malformed(IMPORTED, 6, "a.md:xyz")].sort());
  });
});

describe("what the broken-citation walker asks of the cited sources, and what failures do to it", () => {
  it("C5 reads a spanned source ONCE for the whole run though two pages span it, never reads a source cited bare, and asks nothing about a source only the imported page cites", async () => {
    const log: string[] = [];
    await checkBrokenCitationsFrom(sourcesOver(log));
    const asked = (call: string): number => log.filter((made) => made === call).length;
    expect([asked(`read ${SOURCES_DIR}/a.md`), asked(`read ${SOURCES_DIR}/dir.md`)]).toEqual([1, 1]);
    expect([asked(`exists ${SOURCES_DIR}/bare.md`), asked(`read ${SOURCES_DIR}/bare.md`)]).toEqual([1, 0]);
    expect(log.filter((call) => call.includes("only-imported.md"))).toEqual([]);
    expect([asked("exists outside.md"), asked("read outside.md"), asked(`exists ${SOURCES_DIR}/gone.md`)]).toEqual([1, 0, 3]);
  });

  it("C6 counts an existing source whose read rejects as zero lines and carries on, rather than failing the run", async () => {
    const source = `${SOURCES_DIR}/a.md`;
    const findings = told(await checkBrokenCitationsFrom(sourcesOver([], { rel: source, error: new Error("planted source read failure") })));
    expect(findings.filter((line) => line.includes("^[a.md"))).toEqual([
      outOfBounds(FIRST, 6, "a.md#L2-L3", 0), outOfBounds(FIRST, 6, "a.md:1-3", 0), outOfBounds(FIRST, 6, "a.md:2-9", 0),
      outOfBounds(SECOND, 5, "a.md:1-2", 0), outOfBounds(SECOND, 5, "a.md:4", 0),
    ].sort());
    expect(findings.filter((line) => line.includes("gone.md")).length).toBe(3);
  });

  it("C7 rejects both walkers with a page read's own error", async () => {
    const error = new Error("planted page read failure");
    await expect(checkBrokenCitationsFrom(sourcesOver([], { rel: SECOND, error }))).rejects.toBe(error);
    await expect(checkMalformedClaimCitationsFrom(sourcesOver([], { rel: SECOND, error }).pages)).rejects.toBe(error);
  });
});
