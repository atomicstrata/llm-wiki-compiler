/**
 * @file test/storage/citation-support-binding.test.ts
 * @description The citation-support evaluator as a WHOLE consumer with no
 * project directory: `evaluateCitationSupportFrom` over
 * `CitationSupportSources`. The body exists only after the evaluator was given
 * sources of its own, so this file has NO before-edit run, and agreement
 * between the two forms of one body is not, by itself, proof of what the
 * evaluator did before the edit. The written-out figures are the independent
 * part: the samples, counts, scores and cache lines were worked out by hand,
 * and the pair hashes and cache keys by a script over the source text.
 *
 * THE MODEL IS A STUB. `callClaude` is module-mocked before anything is
 * imported, so no model, provider or network is reached. The stub follows a
 * plan of scores and failures that each run sets.
 *
 * HOW IT IS BUILT. Two projects are minted on real disk: one with five cited
 * claims over one source, and one whose only page cites nothing. The real
 * root-taking `evaluateCitationSupport` runs five evaluations in a row on the
 * first (new verdicts, all cached, a mixed failure, every new verdict failing
 * beside cached ones, then the default arguments), the tree is copied, and the
 * directories are removed before any case runs. In memory the SAME five run
 * through `evaluateCitationSupportFrom`: pages and sources are answered from
 * the copy, and the cache from a map that starts EMPTY, as the disk's did.
 *
 * WHAT RUNS FOR REAL IN MEMORY. The page collection, the citation parse, the
 * source resolution and line slice, the pair hash, the sample with its retained
 * order, the judge with its cache load, key, check, rebinding, validation,
 * clock read, append and memory, the error count, the all-new-failed rule and
 * the totals. The doubles answer raw facts only: a listing, a text, whether a
 * path resolves, a text appended. No pair, sample, verdict or report is handed
 * in.
 *
 * THE CLOCK AND THE MODEL NAME. Only `Date` is faked. Two environment names are
 * stubbed for the whole file, in hooks, so the default model is a known one.
 *
 * WHAT IS NOT SHOWN. `runEval` and every caller above the evaluator, which
 * still take a project root. The default sample size and empty previous list
 * are the root form's own; the in-memory form is handed them. The doubles have
 * no links and confine nothing.
 */

import { beforeAll, beforeEach, afterAll, describe, expect, it, vi, setSystemTime, type Mock } from "bun:test";
import { restoreEnv, stubEnv } from "../stubs.js";

vi.mock("../../src/utils/llm.js", () => ({ callClaude: vi.fn() }));

import { callClaude } from "../../src/utils/llm.js";
import { expectMintingDirectoryRemoved } from "./minted-directory.js";
import { evaluateCitationSupport, evaluateCitationSupportFrom, type CitationJudgeCacheFiles, type CitationSupportSources } from "../../src/eval/citation-support.js";
import { lintSourcesOver, NO_ENTITIES } from "./lint-sources-doubles.js";
import type { CitationJudgement, CitationSupportResult } from "../../src/eval/types.js";
import { enoent, heldText, mintCopied, mintOnceThenRemove, unasked, writeFiles, type Copy, type Minted } from "./copied-project.js";
import type { SourceFileReads } from "../../src/eval/source-path.js";
import { tempRootTracker } from "../temp-roots.js";

const PREFIX = "citation-support-";
const EVAL_DIR = ".llmwiki/eval";
const CACHE = `${EVAL_DIR}/citation-cache.jsonl`;
const AT = "2026-03-04T05:06:07.000Z";
const MEMORY_ROOT = "/memory-project";
const DEFAULT_SAMPLE_SIZE = 20;
const page = (...paragraphs: string[]): string => `---\ntitle: T\n---\n\n${paragraphs.join("\n\n")}\n`;
const claim = (n: number): string => `Claim ${n}. ^[src.md:${n}-${n}]`;
const CITED: Record<string, string> = {
  "sources/src.md": "line 1\nline 2\nline 3\nline 4\nline 5\n",
  "wiki/concepts/one.md": page(claim(1), claim(2), claim(3)),
  "wiki/queries/ask.md": page(claim(4), claim(5)),
};
/** The five pairs in the order their hashes sort: which claim, its page, its pair hash and its cache key under model-a (from `keys.py`). */
const SORTED = [
  { n: 3, slug: "one", hash: "72396e5a7738d35b", key: "54544e0426ff1e1a" },
  { n: 2, slug: "one", hash: "81958f40dd58cdf1", key: "c6c68d5b0f23d20f" },
  { n: 4, slug: "ask", hash: "8cb706773317c255", key: "6453721e99a99525" },
  { n: 5, slug: "ask", hash: "9ede273f3404d842", key: "36b2a6035b9d6bad" },
  { n: 1, slug: "one", hash: "be9498c78a39c97d", key: "6e56afad2e82fee0" },
] as const;
const [S1, S2, S3, S4, S5] = SORTED;
type Sorted = (typeof SORTED)[number];
/** The judgement the stub's `score` becomes for one pair, in the order the judge writes the fields. */
const judged = (pair: Sorted, score: 0 | 1 | 2): CitationJudgement => ({
  claimHash: pair.key, pageSlug: pair.slug, citedFile: "src.md", lineStart: pair.n, lineEnd: pair.n, claimText: `Claim ${pair.n}.`,
  spanText: `line ${pair.n}`, score, reason: `Stub verdict ${score}.`, model: "model-a", timestamp: AT,
});

/** What the stub answers next, call by call: a score (9 is one the judge must refuse), or a failure. An empty plan answers 2. */
const plan: Array<number | "fail"> = [];
const log: string[] = [];
const stub = async (): Promise<string> => {
  log.push("provider");
  const next = plan.shift() ?? 2;
  if (next === "fail") throw new Error("planted provider failure");
  return JSON.stringify({ score: next, reason: `Stub verdict ${next}.` });
};
const askedSoFar = (): number => log.filter((call) => call === "provider").length;

type Evaluate = (sampleSize?: number, previousHashes?: string[]) => Promise<CitationSupportResult | null>;
/** What one run gave: its result or the message it rejected with, and how often the stub was asked. */
interface Run { result?: CitationSupportResult | null; error?: string; asked: number }
async function ran(evaluate: Evaluate, planned: typeof plan, sampleSize?: number, previousHashes?: string[]): Promise<Run> {
  const before = askedSoFar();
  plan.splice(0, plan.length, ...planned);
  const settled = await evaluate(sampleSize, previousHashes).then((result) => ({ result }), (error: Error) => ({ error: error.message }));
  return { ...settled, asked: askedSoFar() - before };
}

/** Five evaluations in a row over one project: new verdicts, all cached, a mixed failure, all new failing beside cached ones, then the defaults. */
async function fiveRuns(evaluate: Evaluate): Promise<Run[]> {
  return [
    await ran(evaluate, [2, 1], 2),
    await ran(evaluate, [], 2, [S1.hash, S2.hash]),
    await ran(evaluate, ["fail", 0], 4, [S2.hash, "a-hash-no-pair-has", S1.hash]),
    await ran(evaluate, ["fail"], 4, [S2.hash, S1.hash, S3.hash, S4.hash]),
    await ran(evaluate, [1, 2]),
  ];
}

const tracker = tempRootTracker();
let cited: Minted<Run[]>;
let uncited: Minted<Run>;
const onDisk = (root: string): Evaluate => (sampleSize, previousHashes) => evaluateCitationSupport(root, sampleSize, previousHashes);

beforeAll(() => {
  setSystemTime(new Date(AT));
  stubEnv("LLMWIKI_PROVIDER", "anthropic");
  stubEnv("LLMWIKI_MODEL", "model-a");
  (callClaude as unknown as Mock<typeof callClaude>).mockImplementation(stub);
});
beforeEach(() => { (callClaude as unknown as Mock<typeof callClaude>).mockReset().mockImplementation(stub); log.length = 0; plan.length = 0; });
afterAll(() => { restoreEnv(); setSystemTime(); });
mintOnceThenRemove(tracker, async () => {
  cited = await mintCopied(tracker, PREFIX, (root) => writeFiles(root, CITED), (root) => fiveRuns(onDisk(root)));
  uncited = await mintCopied(tracker, PREFIX, (root) => writeFiles(root, { "wiki/concepts/plain.md": page("No citation here.") }), (root) => ran(onDisk(root), []));
});

/** The resolver's facts and the whole-text read over a copy with no links: a held path resolves to itself, anything else rejects. */
function sourceReadsOver(copy: Copy): SourceFileReads {
  const held = (location: string): string => location.slice(MEMORY_ROOT.length + 1);
  return {
    locations: {
      sourcesDir: `${MEMORY_ROOT}/sources`,
      realPath: async (location) => (copy.files.has(held(location)) || copy.listings.has(held(location)) ? location : Promise.reject(enoent())),
    },
    readText: async (location) => { log.push(`source ${held(location)}`); return heldText(copy, held(location)); },
  };
}

/** The cache file over a map of texts, every call logged. A removal is never asked. */
function cacheFilesOver(texts: Map<string, string>): CitationJudgeCacheFiles {
  const noted = <Value>(call: string, value: Value): Value => { log.push(call); return value; };
  return {
    reads: {
      existsSync: (rel) => noted(`exists ${rel}`, texts.has(rel)),
      readText: async (rel) => noted(`read ${rel}`, texts.get(rel)) ?? Promise.reject(enoent()),
    },
    writes: {
      makeDirectoryTree: async (relDir) => { log.push(`mkdir ${relDir}`); },
      appendText: async (rel, text) => { texts.set(rel, noted(`append ${rel}`, (texts.get(rel) ?? "") + text)); },
      removeFile: unasked("writes.removeFile"),
    },
  };
}
const CACHE_NEVER_ASKED: CitationJudgeCacheFiles = {
  reads: { existsSync: unasked("reads.existsSync"), readText: unasked("reads.readText") },
  writes: { makeDirectoryTree: unasked("writes.makeDirectoryTree"), appendText: unasked("writes.appendText"), removeFile: unasked("writes.removeFile") },
};

/** The evaluator's sources over one project's copy, with the cache given separately. */
function sourcesOver(project: Minted<unknown>, cache: CitationJudgeCacheFiles): CitationSupportSources {
  const pages = lintSourcesOver({ ...project, onDisk: { real: MEMORY_ROOT } }, log, NO_ENTITIES).pages;
  return { pairs: { pages, sources: sourceReadsOver(project.copy) }, cache };
}
const inMemory = (sources: CitationSupportSources): Evaluate =>
  (sampleSize = DEFAULT_SAMPLE_SIZE, previousHashes = []) => evaluateCitationSupportFrom(sources, sampleSize, previousHashes);
const totalsOf = (run: Run | undefined): unknown[] => {
  const result = run?.result;
  return [result?.sampledCount, result?.totalCitations, result?.judgeErrors, result?.meanScore, result?.fullySupported, result?.partiallySupported, result?.unsupported];
};

describe("the citation-support evaluator over a copy and an empty cache map, with the directories gone", () => {
  it("V1 runs after every minting directory was removed", () => {
    for (const minted of [cited, uncited]) expectMintingDirectoryRemoved(minted.dir, PREFIX);
  });

  it("V2 gives what the disk gave for all five runs, and leaves the cache text the disk was left with", async () => {
    const texts = new Map<string, string>();
    expect(await fiveRuns(inMemory(sourcesOver(cited, cacheFilesOver(texts))))).toStrictEqual(cited.onDisk);
    const lines = [judged(S1, 2), judged(S2, 1), judged(S4, 0), judged(S3, 1), judged(S5, 2)].map((one) => `${JSON.stringify(one)}\n`).join("");
    expect([texts.get(CACHE), cited.copy.files.get(CACHE)]).toEqual([lines, lines]);
  });

  it("V3 new verdicts: samples the two lowest hashes, asks the stub twice, and totals their scores", () => {
    const [first] = cited.onDisk;
    expect(first).toStrictEqual({ asked: 2, result: {
      sampledCount: 2, sampledHashes: [S1.hash, S2.hash], totalCitations: 5, judgeErrors: 0,
      meanScore: 1.5, fullySupported: 1, partiallySupported: 1, unsupported: 0, judgements: [judged(S1, 2), judged(S2, 1)],
    } });
  });

  it("V4 all cached: the same sample again asks the stub nothing and returns the same judgements", () => {
    const [first, second] = cited.onDisk;
    expect(second).toStrictEqual({ asked: 0, result: first?.result });
  });

  it("V5 a mixed failure: keeps the previous hashes in their given order, fills by hash, counts the one failure and leaves it out", () => {
    const third = cited.onDisk[2];
    expect([third?.asked, third?.error, third?.result?.sampledHashes]).toEqual([2, undefined, [S2.hash, S1.hash, S3.hash, S4.hash]]);
    expect(third?.result?.judgements).toStrictEqual([judged(S2, 1), judged(S1, 2), judged(S4, 0)]);
    expect(totalsOf(third)).toEqual([3, 5, 1, 1, 1, 1, 1]);
  });

  it("V6 every new verdict failing rejects the run, even beside three cached verdicts", () => {
    expect(cited.onDisk[3]).toStrictEqual({ asked: 1, error: "Citation judge failed for all 1 sampled pair(s): planted provider failure" });
  });

  it("V7 the defaults: all five pairs in hash order, three from the cache and two new", () => {
    const fifth = cited.onDisk[4];
    expect([fifth?.asked, fifth?.result?.sampledHashes]).toEqual([2, SORTED.map((pair) => pair.hash)]);
    expect(fifth?.result?.judgements).toStrictEqual([judged(S1, 2), judged(S2, 1), judged(S3, 1), judged(S4, 0), judged(S5, 2)]);
    expect(totalsOf(fifth)).toEqual([5, 5, 0, 1.2, 2, 2, 1]);
  });

  it("V8 a wiki that cites nothing answers null without asking the cache or the stub, as the disk did", async () => {
    const run = await ran(inMemory(sourcesOver(uncited, CACHE_NEVER_ASKED)), []);
    expect([run, uncited.onDisk]).toStrictEqual([{ result: null, asked: 0 }, { result: null, asked: 0 }]);
    expect(uncited.copy.listings.has(".llmwiki")).toBe(false);
  });

  it("V9 reads every page and source first, then asks about the cache once, then per verdict asks the stub, makes the directory and appends", async () => {
    await ran(inMemory(sourcesOver(cited, cacheFilesOver(new Map()))), [2, 1], 2);
    const cacheAsked = log.indexOf(`exists ${CACHE}`);
    const verdict = ["provider", `mkdir ${EVAL_DIR}`, `append ${CACHE}`];
    expect(log.slice(cacheAsked)).toEqual([`exists ${CACHE}`, ...verdict, ...verdict]);
    expect(log.slice(0, cacheAsked).filter((call) => call.startsWith("source "))).toEqual(Array(5).fill("source sources/src.md"));
    expect(log.slice(0, cacheAsked).filter((call) => call.startsWith("page ")).sort()).toEqual(["page wiki/concepts/one.md", "page wiki/queries/ask.md"]);
  });
});

describe("the evaluator's failures, in memory", () => {
  it("X1 a refused verdict and a failed append are each counted as a judge error, not thrown, while another pair succeeds", async () => {
    const texts = new Map<string, string>();
    const cache = cacheFilesOver(texts);
    const appendText = cache.writes.appendText;
    let appends = 0;
    cache.writes.appendText = async (rel, text) => { if (++appends === 1) throw new Error("planted append failure"); return appendText(rel, text); };
    const run = await ran(inMemory(sourcesOver(cited, cache)), [9, 2, 1], 3);
    expect([run.asked, run.error, totalsOf(run)]).toEqual([3, undefined, [1, 5, 2, 1, 0, 1, 0]]);
    expect(texts.get(CACHE)).toBe(`${JSON.stringify(judged(S3, 1))}\n`);
  });

  it("X2 a cache that cannot be read rejects with its own error before the stub is asked", async () => {
    const failure = new Error("planted cache read failure");
    const cache = cacheFilesOver(new Map([[CACHE, "held"]]));
    cache.reads.readText = async () => { throw failure; };
    await expect(evaluateCitationSupportFrom(sourcesOver(cited, cache), 2, [])).rejects.toBe(failure);
    expect(askedSoFar()).toBe(0);
  });

  it("X3 a source that cannot be read rejects with its own error before the cache is asked", async () => {
    const failure = new Error("planted source read failure");
    const sources = sourcesOver(cited, CACHE_NEVER_ASKED);
    sources.pairs.sources.readText = async () => { throw failure; };
    await expect(evaluateCitationSupportFrom(sources, 2, [])).rejects.toBe(failure);
  });
});
