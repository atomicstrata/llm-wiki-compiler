/**
 * @file test/storage/citation-judge-binding.test.ts
 * @description The citation judge as a WHOLE consumer with no project
 * directory: `createCitationJudgeFrom` over `CitationJudgeCacheFiles`. The body
 * exists only after the judge was given cache files of its own, so this file
 * has NO before-edit run, and agreement between the two forms of one body is
 * not, by itself, proof of what the judge did before the edit. The written-out
 * figures are the independent part: the judgements and cache lines were worked
 * out by hand, and the three cache keys by a script over the source text.
 *
 * THE MODEL IS A STUB. `callClaude` is module-mocked before anything is
 * imported, so no model, provider or network is reached. The stub answers one
 * fixed verdict and logs that it was asked.
 *
 * HOW IT IS BUILT. Three projects are minted on real disk: one with no cache,
 * one whose cache file is written from TEXT THIS FILE HOLDS (a repeated key, a
 * torn line, a blank line, an out-of-range score, a blank reason), and one
 * judged without persistence. The real root-taking `createCitationJudge` runs a
 * fixed sequence of judgings on each, the tree is copied, and the directories
 * are removed before any case runs. In memory the SAME sequence runs through
 * `createCitationJudgeFrom` over a map of texts that starts from the held text,
 * and is compared with the disk's results and with the cache file the disk was
 * left with.
 *
 * WHAT RUNS FOR REAL IN MEMORY. Option and model resolution, the cache load
 * with its line parsing, the key, the check of a cached score and reason, the
 * rebinding of a cached judgement to the pair asked, the verdict validation,
 * the clock read, the append and the remembering. The doubles answer raw facts
 * only: whether a file is there, its text, a directory made, a text appended.
 * No parsed cache, judgement or verdict is handed in.
 *
 * THE CLOCK. Only `Date` is faked, in this file.
 *
 * WHAT IS NOT SHOWN. `evaluateCitationSupport`, `judgeNewPairs` and the
 * candidate evaluation, which still take a project root. The doubles have no
 * links and confine nothing; a linked cache file or directory is not exercised.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi, setSystemTime, type Mock } from "bun:test";
import { restoreEnv, stubEnv } from "../stubs.js";

vi.mock("../../src/utils/llm.js", () => ({ callClaude: vi.fn() }));

import { createCitationJudge, createCitationJudgeFrom, type CitationJudgeCacheFiles, type CitationPair } from "../../src/eval/citation-support.js";
import type { CitationJudgement } from "../../src/eval/types.js";
import { callClaude } from "../../src/utils/llm.js";
import { tempRootTracker } from "../temp-roots.js";
import { enoent, mintCopied, mintOnceThenRemove, unasked, writeFiles, type Minted } from "./copied-project.js";
import { expectMintingDirectoryRemoved } from "./minted-directory.js";

const PREFIX = "citation-judge-";
const EVAL_DIR = ".llmwiki/eval";
const CACHE = `${EVAL_DIR}/citation-cache.jsonl`;
const AT = "2026-03-04T05:06:07.000Z";
const LATER = "2026-03-04T09:00:00.000Z";
const VERDICT = JSON.stringify({ score: 2, reason: "Stub verdict." });
/** Keys for pair hashes h1, h2 and h3 with no namespace under model-a, from `keys.py` over the source text. */
const [KEY_1, KEY_2, KEY_3] = ["5539ddb06f5c4903", "3efd25eeda73d00e", "d20d20adf1b26705"];
const pairOf = (hash: string): CitationPair =>
  ({ claimHash: hash, pageSlug: `page-${hash}`, claimText: `claim ${hash}`, citedFile: `${hash}.md`, spanText: `span ${hash}`, lineStart: 1, lineEnd: 2 });
const [P1, P2, P3] = [pairOf("h1"), pairOf("h2"), pairOf("h3")];
/** What the stub's verdict becomes for `pair` under `key`, in the order the judge writes the fields. */
const fresh = (pair: CitationPair, key: string, model = "model-a"): CitationJudgement => ({
  claimHash: key, pageSlug: pair.pageSlug, citedFile: pair.citedFile, lineStart: pair.lineStart, lineEnd: pair.lineEnd,
  claimText: pair.claimText, spanText: pair.spanText, score: 2, reason: "Stub verdict.", model, timestamp: AT,
});
const lineOf = (value: unknown): string => `${JSON.stringify(value)}\n`;
/** The cached judgement that must win for h1: the LAST line with its key, written for another page. */
const KEPT = { claimHash: KEY_1, pageSlug: "earlier-page", citedFile: "old.md", lineStart: 9, lineEnd: 9, claimText: "old claim",
  spanText: "old span", score: 1, reason: "kept", model: "recorded-model", timestamp: "2025-01-01T00:00:00.000Z" };
const SEEDED_TEXT = [
  lineOf({ ...KEPT, score: 0, reason: "superseded" }), "{ torn\n", "\n", lineOf(KEPT),
  lineOf({ claimHash: KEY_2, score: 7, reason: "a score out of range" }), lineOf({ claimHash: KEY_3, score: 2, reason: "   " }),
].join("");

type Judged = { cached: boolean; judgement: CitationJudgement };
type Make = (options?: { namespace?: string; model?: string; persist?: boolean }) => Promise<(pair: CitationPair) => Promise<Judged>>;
/** What one sequence gave: each judging in order, and how often the stub was asked. */
interface Outcome { results: Judged[]; asked: number }
const log: string[] = [];
const stub = async (): Promise<string> => { log.push("provider"); return VERDICT; };
const askedSoFar = (): number => log.filter((call) => call === "provider").length;

/** One judge under model-a: h1, h1 again, then h2. */
async function coldSequence(make: Make): Promise<Outcome> {
  const before = askedSoFar();
  const judge = await make({ model: "model-a" });
  const results = [await judge(P1), await judge(P1), await judge(P2)];
  return { results, asked: askedSoFar() - before };
}

/** Over the seeded cache: h1 for a new page, h2, h3, then h1 under a namespace and under another model, then h2 through a newly made judge. */
async function seededSequence(make: Make): Promise<Outcome> {
  const before = askedSoFar();
  const judge = await make({ model: "model-a" });
  const results = [await judge({ ...P1, pageSlug: "new-page" }), await judge(P2), await judge(P3)];
  results.push(await (await make({ model: "model-a", namespace: "ns" }))(P1));
  results.push(await (await make({ model: "model-b" }))(P1));
  results.push(await (await make({ model: "model-a" }))(P2));
  return { results, asked: askedSoFar() - before };
}

/** No persistence: h1 twice through one judge. */
async function unpersistedSequence(make: Make): Promise<Outcome> {
  const before = askedSoFar();
  const judge = await make({ model: "model-a", persist: false });
  return { results: [await judge(P1), await judge(P1)], asked: askedSoFar() - before };
}

const tracker = tempRootTracker();
let cold: Minted<Outcome>;
let seeded: Minted<Outcome>;
let unpersisted: Minted<Outcome>;
const onDiskMake = (root: string): Make => (options) => createCitationJudge(root, options);

beforeAll(() => { setSystemTime(new Date(AT)); (callClaude as unknown as Mock<typeof callClaude>).mockImplementation(stub); });
beforeEach(() => { setSystemTime(new Date(AT)); (callClaude as unknown as Mock<typeof callClaude>).mockReset().mockImplementation(stub); log.length = 0; });
afterAll(() => { setSystemTime(); });
mintOnceThenRemove(tracker, async () => {
  cold = await mintCopied(tracker, PREFIX, async () => {}, (root) => coldSequence(onDiskMake(root)));
  seeded = await mintCopied(tracker, PREFIX, (root) => writeFiles(root, { [CACHE]: SEEDED_TEXT }), (root) => seededSequence(onDiskMake(root)));
  unpersisted = await mintCopied(tracker, PREFIX, async () => {}, (root) => unpersistedSequence(onDiskMake(root)));
});

/** A map of texts and a set of made directories. An append needs its directory. Every call is logged; a removal is never asked. */
function memoryCache(held: string | null): { files: CitationJudgeCacheFiles; text: () => string | undefined } {
  const texts = new Map<string, string>(held === null ? [] : [[CACHE, held]]);
  const made = new Set<string>();
  return {
    text: () => texts.get(CACHE),
    files: {
      reads: {
        existsSync: (rel) => { log.push(`exists ${rel}`); return texts.has(rel); },
        readText: async (rel) => { log.push(`read ${rel}`); return texts.get(rel) ?? Promise.reject(enoent()); },
      },
      writes: {
        makeDirectoryTree: async (relDir) => { log.push(`mkdir ${relDir}`); made.add(relDir); },
        appendText: async (rel, text) => {
          log.push(`append ${rel}`);
          if (!made.has(EVAL_DIR)) throw enoent();
          texts.set(rel, (texts.get(rel) ?? "") + text);
        },
        removeFile: unasked("writes.removeFile"),
      },
    },
  };
}
const inMemoryMake = (files: CitationJudgeCacheFiles): Make => (options) => createCitationJudgeFrom(files, options);
const NEVER_ASKED: CitationJudgeCacheFiles = {
  reads: { existsSync: unasked("reads.existsSync"), readText: unasked("reads.readText") },
  writes: { makeDirectoryTree: unasked("writes.makeDirectoryTree"), appendText: unasked("writes.appendText"), removeFile: unasked("writes.removeFile") },
};

describe("the citation judge over held cache text, with the directories gone", () => {
  it("J1 runs after every minting directory was removed", () => {
    for (const minted of [cold, seeded, unpersisted]) expectMintingDirectoryRemoved(minted.dir, PREFIX);
  });

  it("J2 with no cache: judges h1, answers h1 again from memory, judges h2, and leaves two lines, as the disk did", async () => {
    const memory = memoryCache(null);
    const outcome = await coldSequence(inMemoryMake(memory.files));
    const expected: Judged[] = [{ cached: false, judgement: fresh(P1, KEY_1) }, { cached: true, judgement: fresh(P1, KEY_1) }, { cached: false, judgement: fresh(P2, KEY_2) }];
    expect([outcome, cold.onDisk]).toStrictEqual([{ results: expected, asked: 2 }, { results: expected, asked: 2 }]);
    expect([memory.text(), cold.copy.files.get(CACHE)]).toEqual(Array(2).fill(lineOf(fresh(P1, KEY_1)) + lineOf(fresh(P2, KEY_2))));
  });

  it("J3 with no cache: asks whether the file is there once, then per new verdict asks the stub, makes the directory and appends", async () => {
    await coldSequence(inMemoryMake(memoryCache(null).files));
    const verdict = ["provider", `mkdir ${EVAL_DIR}`, `append ${CACHE}`];
    expect(log).toEqual([`exists ${CACHE}`, ...verdict, ...verdict]);
  });

  it("J4 over the seeded cache: gives what the disk gave for every judging", async () => {
    const outcome = await seededSequence(inMemoryMake(memoryCache(SEEDED_TEXT).files));
    expect(outcome).toStrictEqual(seeded.onDisk);
    expect(outcome.asked).toBe(4);
  });

  it("J5 a cache hit takes the LAST line with its key and is rebound to the pair asked, under the cache key", () => {
    const [hit] = seeded.onDisk.results;
    expect(hit).toEqual({ cached: true, judgement: { ...KEPT, pageSlug: "new-page", citedFile: "h1.md", lineStart: 1, lineEnd: 2, claimText: "claim h1", spanText: "span h1" } });
    expect([hit?.judgement.claimHash, hit?.judgement.score, hit?.judgement.model, hit?.judgement.timestamp]).toEqual([KEY_1, 1, "recorded-model", KEPT.timestamp]);
  });

  it("J6 a cached line with an out-of-range score or a blank reason is not accepted: the pair is judged again", () => {
    const [, oddScore, blankReason] = seeded.onDisk.results;
    expect([oddScore, blankReason]).toStrictEqual([{ cached: false, judgement: fresh(P2, KEY_2) }, { cached: false, judgement: fresh(P3, KEY_3) }]);
  });

  it("J7 a namespace and a model each give their own key, and a judge made later reads back what an earlier one appended", () => {
    const [, , , spaced, otherModel, reread] = seeded.onDisk.results;
    expect([spaced?.cached, otherModel?.cached, reread]).toStrictEqual([false, false, { cached: true, judgement: fresh(P2, KEY_2) }]);
    expect([spaced?.judgement.claimHash, otherModel?.judgement.claimHash]).toEqual(["afbd159e1dcbce51", "37d5f85417484406"]);
    expect(otherModel?.judgement).toStrictEqual(fresh(P1, "37d5f85417484406", "model-b"));
  });

  it("J8 over the seeded cache: appends one line per new verdict after the held text, as the disk was left", async () => {
    const memory = memoryCache(SEEDED_TEXT);
    await seededSequence(inMemoryMake(memory.files));
    const added = [fresh(P2, KEY_2), fresh(P3, KEY_3), fresh(P1, "afbd159e1dcbce51"), fresh(P1, "37d5f85417484406", "model-b")];
    expect([memory.text(), seeded.copy.files.get(CACHE)]).toEqual(Array(2).fill(SEEDED_TEXT + added.map(lineOf).join("")));
    expect(log.filter((call) => !call.startsWith("provider") && !call.startsWith("mkdir") && !call.startsWith("append")))
      .toEqual(Array(4).fill([`exists ${CACHE}`, `read ${CACHE}`]).flat());
  });

  it("J9 without persistence asks the project nothing, remembers the verdict, and the disk was left with no private directory", async () => {
    const outcome = await unpersistedSequence(inMemoryMake(NEVER_ASKED));
    const expected: Judged[] = [{ cached: false, judgement: fresh(P1, KEY_1) }, { cached: true, judgement: fresh(P1, KEY_1) }];
    expect([outcome, unpersisted.onDisk]).toStrictEqual([{ results: expected, asked: 1 }, { results: expected, asked: 1 }]);
    expect([...unpersisted.copy.listings.keys()]).toEqual([""]);
  });
});

describe("the judge's defaults, clock and failures, in memory", () => {
  it("D1 persists by default, and resolves the default model when the judge is made, not when it is asked", async () => {
    stubEnv("LLMWIKI_PROVIDER", "anthropic");
    stubEnv("LLMWIKI_MODEL", "model-when-made");
    const memory = memoryCache(null);
    const judge = await createCitationJudgeFrom(memory.files);
    stubEnv("LLMWIKI_MODEL", "model-when-asked");
    const { judgement } = await judge(P1);
    restoreEnv();
    expect(judgement.model).toBe("model-when-made");
    expect(memory.text()).toBe(lineOf(judgement));
  });

  it("D2 stamps the verdict after the stub has answered", async () => {
    (callClaude as unknown as Mock<typeof callClaude>).mockImplementation(async () => { setSystemTime(new Date(LATER)); return VERDICT; });
    const { judgement } = await (await createCitationJudgeFrom(NEVER_ASKED, { model: "model-a", persist: false }))(P1);
    expect(judgement).toStrictEqual({ ...fresh(P1, KEY_1), timestamp: LATER });
  });

  it("F1 a failed append rejects with its own error and is not remembered: the pair is judged again and appended once", async () => {
    const failure = new Error("planted append failure");
    const memory = memoryCache(null);
    const appendText = memory.files.writes.appendText;
    memory.files.writes.appendText = async () => { throw failure; };
    const judge = await createCitationJudgeFrom(memory.files, { model: "model-a" });
    await expect(judge(P1)).rejects.toBe(failure);
    memory.files.writes.appendText = appendText;
    expect(await judge(P1)).toStrictEqual({ cached: false, judgement: fresh(P1, KEY_1) });
    expect([askedSoFar(), memory.text()]).toEqual([2, lineOf(fresh(P1, KEY_1))]);
  });

  it("F2 a directory that cannot be made rejects with its own error before any append", async () => {
    const failure = new Error("planted directory failure");
    const memory = memoryCache(null);
    memory.files.writes.makeDirectoryTree = async () => { throw failure; };
    await expect((await createCitationJudgeFrom(memory.files, { model: "model-a" }))(P1)).rejects.toBe(failure);
    expect([log.includes(`append ${CACHE}`), memory.text()]).toEqual([false, undefined]);
  });

  it("F3 a cache that cannot be read rejects the making of the judge, before the stub is asked", async () => {
    const failure = new Error("planted read failure");
    const memory = memoryCache(SEEDED_TEXT);
    memory.files.reads.readText = async () => { throw failure; };
    await expect(createCitationJudgeFrom(memory.files, { model: "model-a" })).rejects.toBe(failure);
    expect(askedSoFar()).toBe(0);
  });

  it("F4 a verdict with a score out of range is refused, and nothing is made or appended", async () => {
    (callClaude as unknown as Mock<typeof callClaude>).mockResolvedValue(JSON.stringify({ score: 5, reason: "too high" }));
    const memory = memoryCache(null);
    await expect((await createCitationJudgeFrom(memory.files, { model: "model-a" }))(P1)).rejects.toThrow("Citation judge returned an invalid score or reason");
    expect([log, memory.text()]).toEqual([[`exists ${CACHE}`], undefined]);
  });
});
