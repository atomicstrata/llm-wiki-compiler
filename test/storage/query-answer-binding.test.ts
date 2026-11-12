/**
 * @file test/storage/query-answer-binding.test.ts
 * @description The WHOLE query-answer consumer, `generateAnswerFrom`, over the
 * bound composition `queryAnswerReadsOver`, with no project directory. This file
 * uses both, which exist only after the answer was given steps of its own, so it
 * has NO before-edit run.
 *
 * HOW IT IS BUILT. One small default-profile project (an index and two concept
 * pages, no embedding store) is minted on real disk once and COPIED into memory
 * BEFORE the disk ask, because the ask appends the activity log. The real root
 * `generateAnswer` then answers on disk, the disk's search-surface store load
 * and real path are taken, and the directory is removed before any case runs.
 * The answer LLM is the shared offering stub: the fallback selector is offered
 * the live pages and picks them all, and the answer echoes its grounding prompt.
 *
 * WHAT RUNS FOR REAL IN MEMORY. The answer body and, under the composition, the
 * REAL lower bodies: the index presence look, the profile load, the scoped
 * selection with its LLM fallback over live pages, hydration under the profile's
 * namespace directories, the answer-citation index and classification inside
 * the shared recovery boundary, and the activity-log formatting. What is
 * replayed: the store load outcome and the real path, taken from the disk.
 *
 * PUBLICATION is the bound `maybeSaveQueryPageFrom`, asked on EVERY grounded
 * answer. Every case here leaves `save` off, so it answers `{}` without touching
 * any of its seams; each seam here would log and throw if reached.
 * `query-publication-binding.test.ts` shows saving and staging.
 *
 * THE ROOT ROUTE IS UNCHANGED. Five root-taking steps are wrapped by pass-
 * through spies. The disk ask reaches all five; the bound route reaches none.
 *
 * NOT SHOWN HERE: the disk's confinement, links and caps, a usable embedding
 * store, a non-default profile, a journal that exists, or saving. The query
 * suites (`query-reads`, `query-hydrated-grounding`, `query-answer-citations*`,
 * `query-page-scope`, `query-publication-*`) show those. The doubles are not a
 * hosted store, not an access-control layer and not `ProjectStore`.
 */

import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi, type Mock } from "bun:test";
import { passThrough } from "./pass-through-mock.js";
import { offeringCallClaudeModule } from "../fixtures/typed-grounding.js";
import { generateAnswer, generateAnswerFrom } from "../../src/commands/query.js";
import { reportQueryAnswerCitations } from "../../src/commands/query-citation-report.js";
import { maybeSaveQueryPage } from "../../src/commands/query-publication.js";
import { queryAnswerReadsOver, type QueryAnswerReads, type QueryAnswerSources } from "../../src/commands/query-reads.js";
import type { QueryPublicationSources } from "../../src/commands/query-publication.js";
import { selectRelevantPages } from "../../src/commands/query-selection.js";
import { loadSelectedRefRecords } from "../../src/search/retrieval.js";
import { appendLog } from "../../src/utils/activity-log.js";
import { CONCEPTS_DIR, INDEX_FILE, LOG_FILE } from "../../src/utils/constants.js";
import { loadEmbeddingsForSearch } from "../../src/utils/embeddings-load.js";
import type { QueryResult } from "../../src/utils/types.js";
import { tempRootTracker } from "../temp-roots.js";
import { copiedCitationSourcesOf, copiedLocalReadsOf } from "./copied-local-reads.js";
import {
  absentJournalOf, effectiveProfileOf, entityScansOf, expectRemovedDefaultCopies, mintCopiedBeforeAsk,
  writeFiles, type Copy, type Minted, type Note,
} from "./copied-project.js";

const offered = { offered: [] as string[] };
// Copy the real modules first: vi.mock patches them in place, so a later read would see the mock.
const realQuerySelection = { ...(await import("../../src/commands/query-selection.js")) };
const realRetrieval = { ...(await import("../../src/search/retrieval.js")) };
const realQueryCitationReport = { ...(await import("../../src/commands/query-citation-report.js")) };
const realQueryPublication = { ...(await import("../../src/commands/query-publication.js")) };
const realActivityLog = { ...(await import("../../src/utils/activity-log.js")) };

vi.mock("../../src/utils/llm.js", () => offeringCallClaudeModule(offered));

vi.mock("../../src/commands/query-selection.js", () => passThrough(realQuerySelection, "selectRelevantPages"));
vi.mock("../../src/search/retrieval.js", () => passThrough(realRetrieval, "loadSelectedRefRecords"));
vi.mock("../../src/commands/query-citation-report.js", () => passThrough(realQueryCitationReport, "reportQueryAnswerCitations"));
vi.mock("../../src/commands/query-publication.js", () => passThrough(realQueryPublication, "maybeSaveQueryPage"));
vi.mock("../../src/utils/activity-log.js", () => passThrough(realActivityLog, "appendLog"));

/** The five root-taking steps the root route calls, in body order. */
const ROOT_STEPS = [selectRelevantPages, loadSelectedRefRecords, reportQueryAnswerCitations, maybeSaveQueryPage, appendLog]
  .map((step) => step as unknown as Mock<(...args: never[]) => unknown>);

const PREFIX = "query-answer-binding-";
const QUESTION = "How do alpha and beta relate?";
const SEED = {
  [INDEX_FILE]: "# Index\n\n- [[Alpha]]\n- [[Beta]]\n",
  [`${CONCEPTS_DIR}/alpha.md`]: "---\ntitle: Alpha\nsummary: First.\n---\n\nAlpha links [[Beta]].\n",
  [`${CONCEPTS_DIR}/beta.md`]: "---\ntitle: Beta\nsummary: Second.\n---\n\nBeta body.\n",
};

/** What the disk answered, the log it appended, and what a copy cannot hold: the real path and the store load. */
interface OnDisk { result: QueryResult; logText: string; real: string; embeddings: Awaited<ReturnType<typeof loadEmbeddingsForSearch>> }

const tracker = tempRootTracker();
let minted: Minted<OnDisk>;
let rootReached: boolean[];

/** The disk's answer for the project at `root`, with what the memory side must replay. */
async function askDisk(root: string): Promise<OnDisk> {
  const embeddings = await loadEmbeddingsForSearch(root);
  const result = await generateAnswer(root, QUESTION);
  return { result, logText: await readFile(path.join(root, LOG_FILE), "utf-8"), real: await realpath(root), embeddings };
}

beforeAll(async () => {
  ROOT_STEPS.forEach((step) => step.mockClear());
  minted = await mintCopiedBeforeAsk(tracker, PREFIX, (root) => writeFiles(root, SEED), askDisk);
  rootReached = ROOT_STEPS.map((step) => step.mock.calls.length > 0);
  await tracker.cleanup();
});
afterAll(() => tracker.cleanup());

/** What one memory answer recorded: the seam log, the appended log text, and each publication request. */
interface Recorded { log: string[]; appended: string[] }

/** Publication's seams, none of which a `save: false` answer may reach: each logs, then throws. */
const untouchedPublication = (note: Note): QueryPublicationSources => new Proxy({}, {
  get: (_target, seam) => () => { note(String(seam)); throw new Error(`publication ${String(seam)} reached without save`); },
}) as QueryPublicationSources;

/** Every seam over `copy`, each call logged as `<seam>:<call>`. */
function sourcesOf(copy: Copy, recorded: Recorded, citationFault?: Error): QueryAnswerSources {
  const note = (seam: string): Note => (call) => { recorded.log.push(`${seam}:${call}`); };
  return {
    pages: { reads: copiedLocalReadsOf(copy, note("pages")), scans: entityScansOf(copy, minted.onDisk.real, note("pages")) },
    profile: effectiveProfileOf(copy, note("profile")),
    embeddings: async () => { recorded.log.push("embeddings:load"); return minted.onDisk.embeddings; },
    journal: absentJournalOf(note("journal")),
    citations: copiedCitationSourcesOf(copy, note("citations"), citationFault),
    appendText: async (rel, text) => { recorded.appended.push(`${rel}\n${text}`); },
    publication: untouchedPublication(note("publication")),
  };
}

/** The steps, each step's name logged to `calls` before it runs. */
function stepsCalled(reads: QueryAnswerReads, calls: string[]): QueryAnswerReads {
  return Object.fromEntries(Object.entries(reads).map(([name, step]) =>
    [name, (...args: unknown[]) => { calls.push(name); return (step as (...given: unknown[]) => unknown)(...args); }])) as unknown as QueryAnswerReads;
}

/** Answer `question` over a copy through the bound composition, recording every step and seam call. */
async function answerOver(copy: Copy, options: Parameters<typeof generateAnswerFrom>[2] = {}, citationFault?: Error) {
  const recorded: Recorded = { log: [], appended: [] }, calls: string[] = [];
  const result = await generateAnswerFrom(stepsCalled(queryAnswerReadsOver(sourcesOf(copy, recorded, citationFault)), calls), QUESTION, options);
  return { result, calls, ...recorded };
}

/** A log entry with its second-precision timestamp hidden. */
const unstamped = (text: string): string => text.replace(/\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z\]/gu, "[<at>]");
const ALL_STEPS = ["indexPresent", "select", "hydrate", "answerCitations", "publish", "log"];

describe("the query answer over a copied project, with the directory gone", () => {
  it("Q1 runs after the minting directory was removed, on a copy holding no journal and no binding leaf", () => {
    expectRemovedDefaultCopies([minted], PREFIX);
  });

  it("Q2 answers exactly as the disk did, appends the same log entry, and asks publication, which reaches no seam with save off", async () => {
    const run = await answerOver(minted.copy);
    expect(run.result).toEqual(minted.onDisk.result);
    // The case only witnesses grounding and citations when both pages grounded and the report is present.
    expect([run.result.pageIds.length, "answerCitations" in run.result]).toEqual([2, true]);
    expect(run.appended.map(unstamped)).toEqual([unstamped(`${LOG_FILE}\n${minted.onDisk.logText}`)]);
    expect([run.calls.filter((step) => step === "publish").length, run.log.filter((call) => call.startsWith("publication:"))]).toEqual([1, []]);
  });
});

describe("the steps one answer takes", () => {
  it("Q3 takes the index look, selection, hydration, the citation report, publication, then the log, in order", async () => {
    const run = await answerOver(minted.copy);
    expect(run.calls).toEqual(ALL_STEPS);
    expect(run.log.indexOf("pages:exists wiki/index.md")).toBe(0);
    expect(run.log.indexOf("embeddings:load")).toBeLessThan(run.log.indexOf("journal:journal.open"));
  });

  it("Q4 refuses a copy without the index before selecting anything", async () => {
    const noIndex: Copy = { files: new Map([...minted.copy.files].filter(([rel]) => rel !== INDEX_FILE)), listings: minted.copy.listings };
    const recorded: Recorded = { log: [], appended: [] }, calls: string[] = [];
    await expect(generateAnswerFrom(stepsCalled(queryAnswerReadsOver(sourcesOf(noIndex, recorded)), calls), QUESTION))
      .rejects.toThrow("Wiki index not found. Run `llmwiki compile` first.");
    expect([calls, recorded.log]).toEqual([["indexPresent"], ["pages:exists wiki/index.md"]]);
  });

  it("Q5 stops after hydration when nothing may ground: no citations, no publication, no log", async () => {
    const run = await answerOver(minted.copy, { pageScope: [] });
    expect([run.result.answer, run.calls, run.appended]).toEqual(["", ["indexPresent", "select", "hydrate"], []]);
  });

  it("Q6 a scoped answer is published but not logged", async () => {
    const run = await answerOver(minted.copy, { pageScope: ["concepts/alpha"] });
    expect([run.calls, run.appended]).toEqual([ALL_STEPS.filter((step) => step !== "log"), []]);
  });

  it("Q7 an unavailable citation index omits the report and keeps the answer", async () => {
    const run = await answerOver(minted.copy, {}, new Error("index down"));
    expect(["answerCitations" in run.result, run.result.answer, run.calls]).toEqual([false, minted.onDisk.result.answer, ALL_STEPS]);
  });

  it("Q8 the root route reached all five root steps; the bound route reaches none", async () => {
    expect(rootReached).toEqual(ROOT_STEPS.map(() => true));
    ROOT_STEPS.forEach((step) => step.mockClear());
    await answerOver(minted.copy);
    expect(ROOT_STEPS.map((step) => step.mock.calls.length)).toEqual(ROOT_STEPS.map(() => 0));
  });
});
