/**
 * @file test/storage/eval-cli-binding.test.ts
 * @description The six `llmwiki eval` command handlers as WHOLE consumers with
 * no project directory: `evalCommandFrom`, `evalCacheClearCommandFrom`,
 * `evalCacheShowCommandFrom`, `evalReportCommandFrom`, `evalHistoryCommandFrom`
 * and `evalJudgementsCommandFrom`. These bodies exist only after the handlers
 * were given sources of their own, so this file has NO before-edit run, and
 * agreement between the two forms of one body is not, by itself, proof of what
 * the handlers did before the edit. The written-out parts are the independent
 * ones: the fixed messages, the exit behaviour, the threshold wording, the one
 * judgement and its JSON, and which suites the history holds. The terminal
 * report, the history table and the cache summary are NOT hand-worked; they
 * are compared with what the disk printed.
 *
 * THE HOST IS STUBBED, THE PROJECT IS NOT. `console.log` is captured and
 * `process.exit` throws, so a run that would end the process is seen as a
 * rejection after its output. Both are the host's, not project storage. The
 * model module is mocked and the provider is `offline`.
 *
 * HOW IT IS BUILT. One project (two pages citing one source, a thresholds
 * file, one pending draft) is minted on real disk. The real handlers run
 * sixteen steps in a row with the working directory pointed at it; the tree is
 * copied; the directory is removed before any case runs. In memory the SAME
 * steps run through the `…From` handlers: pages, sources, the queue and lint
 * facts from the copy, and the evaluation files from a map that starts with
 * the thresholds text only.
 *
 * WHAT RUNS FOR REAL IN MEMORY. Option resolution, the whole live pipeline,
 * the whole pending-candidate evaluator, the history and cache readers, the
 * cache clear, every formatter, and the exit decisions.
 *
 * WHAT IS NOT SHOWN. Commander's registration and the error wrapper around
 * each handler in `src/cli/eval-commands.ts`; the `--provider` option; the
 * built binary. The doubles have no links and confine nothing.
 */

import { realpath } from "node:fs/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi, setSystemTime, type Mock } from "bun:test";
import { restoreEnv, stubEnv } from "../stubs.js";
import { NO_ENTITIES, lintSourcesOver } from "./lint-sources-doubles.js";

vi.mock("../../src/utils/llm.js", () => ({ callClaude: vi.fn() }));

import evalCommand, {
  evalCacheClearCommand, evalCacheClearCommandFrom, evalCacheShowCommand, evalCacheShowCommandFrom, evalCommandFrom, evalHistoryCommand,
  evalHistoryCommandFrom, evalJudgementsCommand, evalJudgementsCommandFrom, evalReportCommand, evalReportCommandFrom, type EvalCommandSources,
} from "../../src/commands/eval.js";
import { enoent, entityScansOf, heldText, mintCopied, mintOnceThenRemove, unasked, writeFiles, type Copy, type Minted } from "./copied-project.js";
import type { CitationJudgeCacheFiles } from "../../src/eval/citation-support.js";
import { callClaude } from "../../src/utils/llm.js";
import { expectMintingDirectoryRemoved } from "./minted-directory.js";
import type { EvalFileReads } from "../../src/eval/file-reads.js";
import type { LocalEntry } from "../../src/storage/legacy-local-reads.js";
import { tempRootTracker } from "../temp-roots.js";

const PREFIX = "eval-cli-";
const EVAL_DIR = ".llmwiki/eval";
const HISTORY = `${EVAL_DIR}/history.jsonl`;
const CACHE = `${EVAL_DIR}/citation-cache.jsonl`;
const THRESHOLDS = `${EVAL_DIR}/thresholds.yaml`;
const CANDIDATE_REPORT = `${EVAL_DIR}/candidates-latest.json`;
const AT = "2026-03-04T05:06:07.000Z";
const THRESHOLDS_TEXT = "citation_support_mean: 1.5\n";
const page = (...paragraphs: string[]): string => `---\ntitle: T\nsummary: S.\n---\n\n${paragraphs.join("\n\n")}\n`;
const claim = (n: number): string => `Claim ${n}. ^[src.md:${n}-${n}]`;
const DRAFT = JSON.stringify({ id: "draft", title: "Draft", slug: "draft-slug", summary: "", sources: [], generatedAt: "2026-01-02T03:04:05.000Z", body: "Draft claim. ^[src.md:1-1]" });
const FILES: Record<string, string> = {
  [THRESHOLDS]: THRESHOLDS_TEXT, ".llmwiki/candidates/draft.json": DRAFT,
  "wiki/queries/ask.md": page(claim(3)), "wiki/concepts/one.md": page(claim(1), claim(2)),
  "sources/src.md": ["line 1", "line 2", "line 3", ""].join("\n"),
};
/** The one verdict the full run records: the lowest pair hash (claim 3), under the offline model's cache key (from `keys.py`), scored 0. */
const JUDGED = {
  claimHash: "60c1dffae45ee122", pageSlug: "ask", citedFile: "src.md", lineStart: 3, lineEnd: 3, claimText: "Claim 3.",
  spanText: "line 3", score: 0, reason: "Stub verdict 0.", model: "offline-v1", timestamp: AT,
};
const NO_HISTORY = "No eval history found. Run `llmwiki eval` to record the first run.";
const EXITED = "process.exit(1)";

const verdict = (score: number): string => JSON.stringify({ score, reason: `Stub verdict ${score}.` });
const REFUSAL = new Error("planted provider failure");
/** What the model stub returns or throws next, call by call. When empty it returns a verdict of 2. */
const queued: Array<string | Error> = [];
/** Every text the handlers printed since the last step began. */
const printed: string[] = [];
async function modelStub(): Promise<string> {
  const next = queued.shift();
  if (next instanceof Error) throw next;
  return next === undefined ? verdict(2) : next;
}
/** Capture what a handler prints, and turn an exit into a rejection so the test process survives it. */
function stubHost(): void {
  vi.spyOn(console, "log").mockImplementation((text?: unknown) => { printed.push(String(text)); });
  vi.spyOn(process, "exit").mockImplementation((code) => { throw new Error(`process.exit(${String(code)})`); });
}

type EvalOptions = NonNullable<Parameters<typeof evalCommand>[0]>;
type ReportOptions = NonNullable<Parameters<typeof evalReportCommand>[0]>;
type HistoryOptions = NonNullable<Parameters<typeof evalHistoryCommand>[0]>;
type JudgementsOptions = NonNullable<Parameters<typeof evalJudgementsCommand>[0]>;
/** The six handlers, in whichever form a run uses. */
interface Handlers {
  evaluate(options: EvalOptions): Promise<void>;
  cacheClear(): Promise<void>;
  cacheShow(): Promise<void>;
  report(options: ReportOptions): Promise<void>;
  history(options: HistoryOptions): Promise<void>;
  judgements(options: JudgementsOptions): Promise<void>;
}
/** What one step did: what it printed, the message it rejected with if it did, and the exit status it left. */
interface Step { printed: string[]; error?: string; exitStatus: typeof process.exitCode }
async function step(run: () => Promise<void>, ...planned: Array<string | Error>): Promise<Step> {
  queued.splice(0, queued.length, ...planned);
  printed.length = 0;
  process.exitCode = 0;
  const failure = await run().then(() => ({}), (error: Error) => ({ error: error.message }));
  const exitStatus = process.exitCode;
  process.exitCode = 0;
  return { printed: [...printed], ...failure, exitStatus };
}

/** Sixteen steps in a row over one project, each named for what it exercises. */
async function allSteps(run: Handlers) {
  return {
    reportBefore: await step(() => run.report({})),
    cacheShowBefore: await step(() => run.cacheShow()),
    cacheClearBefore: await step(() => run.cacheClear()),
    fast: await step(() => run.evaluate({})),
    fullJson: await step(() => run.evaluate({ suite: "full", sample: "1", out: "json" }), verdict(0)),
    reportJson: await step(() => run.report({ out: "json" })),
    historyJson: await step(() => run.history({ n: "1", out: "json" })),
    historyTable: await step(() => run.history({})),
    scoredZero: await step(() => run.judgements({ score: "0", out: "json" })),
    scoredTwo: await step(() => run.judgements({ score: "2", out: "json" })),
    shownForPage: await step(() => run.judgements({ page: "ask", n: "1" })),
    cacheShow: await step(() => run.cacheShow()),
    candidates: await step(() => run.evaluate({ candidates: true, suite: "full" }), REFUSAL),
    cacheClear: await step(() => run.cacheClear()),
    cacheShowAfter: await step(() => run.cacheShow()),
    badSample: await step(() => run.evaluate({ sample: "0" })),
  };
}
type Steps = Awaited<ReturnType<typeof allSteps>>;

const onDisk: Handlers = {
  evaluate: (options) => evalCommand(options), cacheClear: () => evalCacheClearCommand(), cacheShow: () => evalCacheShowCommand(),
  report: (options) => evalReportCommand(options), history: (options) => evalHistoryCommand(options), judgements: (options) => evalJudgementsCommand(options),
};
/** What the disk gave: the project's real root, for the doubles that key on it, and every step. */
interface OnDisk { real: string; steps: Steps }
const tracker = tempRootTracker();
let project: Minted<OnDisk>;
const offline = (): void => { stubEnv("LLMWIKI_PROVIDER", "offline"); stubEnv("LLMWIKI_EMBEDDING_PROVIDER", ""); };

beforeAll(() => { setSystemTime(new Date(AT)); offline(); (callClaude as unknown as Mock<typeof callClaude>).mockImplementation(modelStub); });
beforeEach(() => { stubHost(); offline(); (callClaude as unknown as Mock<typeof callClaude>).mockReset().mockImplementation(modelStub); printed.length = 0; process.exitCode = 0; });
afterAll(() => { restoreEnv(); setSystemTime(); process.exitCode = 0; });
mintOnceThenRemove(tracker, async () => {
  stubHost();
  project = await mintCopied(tracker, PREFIX, (root) => writeFiles(root, FILES), async (root) => {
    vi.spyOn(process, "cwd").mockReturnValue(root);
    return { real: await realpath(root), steps: await allSteps(onDisk) };
  });
  vi.restoreAllMocks();
});

/** The evaluation files over a map of texts: the reads, the cache file's reads and writes, and the report replacement. */
function evalFilesIn(texts: Map<string, string>) {
  const reads: EvalFileReads = {
    readText: (rel) => (texts.has(rel) ? Promise.resolve(heldTextIn(texts, rel)) : Promise.reject(enoent())),
    existsSync: (rel) => texts.has(rel),
  };
  const cache: CitationJudgeCacheFiles = { reads, writes: {
    makeDirectoryTree: () => Promise.resolve(),
    removeFile: (rel) => (texts.delete(rel) ? Promise.resolve() : Promise.reject(enoent())),
    appendText: (rel, text) => { texts.set(rel, heldTextIn(texts, rel) + text); return Promise.resolve(); },
  } };
  return { reads, cache, report: { writeAtomic: (rel: string, text: string) => { texts.set(rel, text); return Promise.resolve(); } } };
}
/** A held text, or the empty text for a file not written yet. */
function heldTextIn(texts: Map<string, string>, rel: string): string {
  const text = texts.get(rel);
  return text === undefined ? "" : text;
}

type Queue = EvalCommandSources["candidates"]["candidates"];
type Scan = EvalCommandSources["live"]["stats"]["sourceReads"];
/** The pending queue over a copy: its directory listing, and each record's text. */
function queueOver(copy: Copy): Queue {
  const recordText = (rel: string) => async (): Promise<string> => heldText(copy, rel);
  const listing = (entries: LocalEntry[]) => ({ exists: () => Promise.resolve(true), listEntries: () => Promise.resolve(entries) });
  return {
    directory(relDir) {
      const entries = copy.listings.get(relDir);
      return Promise.resolve(entries === undefined ? null : listing(entries));
    },
    leaf(relDir, fileName) {
      return Promise.resolve({ location: `queue:${relDir}/${fileName}`, readText: recordText(`${relDir}/${fileName}`) });
    },
  };
}
/** The source scan's two reads over a copy: the configuration text (absent, so the default selection) and the listings under a directory. */
function scanOver(copy: Copy): Scan {
  const listingOf = async (rel: string) => {
    const entries = copy.listings.get(rel);
    if (entries === undefined) throw enoent();
    return entries;
  };
  return {
    realDirectory: async (relDir) => (copy.listings.has(relDir) ? { listEntries: (relative) => listingOf([relDir, relative].filter(Boolean).join("/")) } : null),
    readText: async (rel) => heldText(copy, rel),
    locate: unasked("scan.locate"), listNames: unasked("scan.listNames"), exists: unasked("scan.exists"), statNoFollow: unasked("scan.statNoFollow"),
    readConfinedFile: unasked("scan.readConfinedFile"), readConfinedPage: unasked("scan.readConfinedPage"),
  };
}

/** The six `…From` handlers over a copy of the project and a map of evaluation files. */
function inMemory(from: Minted<OnDisk>, texts: Map<string, string>): { handlers: Handlers; sources: EvalCommandSources } {
  const { copy, onDisk: { real } } = from;
  const { reads, cache, report } = evalFilesIn(texts);
  const under = (location: string): string => location.slice(real.length + 1);
  const resolves = (location: string): boolean => copy.files.has(under(location)) || copy.listings.has(under(location));
  const queue = queueOver(copy);
  const scan = scanOver(copy);
  const lint = (): EvalCommandSources["live"]["health"] => lintSourcesOver(from, [], NO_ENTITIES, { candidates: queue });
  const cited = { readText: async (location: string) => heldText(copy, under(location)), locations: {
    sourcesDir: `${real}/sources`, realPath: (location: string) => (resolves(location) ? Promise.resolve(location) : Promise.reject(enoent())),
  } };
  const sources: EvalCommandSources = {
    candidates: { candidates: queue, sources: cited, judgeCache: cache, report },
    live: {
      record: cache.writes, thresholds: reads, history: reads, citationSupport: { cache, pairs: { sources: cited, pages: lint().pages } },
      stats: { embeddings: { readLeafBytes: unasked("embeddings.readLeafBytes"), leafKind: async () => "absent", resolvePrivateDir: async () => "memory:private" }, pages: lint().pages, sourceReads: scan },
      graphHealth: entityScansOf(copy, real, () => {}), pageHealthDistribution: lint(), citationDepth: lint().pages,
      sourceUtilization: { pages: lint().pages, kindNoFollow: unasked("kindNoFollow"), locations: cited.locations, reads: scan },
      citationCoverage: { locations: cited.locations, pages: lint().pages }, health: lint(),
    },
  };
  const handlers: Handlers = {
    evaluate: (options) => evalCommandFrom(sources, options), cacheClear: () => evalCacheClearCommandFrom(cache), cacheShow: () => evalCacheShowCommandFrom(reads),
    report: (options) => evalReportCommandFrom(reads, options), history: (options) => evalHistoryCommandFrom(reads, options), judgements: (options) => evalJudgementsCommandFrom(reads, options),
  };
  return { handlers, sources };
}
const startingTexts = (): Map<string, string> => new Map([[THRESHOLDS, THRESHOLDS_TEXT]]);
/** The only text a step printed. Fails at once when the step printed none, or more than one. */
function onlyPrinted(one: Step): string {
  const [text] = one.printed;
  if (text === undefined || one.printed.length !== 1) throw new Error(`expected one printed text, found ${one.printed.length}`);
  return text;
}
const QUIET: Step = { printed: [], exitStatus: 0 };
const said = (text: string): Step => ({ printed: [text], exitStatus: 0 });

describe("the eval command handlers over a copy and a map of evaluation files, with the directory gone", () => {
  it("K1 runs after the minting directory was removed", () => {
    expectMintingDirectoryRemoved(project.dir, PREFIX);
  });

  it("K2 every step prints, rejects and exits as the disk's did, and leaves the files the disk was left with", async () => {
    const texts = startingTexts();
    expect(await allSteps(inMemory(project, texts).handlers)).toStrictEqual(project.onDisk.steps);
    expect([...texts.keys()].sort()).toEqual([CANDIDATE_REPORT, HISTORY, THRESHOLDS]);
    for (const rel of [CANDIDATE_REPORT, HISTORY, THRESHOLDS]) expect([rel, texts.get(rel)]).toEqual([rel, project.copy.files.get(rel)]);
    expect(project.copy.files.has(CACHE)).toBe(false);
  });

  it("K3 on a project with no history and no cache: the fixed messages, and an empty cache summary", () => {
    const { reportBefore, cacheClearBefore, cacheShowBefore } = project.onDisk.steps;
    expect([reportBefore, cacheClearBefore]).toStrictEqual([said(NO_HISTORY), said("No citation cache found.")]);
    expect(onlyPrinted(cacheShowBefore)).toContain("Citation Cache  ·  0 judgements");
    expect([cacheShowBefore.error, cacheShowBefore.exitStatus]).toEqual([undefined, 0]);
  });

  it("K4 a fast run prints one terminal report, does not exit, and is recorded", () => {
    const { fast } = project.onDisk.steps;
    expect([fast.error, fast.exitStatus, onlyPrinted(fast).startsWith("{")]).toEqual([undefined, 0, false]);
    expect(heldTextIn(project.copy.files, HISTORY).split("\n").filter(Boolean).map((line) => JSON.parse(line).suite)).toEqual(["fast", "full"]);
  });

  it("K5 a full run that breaks a threshold prints its JSON report, then exits the process with status 1", () => {
    const { fullJson } = project.onDisk.steps;
    const report = JSON.parse(onlyPrinted(fullJson));
    expect([fullJson.error, fullJson.exitStatus]).toEqual([EXITED, 0]);
    expect([report.suite, report.timestamp, report.thresholdViolations]).toEqual(["full", AT, ["citation_support_mean 0.00 is below threshold 1.5"]]);
    expect(report.citationSupport.judgements).toStrictEqual([JUDGED]);
  });

  it("K6 report re-displays the last recorded run exactly, and history returns the last run or a table", () => {
    const { fullJson, reportJson, historyJson, historyTable } = project.onDisk.steps;
    expect(reportJson).toStrictEqual(said(onlyPrinted(fullJson)));
    expect(JSON.parse(onlyPrinted(historyJson)).map((report: { suite: string }) => report.suite)).toEqual(["full"]);
    expect([historyTable.error, historyTable.exitStatus, onlyPrinted(historyTable) === onlyPrinted(historyJson)]).toEqual([undefined, 0, false]);
  });

  it("K7 judgements filters by score, page and count, as JSON or as a display", () => {
    const { scoredZero, scoredTwo, shownForPage, cacheShow } = project.onDisk.steps;
    expect([scoredZero, scoredTwo]).toStrictEqual([said(JSON.stringify([JUDGED], null, 2)), said("[]")]);
    expect(onlyPrinted(shownForPage)).toContain("[1/1] Page: ask  Score: 0");
    expect(onlyPrinted(cacheShow)).toContain("Citation Cache  ·  1 judgements");
  });

  it("K8 a pending-candidate run with a judge error prints its report and sets exit status 1 without exiting", () => {
    const { candidates } = project.onDisk.steps;
    const text = onlyPrinted(candidates);
    expect([candidates.error, candidates.exitStatus]).toEqual([undefined, 1]);
    expect(text.startsWith("Pending candidate citation support (advisory; not approval)")).toBe(true);
    expect([text.includes("Unjudgeable: 0; judge errors: 1."), text.includes(`Report: ${CANDIDATE_REPORT}`), text.includes(REFUSAL.message)]).toEqual([true, true, false]);
  });

  it("K9 clearing a present cache says so, and the summary is empty afterwards", () => {
    const { cacheClear, cacheShowAfter } = project.onDisk.steps;
    expect(cacheClear).toStrictEqual(said("Citation cache cleared."));
    expect(onlyPrinted(cacheShowAfter)).toContain("Citation Cache  ·  0 judgements");
  });

  it("K10 a bad --sample is refused with its message and nothing is printed", () => {
    expect(project.onDisk.steps.badSample).toStrictEqual({ ...QUIET, error: '--sample must be a positive integer (got "0")' });
  });
});

describe("the handlers' option and failure paths, in memory", () => {
  it("M1 a bad --sample is refused before any source is taken, for either branch", async () => {
    const untouched: EvalCommandSources = new Proxy(inMemory(project, startingTexts()).sources, { get: (_target, branch) => { throw new Error(`${String(branch)} was taken`); } });
    await expect(evalCommandFrom(untouched, { sample: "1.5" })).rejects.toThrow('--sample must be a positive integer (got "1.5")');
    await expect(evalCommandFrom(untouched, { sample: "none", candidates: true })).rejects.toThrow('--sample must be a positive integer (got "none")');
    expect(printed).toEqual([]);
  });

  it("M2 a pending-candidate run with a passing judge prints the written report as JSON and leaves the exit status alone", async () => {
    const texts = startingTexts();
    const run = await step(() => inMemory(project, texts).handlers.evaluate({ candidates: true, suite: "full", out: "json" }), verdict(2));
    expect([run.error, run.exitStatus, onlyPrinted(run)]).toEqual([undefined, 0, texts.get(CANDIDATE_REPORT)]);
    expect(JSON.parse(onlyPrinted(run)).coverage).toMatchObject({ eligiblePairs: 1, judgedPairs: 1, judgeErrors: 0 });
  });

  it("M3 a history file that cannot be read rejects report and history with its own error, and nothing is printed", async () => {
    const failure = new Error("planted history read failure");
    const unreadable: EvalFileReads = { existsSync: () => true, readText: () => Promise.reject(failure) };
    await expect(evalReportCommandFrom(unreadable, {})).rejects.toBe(failure);
    await expect(evalHistoryCommandFrom(unreadable, { out: "json" })).rejects.toBe(failure);
    expect(printed).toEqual([]);
  });
});
