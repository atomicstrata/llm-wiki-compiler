/**
 * @file test/storage/eval-evidence-pairs-binding.test.ts
 * @description The citation-pair extraction and the candidate evidence reader
 * as WHOLE consumers with no project directory: `extractCitationPairsFrom` and
 * `currentEvidenceReaderFrom`, with the source resolver and whole-text read
 * they share. Both bodies exist only after the two modules were given sources
 * of their own, so this file has NO before-edit run.
 *
 * HOW IT IS BUILT. One default-profile project is minted on real disk: two
 * sources, a file outside `sources/`, two links in `sources/` (to a sibling and
 * to the outside file), and two pages whose citations reach each of those, a
 * missing file, a vague citation, the same span twice, and a range far past
 * the end of its file. All of one directory's citations are on ONE page, so no
 * case depends on the order a directory lists its files. `sources/` is made by
 * the source files and then made again explicitly before the links. The real
 * root-taking extraction, reader and assessment answer. The tree is copied as raw text and listings, each
 * link's resolved target is recorded as the disk gave it, and the directory is
 * removed before any case runs.
 *
 * WHAT RUNS FOR REAL IN MEMORY. The page collection, the citation parser, the
 * resolver's lexical rules and both containment checks, the line slice, both
 * hashes, the reader's memo, and the candidate assessment with its range and
 * freshness decisions. The doubles answer raw facts only: a page's text, what
 * a location resolves to, and the text at a location. No pair, evidence text,
 * excerpt or status is handed in.
 *
 * WHAT IS NOT SHOWN. NO MODEL IS CALLED: the judge, its cache, the sampling,
 * `evaluateCitationSupport` and `evaluateCandidates` are not reached and still
 * take a project root. Locations are names under the removed project's real
 * path: the legacy local identity, not a logical id. Nothing here shows what a
 * real disk decides about links.
 */

import { createHash } from "node:crypto";
import { mkdir, realpath, symlink } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import { candidateAssessments, currentEvidenceReader, currentEvidenceReaderFrom, evaluationHash } from "../../src/eval/candidate-evidence.js";
import { extractCitationPairs, extractCitationPairsFrom, type CitationPair, type CitationPairSources } from "../../src/eval/citation-support.js";
import type { SourceFileReads } from "../../src/eval/source-path.js";
import { CONCEPTS_DIR, QUERIES_DIR, SOURCES_DIR } from "../../src/utils/constants.js";
import { tempRootTracker } from "../temp-roots.js";
import { enoent, expectRemovedDefaultCopies, heldText, mintCopied, mintOnceThenRemove, writeFiles, type Minted } from "./copied-project.js";
import { lintSourcesOver, NO_ENTITIES } from "./lint-sources-doubles.js";

const PREFIX = "eval-evidence-pairs-";
const ALPHA = "line one\nline two\nline three\n";
const page = (title: string, ...paragraphs: string[]): string => `---\ntitle: ${title}\n---\n\n${paragraphs.join("\n\n")}\n`;
const FILES: Record<string, string> = {
  [`${SOURCES_DIR}/alpha.md`]: ALPHA, [`${SOURCES_DIR}/beta.md`]: "b one\nb two\n", "outside.md": "kept outside\n",
  [`${CONCEPTS_DIR}/one.md`]: page("One", "One says it twice. ^[alpha.md:1-2] ^[alpha.md:1-2]",
    "One cites the alias and a vague one. ^[alias.md:2] ^[alpha.md]", "One cites far past the end. ^[beta.md:5-9]",
    "One cites a missing file and a leak. ^[missing.md:1] ^[leak.md:1]"),
  [`${QUERIES_DIR}/ask.md`]: page("Ask", "The query cites beta. ^[beta.md:2]"),
};
const LINKS = [["alias.md", "alpha.md"], ["leak.md", "../outside.md"]] as const;
const ASKED = ["alpha.md", "alias.md", "missing.md", "leak.md", "../outside.md", ""];
/** A pending draft: fresh evidence, changed evidence, a range past the end, a missing source, and uncited prose. */
const DRAFT = {
  body: page("Draft", "Fresh claim. ^[alpha.md:1-2]", "Changed claim. ^[beta.md:1]", "Past the end. ^[alpha.md:9-12]", "Gone. ^[missing.md:1]", "Uncited prose."),
  hashes: { "alpha.md": evaluationHash(ALPHA), "beta.md": "recorded-at-generation" },
};
const REFERENCE = { id: "draft-1", target: "concepts/draft", generatedAt: "then", revision: "r1", contentHash: "c1" };

/** What the disk answered, the real root, and where each link resolved (null when nowhere). */
interface OnDisk {
  real: string; linked: Map<string, string | null>; pairs: CitationPair[];
  evidence: Array<[string, string | null]>; assessed: Awaited<ReturnType<typeof candidateAssessments>>;
}
type Project = Minted<OnDisk>;

async function linkedSources(root: string): Promise<void> {
  await writeFiles(root, FILES);
  const sources = path.join(root, SOURCES_DIR);
  await mkdir(sources, { recursive: true });
  await Promise.all(LINKS.map(([name, target]) => symlink(target, path.join(sources, name))));
}

async function diskAnswers(root: string): Promise<OnDisk> {
  const real = await realpath(root);
  const linked = new Map<string, string | null>();
  for (const [name] of LINKS) {
    const to = await realpath(path.join(root, SOURCES_DIR, name)).catch(() => null);
    linked.set(`${SOURCES_DIR}/${name}`, to === null ? null : path.relative(real, to));
  }
  const read = currentEvidenceReader(root);
  const evidence: OnDisk["evidence"] = [];
  for (const file of ASKED) evidence.push([file, await read(file)]);
  const assessed = await candidateAssessments(DRAFT, REFERENCE, currentEvidenceReader(root));
  return { real, linked, pairs: await extractCitationPairs(root), evidence, assessed };
}

const tracker = tempRootTracker();
let project: Project;
mintOnceThenRemove(tracker, async () => { project = await mintCopied(tracker, PREFIX, linkedSources, diskAnswers); });

/** The resolver's two facts and the whole-text read, over a copy. A recorded link resolves where the disk said; a held path resolves to itself; anything else rejects. */
function sourceReadsOver(from: Project, events: string[]): SourceFileReads {
  const { copy, onDisk: { real, linked } } = from;
  const under = (location: string): string => location.slice(real.length + 1);
  const realPath = async (location: string): Promise<string> => {
    const rel = under(location);
    events.push(`real ${rel}`);
    const to = linked.has(rel) ? linked.get(rel) ?? null : copy.files.has(rel) || copy.listings.has(rel) ? rel : null;
    if (to === null) throw enoent();
    return `${real}/${to}`;
  };
  return {
    locations: { sourcesDir: `${real}/${SOURCES_DIR}`, realPath },
    readText: async (location) => { events.push(`read ${under(location)}`); return heldText(copy, under(location)); },
  };
}

/** The extraction's sources over a copy: the shared lint page double and the source reads above. */
const pairSourcesOver = (from: Project, events: string[]): CitationPairSources =>
  ({ pages: lintSourcesOver(from, events, NO_ENTITIES).pages, sources: sourceReadsOver(from, events) });
const countOf = (events: string[], call: string): number => events.filter((event) => event === call).length;
const shortHash = (text: string): string => createHash("sha256").update(text).digest("hex").slice(0, 16);

describe("citation pairs over a copied project, with the directory gone", () => {
  it("E1 runs after the minting directory was removed, on a copy that recorded where each link resolved", () => {
    expectRemovedDefaultCopies([project], PREFIX);
    expect([...project.onDisk.linked]).toEqual([[`${SOURCES_DIR}/alias.md`, `${SOURCES_DIR}/alpha.md`], [`${SOURCES_DIR}/leak.md`, "outside.md"]]);
  });

  it("P1 extracts exactly the pairs the disk did: the repeated span twice, the alias under its own name, an empty excerpt past the end", async () => {
    const pairs = await extractCitationPairsFrom(pairSourcesOver(project, []));
    expect(pairs).toEqual(project.onDisk.pairs);
    expect(pairs.map((pair) => [pair.pageSlug, pair.citedFile, pair.lineStart, pair.lineEnd, pair.spanText])).toEqual([
      ["one", "alpha.md", 1, 2, "line one\nline two"], ["one", "alpha.md", 1, 2, "line one\nline two"],
      ["one", "alias.md", 2, 2, "line two"], ["one", "beta.md", 5, 9, ""], ["ask", "beta.md", 2, 2, "b two"],
    ]);
    expect(pairs.map((pair) => pair.claimHash).slice(0, 2)).toEqual(Array(2).fill(shortHash("One says it twice.line one\nline two")));
  });

  it("P2 starts a page's spans together and keeps nothing: six directory lookups first, alpha read three times, the query page last", async () => {
    const events: string[] = [];
    await extractCitationPairsFrom(pairSourcesOver(project, events));
    const after = events.filter((event) => !event.startsWith("page "));
    expect(after.slice(0, 6)).toEqual(Array(6).fill(`real ${SOURCES_DIR}`));
    expect([countOf(events, `read ${SOURCES_DIR}/alpha.md`), countOf(events, `read ${SOURCES_DIR}/beta.md`), countOf(events, `real ${SOURCES_DIR}`)]).toEqual([3, 2, 7]);
    expect(after.slice(-3)).toEqual([`real ${SOURCES_DIR}`, `real ${SOURCES_DIR}/beta.md`, `read ${SOURCES_DIR}/beta.md`]);
  });

  it("P3 extracts nothing from an empty project, and rejects with a source read's own error", async () => {
    const empty: Project = { ...project, copy: { files: new Map(), listings: new Map() } };
    expect(await extractCitationPairsFrom(pairSourcesOver(empty, []))).toEqual([]);
    const failure = new Error("planted source read failure");
    const from = pairSourcesOver(project, []);
    from.sources.readText = async () => { throw failure; };
    await expect(extractCitationPairsFrom(from)).rejects.toBe(failure);
  });
});

describe("the candidate evidence reader over the same copy", () => {
  it("R1 answers each asked name as the disk reader did: the text, the alias's target text, and null four ways", async () => {
    const read = currentEvidenceReaderFrom(sourceReadsOver(project, []));
    const evidence: OnDisk["evidence"] = [];
    for (const file of ASKED) evidence.push([file, await read(file)]);
    expect(evidence).toEqual(project.onDisk.evidence);
    expect(evidence).toEqual([["alpha.md", ALPHA], ["alias.md", ALPHA], ["missing.md", null], ["leak.md", null], ["../outside.md", null], ["", null]]);
  });

  it("R2 keeps one promise per name as written, a null answer included, and reads an alias apart from its target", async () => {
    const events: string[] = [];
    const read = currentEvidenceReaderFrom(sourceReadsOver(project, events));
    expect(read("alpha.md")).toBe(read("alpha.md"));
    await Promise.all([read("alpha.md"), read("alias.md"), read("missing.md"), read("missing.md")]);
    expect([countOf(events, `read ${SOURCES_DIR}/alpha.md`), countOf(events, `real ${SOURCES_DIR}/missing.md`), countOf(events, `real ${SOURCES_DIR}`)]).toEqual([2, 1, 3]);
  });

  it("R3 absorbs a failed read as unavailable evidence, once", async () => {
    const events: string[] = [];
    const reads = sourceReadsOver(project, events);
    const read = currentEvidenceReaderFrom({ ...reads, readText: async (location) => { events.push(`failed ${location.slice(-8)}`); throw enoent(); } });
    expect([await read("alpha.md"), await read("alpha.md")]).toEqual([null, null]);
    expect(events.filter((event) => event.startsWith("failed "))).toEqual(["failed alpha.md"]);
  });

  it("A1 assesses a draft through the reader as the disk did: eligible, changed, past the end, unavailable, uncited", async () => {
    const events: string[] = [];
    const assessed = await candidateAssessments(DRAFT, REFERENCE, currentEvidenceReaderFrom(sourceReadsOver(project, events)));
    expect(assessed).toEqual(project.onDisk.assessed);
    expect(assessed.assessments.map((item) => [item.status, item.evidence?.status, item.reason])).toEqual([
      ["eligible", "matches-generation", undefined],
      ["unjudgeable", "changed", "Source changed since candidate generation; regenerate or review the new evidence."],
      ["unjudgeable", "matches-generation", "Citation line range is outside the current source."],
      ["unjudgeable", "unavailable", "Source is missing, unreadable, or outside sources/."],
      ["unjudgeable", undefined, "Prose has no usable citation."],
    ]);
    expect([assessed.prose, assessed.cited, assessed.assessments[0]?.evidence?.spanText, countOf(events, `read ${SOURCES_DIR}/alpha.md`)]).toEqual([5, 4, "line one\nline two", 1]);
  });
});
