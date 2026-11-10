/**
 * @file test/storage/eval-pipeline-binding.test.ts
 * @description The evaluation pipeline as a WHOLE consumer with no project
 * directory: `runEvalFrom` over `EvalSources`. The body exists only after the
 * pipeline was given sources of its own, so this file has NO before-edit run,
 * and agreement between the two forms of one body is not, by itself, proof of
 * what the pipeline did before the edit. The written-out figures are the
 * independent part: the report's keys, the snapshot's counts, the judge's
 * samples and verdicts, the deltas, the threshold wording and the cache lines
 * were worked out by hand, and the pair hashes and cache keys by a script over
 * the source text. The health, coverage, utilization, depth, distribution and
 * graph figures are NOT hand-worked here; they are compared with the disk's.
 *
 * THE MODEL IS A STUB. `callClaude` is module-mocked before anything is
 * imported. The provider is set to `offline` for the file, in hooks, so the
 * real provider check passes without any credential.
 *
 * HOW IT IS BUILT. A project of two pages citing one source, with a thresholds
 * file, is minted on real disk. The real root-taking `runEval` runs five times
 * in a row (fast, full, full, fast unrecorded, a full run whose only new verdict
 * fails), the tree is copied, and every minting directory is removed before any
 * case runs. In memory the SAME five run through `runEvalFrom`: pages and
 * sources are answered from the copy, and the evaluation files from a map that
 * starts with the thresholds text only, as the disk's did.
 *
 * WHAT RUNS FOR REAL IN MEMORY. The provider check, the lint coordinator with
 * every rule, the six evaluators, the snapshot, the history readers, the judge
 * with its sample and cache, the report assembly, the delta, the threshold
 * check and the history append. The doubles answer raw facts only. No finding,
 * metric, pair, verdict or report is handed in.
 *
 * WHAT IS NOT SHOWN. The CLI, SDK and MCP callers of `runEval`, which still take
 * a project root; no journey is traced here. The default `record = true` is the
 * root form's own; the in-memory form is handed it. The doubles have no links
 * and confine nothing, and the lint doubles are those of
 * `lint-sources-doubles.ts`: no custom profile, journal, marker or candidate.
 */

import { realpath } from "node:fs/promises";
import { describe, expect, it, vi, afterAll, beforeAll, beforeEach, setSystemTime, type Mock } from "bun:test";
import { restoreEnv, stubEnv } from "../stubs.js";
import { tempRootTracker } from "../temp-roots.js";

vi.mock("../../src/utils/llm.js", () => ({ callClaude: vi.fn() }));

import type { CitationJudgement, EvalReport } from "../../src/eval/types.js";
import { lintSourcesOver, NO_ENTITIES } from "./lint-sources-doubles.js";
import type { EvalFileReads } from "../../src/eval/file-reads.js";
import { runEval, runEvalFrom, type EvalSources } from "../../src/eval/index.js";
import { expectMintingDirectoryRemoved } from "./minted-directory.js";
import type { EvalFileWrites } from "../../src/eval/file-writes.js";
import { callClaude } from "../../src/utils/llm.js";
import { enoent, entityScansOf, heldText, mintCopied, mintOnceThenRemove, unasked, writeFiles, type Minted } from "./copied-project.js";
import type { LegacyLocalReads } from "../../src/storage/legacy-local-reads.js";

const PREFIX = "eval-pipeline-";
const EVAL_DIR = ".llmwiki/eval";
const [HISTORY, CACHE, THRESHOLDS] = [`${EVAL_DIR}/history.jsonl`, `${EVAL_DIR}/citation-cache.jsonl`, `${EVAL_DIR}/thresholds.yaml`];
const THRESHOLDS_TEXT = "citation_support_mean: 1.5\n";
const AT = "2026-03-04T05:06:07.000Z";
const page = (...paragraphs: string[]): string => `---\ntitle: T\nsummary: S.\n---\n\n${paragraphs.join("\n\n")}\n`;
const claim = (n: number): string => `Claim ${n}. ^[src.md:${n}-${n}]`;
const FILES: Record<string, string> = {
  "sources/src.md": "line 1\nline 2\nline 3\n",
  "wiki/concepts/one.md": page(claim(1), claim(2)),
  "wiki/queries/ask.md": page(claim(3)),
  [THRESHOLDS]: THRESHOLDS_TEXT,
};
/** The three pairs in the order their hashes sort, with each one's cache key under the offline model (from `keys.py`). */
const S1 = { n: 3, slug: "ask", hash: "72396e5a7738d35b", key: "60c1dffae45ee122" };
const S2 = { n: 2, slug: "one", hash: "81958f40dd58cdf1", key: "151f78668bb03f5f" };
/** The judgement a stub verdict of `score` becomes for one pair, with its fields in the order the judge writes them. */
function judged(pair: typeof S1, score: 0 | 1 | 2): CitationJudgement {
  const cited = { citedFile: "src.md", lineStart: pair.n, lineEnd: pair.n, claimText: `Claim ${pair.n}.`, spanText: `line ${pair.n}` };
  return { claimHash: pair.key, pageSlug: pair.slug, ...cited, score, reason: `Stub verdict ${score}.`, model: "offline-v1", timestamp: AT };
}
const FAST_KEYS = ["suite", "timestamp", "health", "citationCoverage", "sourceUtilization", "citationDepth", "pageHealthDistribution", "graphHealth", "stats"];
/** The eight entries every run takes first, in order; the full suite takes `history` once more for the ninth read. */
const FIRST_EIGHT = ["health", "citationCoverage", "sourceUtilization", "citationDepth", "pageHealthDistribution", "graphHealth", "stats", "history"];

/** One verdict as the model would return it. */
const verdict = (score: number): string => JSON.stringify({ score, reason: `Stub verdict ${score}.` });
const REFUSAL = new Error("planted provider failure");
/** What the stub returns or throws next, call by call. When empty it returns a verdict of 2. */
const answers: Array<string | Error> = [];
const log: string[] = [];
async function stub(): Promise<string> {
  const next = answers.shift() ?? verdict(2);
  if (next instanceof Error) throw next;
  return next;
}
const timesAsked = (): number => (callClaude as unknown as Mock<typeof callClaude>).mock.calls.length;

type Suite = "fast" | "full";
type Evaluate = (suite: Suite, sampleSize: number, record?: boolean) => Promise<EvalReport>;
/** What one run gave: its report or the message it rejected with, and how often the stub was asked. */
interface Run { report?: EvalReport; error?: string; asked: number }
async function ran(evaluate: Evaluate, queued: typeof answers, suite: Suite, sampleSize: number, record?: boolean): Promise<Run> {
  answers.length = 0;
  answers.push(...queued);
  const before = timesAsked();
  try {
    return { report: await evaluate(suite, sampleSize, record), asked: timesAsked() - before };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error), asked: timesAsked() - before };
  }
}

/** Five runs in a row: fast, full with one pair, full with two, fast unrecorded, then a full run whose only new verdict fails. */
async function fiveRuns(evaluate: Evaluate): Promise<Run[]> {
  return [
    await ran(evaluate, [], "fast", 20),
    await ran(evaluate, [verdict(2)], "full", 1),
    await ran(evaluate, [verdict(0)], "full", 2),
    await ran(evaluate, [], "fast", 20, false),
    await ran(evaluate, [REFUSAL], "full", 3),
  ];
}

/** What the disk answered, and the project's real root for the doubles that key on it. */
interface OnDisk { real: string; runs: Run[] }
const tracker = tempRootTracker();
let project: Minted<OnDisk>;
let unprovided: Minted<OnDisk>;
const onDisk = (root: string): Evaluate => (suite, sampleSize, record) => runEval(root, suite, sampleSize, record);
const offline = (): void => { stubEnv("LLMWIKI_PROVIDER", "offline"); stubEnv("LLMWIKI_EMBEDDING_PROVIDER", ""); };
const withoutCredential = (): void => { stubEnv("LLMWIKI_PROVIDER", "openai"); stubEnv("OPENAI_API_KEY", ""); };

beforeAll(() => { setSystemTime(new Date(AT)); offline(); (callClaude as unknown as Mock<typeof callClaude>).mockImplementation(stub); });
beforeEach(() => { offline(); (callClaude as unknown as Mock<typeof callClaude>).mockReset().mockImplementation(stub); log.length = 0; answers.length = 0; });
afterAll(() => { restoreEnv(); setSystemTime(); });
mintOnceThenRemove(tracker, async () => {
  project = await mintCopied(tracker, PREFIX, (root) => writeFiles(root, FILES), async (root) => ({ real: await realpath(root), runs: await fiveRuns(onDisk(root)) }));
  withoutCredential();
  unprovided = await mintCopied(tracker, PREFIX, (root) => writeFiles(root, { "sources/src.md": "line 1\n" }), async (root) => ({ real: root, runs: [await ran(onDisk(root), [], "full", 1)] }));
  offline();
});

/** The evaluation files over a map of texts. Writes are logged; a removal is never asked. */
function evalFilesOver(texts: Map<string, string>): { reads: EvalFileReads; writes: EvalFileWrites } {
  const reads: EvalFileReads = {
    existsSync: (rel) => texts.has(rel),
    async readText(rel) {
      const text = texts.get(rel);
      if (text === undefined) throw enoent();
      return text;
    },
  };
  const writes: EvalFileWrites = {
    removeFile: unasked("writes.removeFile"),
    async appendText(rel, text) { log.push(`append ${rel}`); texts.set(rel, `${texts.get(rel) ?? ""}${text}`); },
    async makeDirectoryTree(relDir) { log.push(`mkdir ${relDir}`); },
  };
  return { reads, writes };
}

/** The source scan's two reads over the copy: the configuration text (absent, so the default selection) and the listings under a directory. */
function scanReadsOver(from: Minted<OnDisk>): LegacyLocalReads {
  const listingUnder = (relDir: string) => async (relative: string) => from.copy.listings.get(relative === "" ? relDir : `${relDir}/${relative}`) ?? Promise.reject(enoent());
  return {
    readText: async (rel) => heldText(from.copy, rel),
    realDirectory: async (relDir) => (from.copy.listings.has(relDir) ? { listEntries: listingUnder(relDir) } : null),
    listNames: unasked("scan.listNames"), locate: unasked("scan.locate"), exists: unasked("scan.exists"),
    readConfinedPage: unasked("scan.readConfinedPage"), statNoFollow: unasked("scan.statNoFollow"), readConfinedFile: unasked("scan.readConfinedFile"),
  };
}

/** One entry per pipeline step over a copy: pages, sources and lint facts from the copy, evaluation files from `texts`. */
function sourcesOver(from: Minted<OnDisk>, texts: Map<string, string>): EvalSources {
  const { copy, onDisk: { real } } = from;
  const held = (location: string): string => location.slice(real.length + 1);
  const lint = (): EvalSources["health"] => lintSourcesOver(from, log, NO_ENTITIES);
  const locations = { sourcesDir: `${real}/sources`, realPath: async (location: string) => (copy.files.has(held(location)) || copy.listings.has(held(location)) ? location : Promise.reject(enoent())) };
  const { reads, writes } = evalFilesOver(texts);
  return {
    health: lint(), pageHealthDistribution: lint(), citationDepth: lint().pages,
    citationCoverage: { pages: lint().pages, locations },
    sourceUtilization: { reads: scanReadsOver(from), locations, kindNoFollow: unasked("kindNoFollow"), pages: lint().pages },
    graphHealth: entityScansOf(copy, real, () => {}),
    stats: { sourceReads: scanReadsOver(from), pages: lint().pages, embeddings: { resolvePrivateDir: async () => "memory:private", leafKind: async () => "absent", readLeafBytes: unasked("embeddings.readLeafBytes") } },
    history: reads, thresholds: reads, record: writes,
    citationSupport: { pairs: { pages: lint().pages, sources: { locations, readText: async (location) => heldText(copy, held(location)) } }, cache: { reads, writes } },
  };
}
const inMemory = (sources: EvalSources): Evaluate => (suite, sampleSize, record = true) => runEvalFrom(sources, suite, sampleSize, record);
const startingTexts = (): Map<string, string> => new Map([[THRESHOLDS, THRESHOLDS_TEXT]]);
/** `sources`, recording which step's entry the pipeline takes, in order. */
function watched(sources: EvalSources): { sources: EvalSources; taken: string[] } {
  const taken: string[] = [];
  return { taken, sources: new Proxy(sources, { get: (target, step) => { taken.push(String(step)); return Reflect.get(target, step); } }) };
}
const reportOf = (index: number): EvalReport | undefined => project.onDisk.runs[index]?.report;

describe("the evaluation pipeline over a copy and a map of evaluation files, with the directories gone", () => {
  it("E1 runs after every minting directory was removed", () => {
    for (const minted of [project, unprovided]) expectMintingDirectoryRemoved(minted.dir, PREFIX);
  });

  it("E2 gives what the disk gave for all five runs, and leaves the history, the cache and the thresholds as the disk was left", async () => {
    const texts = startingTexts();
    expect(await fiveRuns(inMemory(sourcesOver(project, texts)))).toStrictEqual(project.onDisk.runs);
    expect([...texts.keys()].sort()).toEqual([CACHE, HISTORY, THRESHOLDS]);
    for (const rel of [CACHE, HISTORY, THRESHOLDS]) expect([rel, texts.get(rel)]).toEqual([rel, project.copy.files.get(rel)]);
  });

  it("E3 the history holds the three recorded reports as exact JSON lines, and the cache the two verdicts", () => {
    const recorded = [reportOf(0), reportOf(1), reportOf(2)];
    expect(recorded.map((report) => report?.suite)).toEqual(["fast", "full", "full"]);
    expect(project.copy.files.get(HISTORY)).toBe(recorded.map((report) => `${JSON.stringify(report)}\n`).join(""));
    expect(project.copy.files.get(CACHE)).toBe([judged(S1, 2), judged(S2, 0)].map((one) => `${JSON.stringify(one)}\n`).join(""));
    expect(project.copy.files.get(THRESHOLDS)).toBe(THRESHOLDS_TEXT);
  });

  it("E4 the first fast report: its keys in order, no delta, no judge, and the snapshot's hand-worked counts", () => {
    const first = project.onDisk.runs[0];
    expect([first?.asked, first?.error, Object.keys(first?.report ?? {})]).toEqual([0, undefined, [...FAST_KEYS, "thresholdViolations"]]);
    expect([first?.report?.suite, first?.report?.timestamp, first?.report?.thresholdViolations]).toEqual(["fast", AT, []]);
    expect(first?.report?.stats).toStrictEqual({
      timestamp: AT, sourceCount: 1, pageCount: 2, totalWikiChars: 72, embeddingCount: 0, chunkEmbeddingCount: 0, avgPageLengthChars: 36, embeddingsAvailable: false,
    });
  });

  it("E5 the first full report: one sampled pair judged, a delta against the fast report with no judge mean, no violation", () => {
    const second = project.onDisk.runs[1];
    expect([second?.asked, Object.keys(second?.report ?? {})]).toEqual([1, [...FAST_KEYS, "citationSupport", "delta", "thresholdViolations"]]);
    expect(second?.report?.citationSupport).toStrictEqual({
      sampledCount: 1, sampledHashes: [S1.hash], totalCitations: 3, judgeErrors: 0,
      meanScore: 2, fullySupported: 1, partiallySupported: 0, unsupported: 0, judgements: [judged(S1, 2)],
    });
    expect([second?.report?.delta, second?.report?.thresholdViolations]).toStrictEqual([{ healthScore: 0, citationCoveragePercent: 0, citationPrecisionPercent: 0 }, []]);
  });

  it("E6 the second full report keeps the last full report's sample, judges only the new pair, and reports the mean's fall and the violation", () => {
    const third = project.onDisk.runs[2];
    expect([third?.asked, third?.report?.citationSupport?.sampledHashes]).toEqual([1, [S1.hash, S2.hash]]);
    expect(third?.report?.citationSupport?.judgements).toStrictEqual([judged(S1, 2), judged(S2, 0)]);
    expect(third?.report?.delta).toStrictEqual({ healthScore: 0, citationCoveragePercent: 0, citationPrecisionPercent: 0, citationSupportMean: -1 });
    expect(third?.report?.thresholdViolations).toEqual(["citation_support_mean 1.00 is below threshold 1.5"]);
  });

  it("E7 an unrecorded fast run after a full one: a delta with no judge mean, the fast keys, and nothing appended", () => {
    const fourth = project.onDisk.runs[3];
    expect([fourth?.asked, Object.keys(fourth?.report ?? {})]).toEqual([0, [...FAST_KEYS, "delta", "thresholdViolations"]]);
    expect(fourth?.report?.delta).toStrictEqual({ healthScore: 0, citationCoveragePercent: 0, citationPrecisionPercent: 0 });
  });

  it("E8 a full run whose only new verdict fails rejects, beside two cached verdicts, and is not recorded", () => {
    expect(project.onDisk.runs[4]).toStrictEqual({ asked: 1, error: "Citation judge failed for all 1 sampled pair(s): planted provider failure" });
  });

  it("E9 takes the nine reads in the order written, then the judge in the full suite only, then the thresholds, then the record", async () => {
    const full = watched(sourcesOver(project, startingTexts()));
    await runEvalFrom(full.sources, "full", 1, true);
    expect(full.taken).toEqual([...FIRST_EIGHT, "history", "citationSupport", "thresholds", "record"]);
    const fast = watched(sourcesOver(project, startingTexts()));
    await runEvalFrom(fast.sources, "fast", 1, false);
    expect(fast.taken).toEqual([...FIRST_EIGHT, "thresholds"]);
  });
});

describe("the provider check and the pipeline's failures", () => {
  it("P1 the full suite without a credential rejects before any step's entry is taken, and the fast suite is not checked", async () => {
    withoutCredential();
    const guarded = watched(sourcesOver(project, startingTexts()));
    await expect(runEvalFrom(guarded.sources, "full", 1, true)).rejects.toThrow('OPENAI_API_KEY environment variable is required for the "openai" provider.');
    expect([guarded.taken, log]).toEqual([[], []]);
    expect((await runEvalFrom(guarded.sources, "fast", 1, false)).suite).toBe("fast");
  });

  it("P2 on disk the same check rejected the root form, and the project was left without a private directory", () => {
    const [run] = unprovided.onDisk.runs;
    expect([run?.asked, run?.error?.split("\n")[0]]).toEqual([0, 'OPENAI_API_KEY environment variable is required for the "openai" provider.']);
    expect(unprovided.copy.listings.has(".llmwiki")).toBe(false);
  });

  it("X1 a thresholds file that cannot be read rejects with its own error, and nothing is recorded", async () => {
    const failure = new Error("planted thresholds read failure");
    const texts = startingTexts();
    const sources = sourcesOver(project, texts);
    sources.thresholds = { existsSync: () => true, readText: async () => { throw failure; } };
    await expect(runEvalFrom(sources, "fast", 1, true)).rejects.toBe(failure);
    expect(texts.has(HISTORY)).toBe(false);
  });

  it("X2 a history append that fails rejects with its own error, after the directory was asked for", async () => {
    const failure = new Error("planted history append failure");
    const sources = sourcesOver(project, startingTexts());
    sources.record = { ...sources.record, appendText: async () => { throw failure; } };
    await expect(runEvalFrom(sources, "fast", 1, true)).rejects.toBe(failure);
    expect(log.filter((call) => call.startsWith("mkdir ") || call.startsWith("append "))).toEqual([`mkdir ${EVAL_DIR}`]);
  });
});
