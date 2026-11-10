/**
 * @file test/storage/candidate-eval-binding.test.ts
 * @description The pending-candidate evaluator as a WHOLE consumer with no
 * project directory: `evaluateCandidatesFrom` over `CandidateEvalSources`. The
 * body exists only after the evaluator was given sources of its own, so this
 * file has NO before-edit run, and agreement between the two forms of one body
 * is not, by itself, proof of what the evaluator did before the edit. The
 * written-out figures are the independent part: which files are skipped and
 * why, each draft's target, revision and content hash, every observation's
 * status and reason, the coverage counts, the wording when the judge cannot be
 * configured, and the report's bytes. Observation ids and cache keys are NOT
 * hand-worked; they are compared with the disk's.
 *
 * THE MODEL IS A STUB. `callClaude` is module-mocked before anything is
 * imported. The provider is `offline` for the judged runs, so the real
 * provider check passes with no credential.
 *
 * HOW IT IS BUILT. A queue of five hand-written records and two current
 * sources is minted on real disk: a draft whose three citations cannot be
 * judged, a draft with two judgeable claims and one uncited paragraph, a typed
 * draft, a record stored under another file's id, and a file that is not JSON.
 * The real root-taking `evaluateCandidates` runs five times in a row (fast, a
 * sample of one, a run whose new verdict fails, a run with no credential, an
 * invalid sample size), the tree is copied, and the directory is removed before
 * any case runs. In memory the SAME five run through `evaluateCandidatesFrom`:
 * the queue and sources are answered from the copy, and the judge's cache and
 * the report from a map that starts EMPTY, as the disk's did.
 *
 * WHAT RUNS FOR REAL IN MEMORY. The id listing and sort, the tolerant record
 * read with its admission and sanitizing, the reference hashes, the evidence
 * reader with its per-run memo, every observation, the provider check, the
 * judge configuration, the sample, the judge with its cache, the generic
 * failure wording, the counts and the report write. The doubles answer raw
 * facts only. No candidate, evidence, verdict or report is handed in.
 *
 * WHAT IS NOT SHOWN. The `eval --candidates` command, which still takes a root.
 * The default sample size is the root form's own. The doubles have no links
 * and confine nothing; the in-memory report write replaces a map entry and
 * shows nothing about atomicity or the writer's parent checks.
 */

import { createHash } from "node:crypto";
import { vi, afterAll, beforeAll, beforeEach, describe, expect, it, setSystemTime, type Mock } from "bun:test";
import { restoreEnv, stubEnv } from "../stubs.js";
import { expectMintingDirectoryRemoved } from "./minted-directory.js";

vi.mock("../../src/utils/llm.js", () => ({ callClaude: vi.fn() }));

import { evaluateCandidates, evaluateCandidatesFrom, type CandidateEvalSources } from "../../src/eval/candidates.js";
import { heldText, mintCopied, mintOnceThenRemove, enoent, writeFiles, type Copy, type Minted } from "./copied-project.js";
import type { CandidateAssessment, CandidateEvalReport } from "../../src/eval/candidate-types.js";
import { tempRootTracker } from "../temp-roots.js";
import { callClaude } from "../../src/utils/llm.js";

const PREFIX = "candidate-eval-";
const QUEUE = ".llmwiki/candidates";
const REPORT = ".llmwiki/eval/candidates-latest.json";
const CACHE = ".llmwiki/eval/citation-cache.jsonl";
const AT = "2026-03-04T05:06:07.000Z";
const MEMORY_ROOT = "/memory-project";
const sha = (text: string): string => createHash("sha256").update(text).digest("hex");
const REF = "Evidence first line.\nEvidence second line.\n";
const GOOD_BODY = "Supported claim. ^[ref.md:1-1]\n\nSecond claim. ^[ref.md:2-2]\n\nUncited prose.";
const POOR_BODY = "Changed claim. ^[changed.md:1-1]\n\nMissing claim. ^[ghost.md:1-1]\n\nOut of range. ^[ref.md:9-9]";
const record = (id: string, more: Record<string, unknown>): string =>
  JSON.stringify({ id, title: id, slug: `${id}-slug`, summary: "", sources: [], generatedAt: "2026-01-02T03:04:05.000Z", ...more });
const GOOD = record("b-good", { body: GOOD_BODY, sourceStates: { "ref.md": { hash: sha(REF) } } });
const POOR = record("a-poor", { body: POOR_BODY, targetDirectory: "queries", sourceStates: { "changed.md": { hash: "0".repeat(64) } } });
const FILES: Record<string, string> = {
  "sources/ref.md": REF, "sources/changed.md": "now different\n",
  [`${QUEUE}/b-good.json`]: GOOD, [`${QUEUE}/a-poor.json`]: POOR,
  [`${QUEUE}/c-typed.json`]: record("c-typed", { body: GOOD_BODY, targetEntityType: "papers" }),
  [`${QUEUE}/d-copied.json`]: GOOD, [`${QUEUE}/e-broken.json`]: "not-json", [`${QUEUE}/notes.txt`]: "not a record",
};
const MISMATCHED = "Candidate is missing, malformed, or has a mismatched file id.";
const SKIPPED = [
  { id: "c-typed", reason: "Typed profile candidates are outside this evaluation scope." },
  { id: "d-copied", reason: MISMATCHED }, { id: "e-broken", reason: MISMATCHED },
];
const REFERENCES = [
  { id: "a-poor", target: "queries/a-poor-slug", generatedAt: "2026-01-02T03:04:05.000Z", revision: sha(POOR), contentHash: sha(POOR_BODY) },
  { id: "b-good", target: "concepts/b-good-slug", generatedAt: "2026-01-02T03:04:05.000Z", revision: sha(GOOD), contentHash: sha(GOOD_BODY) },
];
/** Each observation before any judging: draft, paragraph, status, evidence status, reason. */
const OBSERVED = [
  ["a-poor", 1, "unjudgeable", "changed", "Source changed since candidate generation; regenerate or review the new evidence."],
  ["a-poor", 2, "unjudgeable", "unavailable", "Source is missing, unreadable, or outside sources/."],
  ["a-poor", 3, "unjudgeable", "unrecorded", "Citation line range is outside the current source."],
  ["b-good", 1, "eligible", "matches-generation", undefined],
  ["b-good", 2, "eligible", "matches-generation", undefined],
  ["b-good", 3, "unjudgeable", undefined, "Prose has no usable citation."],
];
const NO_CREDENTIAL = 'OPENAI_API_KEY environment variable is required for the "openai" provider.\n  Set one with: export OPENAI_API_KEY=<your-key>';
const JUDGE_FAILED = "Citation judge failed; no support verdict is available.";
const JUDGE_UNAVAILABLE = "Judge unavailable; see judgeUnavailable for configuration guidance.";
const FAST_KEYS = ["selection", "suite", "timestamp", "evidencePolicy", "candidates", "skippedCandidates", "coverage", "meanScore", "assessments"];

/** What the stub does next, call by call: resolve with a verdict text, or reject. When empty it resolves with a score of 2. */
const queued: Array<string | Error> = [];
const log: string[] = [];
const SUPPORTED = JSON.stringify({ score: 2, reason: "Stub supported." });
function modelStub(): Promise<string> {
  const next = queued.shift() ?? SUPPORTED;
  return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
}
const calls = (): number => (callClaude as unknown as Mock<typeof callClaude>).mock.calls.length;
const offline = (): void => { stubEnv("LLMWIKI_PROVIDER", "offline"); };
const withoutCredential = (): void => { stubEnv("LLMWIKI_PROVIDER", "openai"); stubEnv("OPENAI_API_KEY", ""); };

type Evaluate = (suite: "fast" | "full", sampleSize?: number) => Promise<CandidateEvalReport>;
/** What one run gave: its report or the message it rejected with, and how often the stub was asked. */
interface Run { report?: CandidateEvalReport; error?: string; asked: number }
async function attempt(evaluate: Evaluate, suite: "fast" | "full", sampleSize?: number, ...planned: Array<string | Error>): Promise<Run> {
  queued.splice(0, queued.length, ...planned);
  const before = calls();
  const settled = await evaluate(suite, sampleSize).then((report) => ({ report }), (error: Error) => ({ error: error.message }));
  return { ...settled, asked: calls() - before };
}

/** Five runs in a row: fast, a sample of one, a run whose new verdict fails, a run with no credential, then an invalid sample size. */
async function fiveRuns(evaluate: Evaluate): Promise<Run[]> {
  offline();
  const runs = [await attempt(evaluate, "fast"), await attempt(evaluate, "full", 1), await attempt(evaluate, "full", undefined, new Error("planted provider failure"))];
  withoutCredential();
  runs.push(await attempt(evaluate, "full"), await attempt(evaluate, "full", 0));
  offline();
  return runs;
}

const tracker = tempRootTracker();
let project: Minted<Run[]>;
beforeAll(() => { setSystemTime(new Date(AT)); (callClaude as unknown as Mock<typeof callClaude>).mockImplementation(modelStub); });
beforeEach(() => { offline(); (callClaude as unknown as Mock<typeof callClaude>).mockReset().mockImplementation(modelStub); log.length = 0; });
afterAll(() => { restoreEnv(); setSystemTime(); });
mintOnceThenRemove(tracker, async () => {
  project = await mintCopied(tracker, PREFIX, (root) => writeFiles(root, FILES), (root) => fiveRuns((suite, sampleSize) => evaluateCandidates(root, suite, sampleSize)));
});

/** The evaluator's four sources over a copy: the queue and sources from the copy, the cache and report in `texts`. Each write is logged. */
function sourcesOver(copy: Copy, texts: Map<string, string>): CandidateEvalSources {
  const held = (location: string): string => location.slice(MEMORY_ROOT.length + 1);
  const resolves = (location: string): boolean => copy.files.has(held(location)) || copy.listings.has(held(location));
  const written = (kind: string, rel: string, text: string): void => { log.push(`${kind} ${rel}`); texts.set(rel, text); };
  return {
    candidates: {
      leaf: async (relDir, fileName) => ({ location: `memory:${fileName}`, readText: async () => heldText(copy, `${relDir}/${fileName}`) }),
      directory: async (relDir) => {
        const entries = copy.listings.get(relDir);
        return entries === undefined ? null : { listEntries: async () => entries, exists: async () => true };
      },
    },
    sources: {
      readText: async (location) => heldText(copy, held(location)),
      locations: { sourcesDir: `${MEMORY_ROOT}/sources`, realPath: async (location) => (resolves(location) ? location : Promise.reject(enoent())) },
    },
    judgeCache: {
      reads: { existsSync: (rel) => texts.has(rel), readText: async (rel) => texts.get(rel) ?? Promise.reject(enoent()) },
      writes: {
        appendText: async (rel, text) => written("append", rel, `${texts.get(rel) ?? ""}${text}`),
        makeDirectoryTree: async () => {},
        removeFile: () => Promise.reject(new Error("the evaluator never removes a file")),
      },
    },
    report: { writeAtomic: async (rel, text) => written("report", rel, text) },
  };
}
const inMemory = (sources: CandidateEvalSources): Evaluate => (suite, sampleSize = 20) => evaluateCandidatesFrom(sources, suite, sampleSize);
/** The disk's run at `index`. A case that asks for a run the fixture did not record fails here, at once. */
function runAt(index: number): Run {
  const run = project.onDisk[index];
  if (run === undefined) throw new Error(`run ${index + 1} was not recorded`);
  return run;
}
/** The report of the disk's run at `index`. A case that expects a report from a run that rejected fails here, with the rejection's message. */
function reportAt(index: number): CandidateEvalReport {
  const { report, error } = runAt(index);
  if (report === undefined) throw new Error(`run ${index + 1} gave no report: ${error}`);
  return report;
}
const observedIn = (report: CandidateEvalReport): unknown[][] =>
  report.assessments.map((item) => [item.candidate.id, item.paragraph, item.status, item.evidence?.status, item.reason]);
const coverageOf = (report: CandidateEvalReport): unknown[] => {
  const c = report.coverage;
  return [c.proseParagraphs, c.citedParagraphs, c.eligiblePairs, c.selectedPairs, c.judgedPairs, c.unjudgeable, c.judgeErrors, report.meanScore];
};
/** The judgeable observations of a report, the one with the lower id first: the order the sample takes them in. */
const judgeable = (report: CandidateEvalReport): CandidateAssessment[] =>
  report.assessments.filter((item) => item.candidate.id === "b-good" && item.paragraph < 3).sort((left, right) => (left.id < right.id ? -1 : 1));
/** The two judgeable observations by name. Fails at once unless there are exactly two. */
function pairOf(found: CandidateAssessment[]): { lower: CandidateAssessment; higher: CandidateAssessment } {
  const [lower, higher] = found;
  if (lower === undefined || higher === undefined || found.length !== 2) throw new Error(`expected two judgeable observations, found ${found.length}`);
  return { lower, higher };
}

describe("the pending-candidate evaluator over a copy and an empty map, with the directory gone", () => {
  it("C1 runs after the minting directory was removed", () => {
    expectMintingDirectoryRemoved(project.dir, PREFIX);
  });

  it("C2 gives what the disk gave for all five runs, and leaves the report and the cache the disk was left with", async () => {
    const texts: Map<string, string> = new Map();
    const runs = await fiveRuns(inMemory(sourcesOver(project.copy, texts)));
    expect(runs).toStrictEqual(project.onDisk);
    expect([...texts.keys()].sort()).toEqual([REPORT, CACHE].sort());
    for (const rel of [REPORT, CACHE]) expect([rel, texts.get(rel)]).toEqual([rel, project.copy.files.get(rel)]);
    expect(log).toEqual([`report ${REPORT}`, `append ${CACHE}`, `report ${REPORT}`, `report ${REPORT}`, `report ${REPORT}`]);
  });

  it("C3 the fast report: its keys, the queue in id order with three skips, each draft's identity, and every observation", () => {
    const first = runAt(0);
    const report = reportAt(0);
    expect([first.asked, first.error, Object.keys(report)]).toEqual([0, undefined, FAST_KEYS]);
    expect([report.selection, report.suite, report.timestamp, report.evidencePolicy]).toEqual(["candidates", "fast", AT, "current-sources"]);
    expect([report.skippedCandidates, report.candidates]).toStrictEqual([SKIPPED, REFERENCES]);
    expect(observedIn(report)).toEqual(OBSERVED);
    expect(coverageOf(report)).toEqual([6, 5, 2, 0, 0, 4, 0, null]);
  });

  it("C4 a sample of one judges the lower id and marks the other not sampled, with the stub asked once", () => {
    const report = reportAt(1);
    const { lower, higher } = pairOf(judgeable(report));
    expect([runAt(1).asked, lower.status, higher.status, higher.judgement]).toEqual([1, "judged", "not-sampled", undefined]);
    expect(lower.judgement).toMatchObject({ score: 2, reason: "Stub supported.", model: "offline-v1", timestamp: AT, pageSlug: `candidate:b-good@${sha(GOOD)}`, citedFile: "ref.md" });
    expect(coverageOf(report)).toEqual([6, 5, 2, 1, 1, 4, 0, 2]);
  });

  it("C5 the next full run reuses the cached verdict and reports the failed new one in generic words", () => {
    const report = reportAt(2);
    const { lower, higher } = pairOf(judgeable(report));
    const cachedVerdict = pairOf(judgeable(reportAt(1))).lower.judgement;
    expect([runAt(2).asked, lower.status, lower.judgement, higher.status, higher.reason]).toEqual([1, "judged", cachedVerdict, "judge-error", JUDGE_FAILED]);
    expect(JSON.stringify(report)).not.toContain("planted provider failure");
    expect(coverageOf(report)).toEqual([6, 5, 2, 2, 1, 4, 1, 2]);
  });

  it("C6 with no credential the judge is not configured: the guidance is recorded once, both pairs are judge errors, and the stub is not asked", () => {
    const report = reportAt(3);
    expect([runAt(3).asked, report.judgeUnavailable, Object.keys(report)]).toEqual([0, NO_CREDENTIAL, [...FAST_KEYS, "judgeUnavailable"]]);
    expect(judgeable(report).map((item) => [item.status, item.reason, item.judgement])).toEqual(Array(2).fill(["judge-error", JUDGE_UNAVAILABLE, undefined]));
    expect(coverageOf(report)).toEqual([6, 5, 2, 2, 0, 4, 2, null]);
  });

  it("C7 an invalid sample size rejects before the project is asked, and the report on disk is still the fourth run's exact JSON", () => {
    expect(runAt(4)).toStrictEqual({ asked: 0, error: "Sample size must be a positive safe integer" });
    expect(project.copy.files.get(REPORT)).toBe(JSON.stringify(reportAt(3), null, 2));
    expect(project.copy.files.get(CACHE)).toBe(`${JSON.stringify(pairOf(judgeable(reportAt(1))).lower.judgement)}\n`);
  });

  it("C8 leaves the queue and the sources as they were written", () => {
    for (const [rel, text] of Object.entries(FILES)) expect([rel, project.copy.files.get(rel)]).toEqual([rel, text]);
    const queueNames = (project.copy.listings.get(QUEUE) ?? []).map((entry) => entry.name).sort();
    expect(queueNames).toEqual(["a-poor.json", "b-good.json", "c-typed.json", "d-copied.json", "e-broken.json", "notes.txt"]);
  });
});

describe("the evaluator's failures, in memory", () => {
  const untouched = (texts: Map<string, string>): CandidateEvalSources => new Proxy(sourcesOver(project.copy, texts), { get: (_target, step) => { throw new Error(`${String(step)} was asked`); } });

  it("F1 an invalid sample size rejects before any source is taken, for a fraction and for zero", async () => {
    for (const size of [0, 1.5, -1]) await expect(evaluateCandidatesFrom(untouched(new Map()), "full", size)).rejects.toThrow("Sample size must be a positive safe integer");
  });

  it("F2 a cache that cannot be read is reported in generic words, not thrown, and the report is still written", async () => {
    const texts = new Map<string, string>([[CACHE, "held"]]);
    const sources = sourcesOver(project.copy, texts);
    sources.judgeCache.reads.readText = async () => { throw new Error("planted cache failure at /private/path"); };
    const report = await evaluateCandidatesFrom(sources, "full", 20);
    expect([report.judgeUnavailable, calls()]).toEqual(["Cannot configure citation judge; check provider settings and the evaluation cache.", 0]);
    expect(texts.get(REPORT)).toBe(JSON.stringify(report, null, 2));
    expect(texts.get(REPORT)).not.toContain("/private/path");
  });

  it("F3 a queue that cannot be listed, a leaf that cannot be resolved and a report that cannot be written each reject with their own error", async () => {
    const [unlisted, unresolved, unwritten] = [new Error("planted listing failure"), new Error("planted resolution failure"), new Error("planted report failure")];
    const listing = sourcesOver(project.copy, new Map());
    listing.candidates.directory = async () => ({ exists: async () => true, listEntries: async () => { throw unlisted; } });
    const resolving = sourcesOver(project.copy, new Map());
    resolving.candidates.leaf = async () => { throw unresolved; };
    const writing = sourcesOver(project.copy, new Map());
    writing.report.writeAtomic = async () => { throw unwritten; };
    await expect(evaluateCandidatesFrom(listing, "fast", 20)).rejects.toBe(unlisted);
    await expect(evaluateCandidatesFrom(resolving, "fast", 20)).rejects.toBe(unresolved);
    await expect(evaluateCandidatesFrom(writing, "fast", 20)).rejects.toBe(unwritten);
  });

  it("F4 reads each cited source once in a run, however many drafts and paragraphs cite it", async () => {
    const sources = sourcesOver(project.copy, new Map());
    const reads: string[] = [];
    const readText = sources.sources.readText;
    sources.sources.readText = async (location) => { reads.push(location.slice(MEMORY_ROOT.length + 1)); return readText(location); };
    await evaluateCandidatesFrom(sources, "fast", 20);
    expect(reads.sort()).toEqual(["sources/changed.md", "sources/ref.md"]);
  });

  it("F5 a leaf that resolves but cannot be read is a skip, not a failure", async () => {
    const sources = sourcesOver(project.copy, new Map());
    const leaf = sources.candidates.leaf;
    sources.candidates.leaf = async (relDir, fileName) => (fileName === "b-good.json" ? { location: "memory:unreadable", readText: async () => { throw enoent(); } } : leaf(relDir, fileName));
    const report = await evaluateCandidatesFrom(sources, "fast", 20);
    expect(report.skippedCandidates).toStrictEqual([{ id: "b-good", reason: MISMATCHED }, ...SKIPPED]);
    expect(report.candidates.map((item) => item.id)).toEqual(["a-poor"]);
  });
});
