/**
 * @file test/storage/eval-history-thresholds-binding.test.ts
 * @description The evaluation's three history readers and its threshold check
 * as WHOLE consumers with no project directory: `loadHistoryFrom`,
 * `loadPreviousReportFrom`, `loadLastFullReportFrom` and `checkThresholdsFrom`,
 * over `EvalFileReads`. They exist only after those four were given reads of
 * their own, so this file has NO before-edit run.
 *
 * HOW IT IS BUILT. Three default-profile projects are minted on real disk: one
 * with a history that holds a full run, two fast runs, a blank line and a line
 * that is not JSON, beside a thresholds file that sets all eight keys; one
 * whose history ends in a torn line, beside an EMPTY thresholds file; and one
 * with neither file. Every file is written with its directories, so no fixture
 * needs a directory made for it. The real root-taking readers and check
 * answer. Each tree is copied as raw text and the directories are removed
 * before any case runs.
 *
 * WHAT RUNS FOR REAL IN MEMORY. The line split and filter, `slice(-n)`, the
 * JSON parse and its skips, the backward search for a full run, the YAML load,
 * every comparison and every rendered message. The double answers two raw
 * facts: whether a path is held, and a held file's text. No parsed report,
 * configuration or violation is handed in.
 *
 * WHAT IS NOT SHOWN. `appendHistory`, `collectStats` and `runEval`, which still
 * take a project root; what a directory in the file's place does on disk
 * (pinned in `eval-reads.test.ts`); and anything about links or confinement.
 * T3's malformed YAML is PLANTED in a copy, not minted.
 */

import { describe, expect, it } from "bun:test";
import type { EvalFileReads } from "../../src/eval/file-reads.js";
import { loadHistory, loadHistoryFrom, loadLastFullReport, loadLastFullReportFrom, loadPreviousReport, loadPreviousReportFrom } from "../../src/eval/stats.js";
import { checkThresholds, checkThresholdsFrom } from "../../src/eval/thresholds.js";
import type { EvalReport } from "../../src/eval/types.js";
import { makeEvalReport } from "../fixtures/eval-report.js";
import { tempRootTracker } from "../temp-roots.js";
import { expectRemovedDefaultCopies, heldText, mintCopied, mintOnceThenRemove, writeFiles, type Copy, type Minted } from "./copied-project.js";

const PREFIX = "eval-history-thresholds-";
const HISTORY = ".llmwiki/eval/history.jsonl";
const THRESHOLDS = ".llmwiki/eval/thresholds.yaml";
const [FULL, FAST_ONE, FAST_TWO] = ['{"suite":"full","timestamp":"t1"}', '{"suite":"fast","timestamp":"t2"}', '{"suite":"fast","timestamp":"t3"}'];
/** Four lines once the blank one is dropped: full, fast, not JSON, fast. */
const KEPT_HISTORY = `${FULL}\n${FAST_ONE}\n\n{ not json\n${FAST_TWO}\n`;
const TORN_HISTORY = `${FULL}\n${FAST_ONE}\n{"suite":"fa`;
const ALL_EIGHT = [
  "health_score: 95", "citation_coverage_percent: 90", "citation_precision_percent: 100", "citation_support_mean: 1.5",
  "citation_judge_error_max: 0", "source_utilization_rate: 0.9", "source_warnings_max: 0", "claim_level_citation_rate: 0.75",
].join("\n");

/** A full-suite report that misses seven of the eight thresholds; its precision (100) meets its own. */
const REPORT: EvalReport = makeEvalReport({
  suite: "full",
  sourceUtilization: { totalSources: 3, citedSources: 2, uncitedSources: 1, utilizationRate: 0.667, perSource: [], warnings: ["leak.md: symlink source excluded"] },
  citationSupport: { sampledCount: 1, sampledHashes: [], totalCitations: 1, meanScore: 1.25, fullySupported: 0, partiallySupported: 1, unsupported: 0, judgeErrors: 2, judgements: [] },
});
const SUPPORT_VIOLATIONS = ["citation_support_mean 1.25 is below threshold 1.5", "citation_judge_errors 2 exceeds max 0"];
const OTHER_VIOLATIONS = [
  "health_score 90 is below threshold 95", "citation_coverage_percent 80.0% is below threshold 90%",
  "source_utilization_rate 66.7% is below threshold 90.0%", "source_warnings 1 exceeds max 0",
  "claim_level_citation_rate 50.0% is below threshold 75.0%",
];

/** Every answer the four consumers give for one project. */
interface Answers {
  all: EvalReport[]; lastTwo: EvalReport[]; zero: EvalReport[]; minusOne: EvalReport[];
  previous: EvalReport | null; lastFull: EvalReport | null; violations: string[];
}
type Project = Minted<Answers>;

/** The disk's answers, through the root-taking forms. */
const askedOnDisk = async (root: string): Promise<Answers> => ({
  all: await loadHistory(root), lastTwo: await loadHistory(root, 2), zero: await loadHistory(root, 0), minusOne: await loadHistory(root, -1),
  previous: await loadPreviousReport(root), lastFull: await loadLastFullReport(root), violations: await checkThresholds(REPORT, root),
});

/** The same seven questions, through the bodies, over `reads`. */
const askedOf = async (reads: EvalFileReads): Promise<Answers> => ({
  all: await loadHistoryFrom(reads), lastTwo: await loadHistoryFrom(reads, 2), zero: await loadHistoryFrom(reads, 0), minusOne: await loadHistoryFrom(reads, -1),
  previous: await loadPreviousReportFrom(reads), lastFull: await loadLastFullReportFrom(reads), violations: await checkThresholdsFrom(REPORT, reads),
});

const tracker = tempRootTracker();
let kept: Project;
let torn: Project;
let bare: Project;

mintOnceThenRemove(tracker, async () => {
  const minted = (files: Record<string, string>): Promise<Project> => mintCopied(tracker, PREFIX, (root) => writeFiles(root, files), askedOnDisk);
  kept = await minted({ [HISTORY]: KEPT_HISTORY, [THRESHOLDS]: `${ALL_EIGHT}\n` });
  torn = await minted({ [HISTORY]: TORN_HISTORY, [THRESHOLDS]: "" });
  bare = await minted({ "notes.txt": "no evaluation has run here\n" });
});

/** The two raw reads over a copy: whether the path is held, and a held file's text. Each call is logged. */
function readsOver(copy: Copy, events: string[]): EvalFileReads {
  return {
    existsSync: (rel) => { events.push(`exists ${rel}`); return copy.files.has(rel) || copy.listings.has(rel); },
    readText: async (rel) => { events.push(`read ${rel}`); return heldText(copy, rel); },
  };
}

/** `copy` with one file's text replaced: a raw text fact, planted. */
const withText = (copy: Copy, rel: string, text: string): Copy => ({ listings: copy.listings, files: new Map(copy.files).set(rel, text) });
const timestampsOf = (reports: EvalReport[]): string[] => reports.map((one) => one.timestamp);

describe("the history readers over copied projects, with the directories gone", () => {
  it("H1 runs after every minting directory was removed, on copies holding the raw history and thresholds texts", () => {
    expectRemovedDefaultCopies([kept, torn, bare], PREFIX);
    expect([kept.copy.files.get(HISTORY), torn.copy.files.get(THRESHOLDS), bare.copy.listings.has(".llmwiki")]).toEqual([KEPT_HISTORY, "", false]);
  });

  it("H2 answers all seven questions for every project exactly as the disk did", async () => {
    for (const project of [kept, torn, bare]) expect(await askedOf(readsOver(project.copy, []))).toEqual(project.onDisk);
  });

  it("H3 takes n as a count of trailing LINES handed to slice: 2 keeps one report, 0 keeps all, -1 drops the first", async () => {
    const reads = readsOver(kept.copy, []);
    expect(await loadHistoryFrom(reads)).toEqual([JSON.parse(FULL), JSON.parse(FAST_ONE), JSON.parse(FAST_TWO)]);
    expect(timestampsOf(await loadHistoryFrom(reads, 2))).toEqual(["t3"]);
    expect(timestampsOf(await loadHistoryFrom(reads, 0))).toEqual(["t1", "t2", "t3"]);
    expect(timestampsOf(await loadHistoryFrom(reads, -1))).toEqual(["t2", "t3"]);
  });

  it("H4 finds the last report and the last full run, asking whether the file is there and then reading it once each", async () => {
    const events: string[] = [];
    const reads = readsOver(kept.copy, events);
    expect(await loadPreviousReportFrom(reads)).toEqual({ suite: "fast", timestamp: "t3" });
    expect(await loadLastFullReportFrom(reads)).toEqual({ suite: "full", timestamp: "t1" });
    expect(events).toEqual([`exists ${HISTORY}`, `read ${HISTORY}`, `exists ${HISTORY}`, `read ${HISTORY}`]);
  });

  it("H5 treats a torn last line three ways: skipped, no previous report, the earlier full run still found", async () => {
    const reads = readsOver(torn.copy, []);
    expect(timestampsOf(await loadHistoryFrom(reads))).toEqual(["t1", "t2"]);
    expect(await loadPreviousReportFrom(reads)).toBeNull();
    expect((await loadLastFullReportFrom(reads))?.timestamp).toBe("t1");
  });

  it("H6 passes a read failure on untouched from each reader and from the check", async () => {
    const failure = new Error("planted read failure");
    const reads: EvalFileReads = { existsSync: () => true, readText: async () => { throw failure; } };
    await expect(loadHistoryFrom(reads)).rejects.toBe(failure);
    await expect(loadPreviousReportFrom(reads)).rejects.toBe(failure);
    await expect(loadLastFullReportFrom(reads)).rejects.toBe(failure);
    await expect(checkThresholdsFrom(REPORT, reads)).rejects.toBe(failure);
  });

  it("H7 answers empty, null, null and no violation where neither file exists, and attempts no read", async () => {
    const events: string[] = [];
    const { all, previous, lastFull, violations } = await askedOf(readsOver(bare.copy, events));
    expect([all, previous, lastFull, violations]).toEqual([[], null, null, []]);
    expect(events.filter((event) => event.startsWith("read "))).toEqual([]);
    expect(events.filter((event) => event === `exists ${HISTORY}`)).toHaveLength(6);
  });
});

describe("the threshold check over the same copies", () => {
  it("T1 reports seven unmet thresholds in the fixed order, after one existence question and one read", async () => {
    const events: string[] = [];
    const violations = await checkThresholdsFrom(REPORT, readsOver(kept.copy, events));
    expect(violations).toEqual([...OTHER_VIOLATIONS.slice(0, 2), ...SUPPORT_VIOLATIONS, ...OTHER_VIOLATIONS.slice(2)]);
    expect(events).toEqual([`exists ${THRESHOLDS}`, `read ${THRESHOLDS}`]);
  });

  it("T2 leaves the two judge thresholds out for a report without judge data, and finds nothing in an empty file", async () => {
    const fast: EvalReport = { ...REPORT, suite: "fast", citationSupport: undefined };
    expect(await checkThresholdsFrom(fast, readsOver(kept.copy, []))).toEqual(OTHER_VIOLATIONS);
    expect(await checkThresholdsFrom(REPORT, readsOver(torn.copy, []))).toEqual([]);
  });

  it("T3 rejects with the parser's own error for malformed YAML", async () => {
    const reads = readsOver(withText(kept.copy, THRESHOLDS, "health_score: [unclosed\n"), []);
    await expect(checkThresholdsFrom(REPORT, reads)).rejects.toMatchObject({ name: "YAMLException" });
  });
});
