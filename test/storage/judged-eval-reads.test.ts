/**
 * @file test/storage/judged-eval-reads.test.ts
 * @description FIXED outcomes for the disk calls the JUDGED evaluation makes
 * through `src/storage/`: the judgement cache's clear and load commands, the
 * judge's own cache (existence test, read, directory, append), the cited-line
 * read, the candidate evidence read, and the candidate report's atomic write.
 *
 * The judge is a STUB: `callClaude` is mocked, so no model, network or
 * credential is involved and a verdict here says nothing about quality. What is
 * pinned is what a caller can observe on real files: a cache line's exact
 * bytes, a warm run making no call and no write, which failures reach the
 * caller as the very error the disk raised and which are absorbed, the report
 * file's exact bytes, and, where the code is sequential, the order of calls.
 *
 * One source holds non-ASCII text, so the decoding of both reads and the
 * fingerprint taken from the decoded text are exercised, not only ASCII.
 *
 * Calls are observed through module mocks of `fs` and `fs/promises` that
 * forward to the real filesystem and can fail one chosen call. The storage
 * files and the atomic writer import those modules (some by their `node:`
 * names); the mocks reaching them is part of what is shown. Candidate
 * evaluation THROUGH THE JUDGE is covered here and nowhere at whole-build
 * level: its cache key carries the provider endpoint.
 */

import { afterEach, beforeEach, describe, expect, it, vi, setSystemTime } from "bun:test";
import { mocked } from "../mocked.js";
import { restoreEnv, stubEnv } from "../stubs.js";
import { createHash } from "node:crypto";
import * as nodeFs from "fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/** The calls the mocks saw, and at most one call they were told to fail. */
const record = { calls: [] as string[], planted: null as { prefix: string; error: Error } | null };

// Copy the real modules first: vi.mock patches them in place, so a later read would see the mock.
const realFs = { ...(await import("fs")) };
const realFsPromises = { ...(await import("fs/promises")) };

vi.mock("fs", () => {
  const actual = realFs;
  const existsSync = (location: unknown): boolean => {
    record.calls.push(`existsSync ${String(location)}`);
    return actual.existsSync(location as string);
  };
  return { ...actual, existsSync, default: { ...actual, existsSync } };
});

vi.mock("fs/promises", () => {
  const actual = realFsPromises;
  const forward = (name: "mkdir" | "appendFile" | "readFile" | "unlink" | "open" | "rename") =>
    function recorded(...args: unknown[]): unknown {
      const call = `${name} ${String(args[0])}`;
      record.calls.push([call, ...args.slice(1).map((value) => JSON.stringify(value))].join(" | "));
      if (record.planted && call.startsWith(record.planted.prefix)) return Promise.reject(record.planted.error);
      return (actual[name] as (...rest: unknown[]) => unknown)(...args);
    };
  return { ...actual, mkdir: forward("mkdir"), appendFile: forward("appendFile"), readFile: forward("readFile"),
    unlink: forward("unlink"), open: forward("open"), rename: forward("rename") };
});

vi.mock("../../src/utils/llm.js", () => ({ callClaude: vi.fn() }));

import { clearCitationCache, loadCitationCache } from "../../src/eval/cache.js";
import { createCitationJudge, evaluateCitationSupport, extractCitationPairs, type CitationPair } from "../../src/eval/citation-support.js";
import { candidateAssessments, currentEvidenceReader, evaluationHash } from "../../src/eval/candidate-evidence.js";
import { evaluateCandidates } from "../../src/eval/candidates.js";
import { writeCandidate } from "../../src/compiler/candidates.js";
import { callClaude } from "../../src/utils/llm.js";

const CACHE = ".llmwiki/eval/citation-cache.jsonl";
const REPORT = ".llmwiki/eval/candidates-latest.json";
const VERDICT = JSON.stringify({ score: 2, reason: "Stub verdict." });
const NON_ASCII = "Zoë's café — naïve ✓ line one.\nLine two, plain.\n";
let project = "";

const at = (relative: string): string => path.join(project, relative);
const bytesOf = (relative: string): Promise<string> => nodeFs.readFile(at(relative), "utf8");
const pairOf = (hash: string): CitationPair => ({ claimHash: hash, pageSlug: "page", claimText: `claim ${hash}`, citedFile: "s.md", spanText: "span", lineStart: 1, lineEnd: 1 });
const disaster = (): Error => Object.assign(new Error("planted disk failure"), { code: "EPLANTED" });

/** Create parents and write each file under the project. */
async function lay(files: Record<string, string>): Promise<void> {
  for (const [relative, text] of Object.entries(files)) {
    await nodeFs.mkdir(path.dirname(at(relative)), { recursive: true });
    await nodeFs.writeFile(at(relative), text);
  }
}

/** Recorded calls of the named functions, project root removed, arguments kept. */
function seen(...functions: string[]): string[] {
  return record.calls.filter((call) => functions.includes(call.split(" ")[0]!)).map((call) => call.split(`${project}/`).join(""));
}

beforeEach(async () => {
  project = await nodeFs.realpath(await nodeFs.mkdtemp(path.join(tmpdir(), "judged-eval-")));
  record.calls = []; record.planted = null;
  stubEnv("LLMWIKI_PROVIDER", "openai"); stubEnv("LLMWIKI_MODEL", "stub-judge"); stubEnv("OPENAI_API_KEY", "test-only-not-a-real-key");
  mocked(callClaude).mockReset().mockResolvedValue(VERDICT);
});

afterEach(async () => {
  restoreEnv(); setSystemTime();
  await nodeFs.rm(project, { recursive: true, force: true });
});

describe("the cache commands: clear and load", () => {
  it("clears only what is there: no removal for an absent cache, one for a present one", async () => {
    expect(await clearCitationCache(project)).toBe(false);
    expect(seen("existsSync", "unlink")).toEqual([`existsSync ${CACHE}`]);
    await lay({ [CACHE]: "{}\n" });
    expect(await clearCitationCache(project)).toBe(true);
    expect(seen("existsSync", "unlink").slice(1)).toEqual([`existsSync ${CACHE}`, `unlink ${CACHE}`]);
    await expect(nodeFs.access(at(CACHE))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("passes a removal failure on untouched and leaves the cache in place", async () => {
    await lay({ [CACHE]: "{}\n" });
    const error = disaster();
    record.planted = { prefix: `unlink ${at(CACHE)}`, error };
    await expect(clearCitationCache(project)).rejects.toBe(error);
    expect(await bytesOf(CACHE)).toBe("{}\n");
  });

  it("loads nothing without a read for an absent cache, skips a malformed line, rejects for a directory", async () => {
    expect(await loadCitationCache(project)).toEqual([]);
    expect(seen("readFile")).toEqual([]);
    await lay({ [CACHE]: `${JSON.stringify({ claimHash: "a", score: 2 })}\n{ torn\n${JSON.stringify({ claimHash: "b", score: 0 })}\n` });
    expect((await loadCitationCache(project)).map((entry) => entry.claimHash)).toEqual(["a", "b"]);
    expect(seen("readFile")).toEqual([`readFile ${CACHE} | "utf-8"`]);
    await nodeFs.rm(at(CACHE)); await nodeFs.mkdir(at(CACHE));
    await expect(loadCitationCache(project)).rejects.toMatchObject({ code: "EISDIR" });
  });
});

describe("the judge's cache: cold writes one line per verdict, warm writes and asks nothing", () => {
  it("cold: asks whether the cache is there, then for each pair makes the directory and appends one exact line", async () => {
    setSystemTime(new Date("2026-01-02T03:04:05.678Z"));
    const judge = await createCitationJudge(project);
    const first = await judge(pairOf("h1"));
    const afterFirst = await bytesOf(CACHE);
    expect(afterFirst).toBe(`${JSON.stringify(first.judgement)}\n`);
    const second = await judge(pairOf("h2"));
    expect(await bytesOf(CACHE)).toBe(`${afterFirst}${JSON.stringify(second.judgement)}\n`);
    expect([first.cached, second.cached, first.judgement.timestamp]).toEqual([false, false, "2026-01-02T03:04:05.678Z"]);
    expect(seen("existsSync", "mkdir", "appendFile").map((call) => call.split(" | ")[0])).toEqual([
      `existsSync ${CACHE}`, "mkdir .llmwiki/eval", `appendFile ${CACHE}`, "mkdir .llmwiki/eval", `appendFile ${CACHE}`]);
    // The only reads of the cache are this test's own (`"utf8"`); the judge, which reads as `"utf-8"`, made none.
    expect(seen("readFile").filter((call) => call.endsWith('"utf-8"'))).toEqual([]);
    expect(callClaude).toHaveBeenCalledTimes(2);
  });

  it("warm: one read after the existence test, then no model call, no directory call and no append", async () => {
    const cold = await (await createCitationJudge(project))(pairOf("h1"));
    const stored = await bytesOf(CACHE);
    record.calls = []; mocked(callClaude).mockClear();
    const warm = await (await createCitationJudge(project))({ ...pairOf("h1"), pageSlug: "another-page" });
    expect(warm).toMatchObject({ cached: true, judgement: { timestamp: cold.judgement.timestamp, claimHash: cold.judgement.claimHash, pageSlug: "another-page" } });
    expect(seen("existsSync", "readFile", "mkdir", "appendFile")).toEqual([`existsSync ${CACHE}`, `readFile ${CACHE} | "utf-8"`]);
    expect(callClaude).not.toHaveBeenCalled();
    expect(await bytesOf(CACHE)).toBe(stored);
  });

  it("without persistence touches no cache file at all", async () => {
    const result = await (await createCitationJudge(project, { persist: false }))(pairOf("h1"));
    expect(result.cached).toBe(false);
    expect(seen("existsSync", "readFile", "mkdir", "appendFile")).toEqual([]);
    await expect(nodeFs.access(at(CACHE))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects for a directory at the cache path, and passes an append failure on from the judge", async () => {
    const error = disaster();
    record.planted = { prefix: `appendFile ${at(CACHE)}`, error };
    await expect((await createCitationJudge(project))(pairOf("h1"))).rejects.toBe(error);
    record.planted = null;
    await nodeFs.mkdir(at(CACHE), { recursive: true });
    await expect(createCitationJudge(project)).rejects.toMatchObject({ code: "EISDIR" });
  });
});

describe("the cited-line read: decoded text, and a failure that is not absorbed", () => {
  const PAGE = '---\ntitle: "Page"\n---\n\nA claim about the café. ^[accents.md:1-1]\n';

  it("reads the cited lines as UTF-8 and keys the pair on the decoded text", async () => {
    await lay({ "wiki/concepts/page.md": PAGE, "sources/accents.md": NON_ASCII });
    const [pair] = await extractCitationPairs(project);
    expect(pair).toMatchObject({ spanText: "Zoë's café — naïve ✓ line one.", claimText: "A claim about the café.", citedFile: "accents.md" });
    expect(pair?.claimHash).toBe(createHash("sha256").update("A claim about the café.Zoë's café — naïve ✓ line one.").digest("hex").slice(0, 16));
    expect(seen("readFile").filter((call) => call.includes("accents.md"))).toEqual(['readFile sources/accents.md | "utf-8"']);
  });

  it("counts a failed append as a judge error, and fails the run when it is the only pair", async () => {
    await lay({ "wiki/concepts/page.md": PAGE, "sources/accents.md": NON_ASCII });
    record.planted = { prefix: `appendFile ${at(CACHE)}`, error: disaster() };
    await expect(evaluateCitationSupport(project)).rejects.toThrow("Citation judge failed for all 1 sampled pair(s): planted disk failure");
    record.planted = { prefix: `readFile ${at("sources/accents.md")}`, error: disaster() };
    await expect(extractCitationPairs(project)).rejects.toMatchObject({ code: "EPLANTED" });
  });
});

describe("the candidate evidence read: once per file, fingerprinted as decoded", () => {
  it("reads each cited file once however often it is asked, and fingerprints the UTF-8 text", async () => {
    await lay({ "sources/accents.md": NON_ASCII });
    const read = currentEvidenceReader(project);
    const texts = [await read("accents.md"), await read("accents.md"), await read("accents.md")];
    expect(texts).toEqual([NON_ASCII, NON_ASCII, NON_ASCII]);
    expect(seen("readFile")).toEqual(['readFile sources/accents.md | "utf-8"']);
    expect(evaluationHash(texts[0]!)).toBe(createHash("sha256").update(Buffer.from(NON_ASCII, "utf8")).digest("hex"));
  });

  it("absorbs a read failure: the evidence is unavailable and nothing is thrown", async () => {
    await lay({ "sources/accents.md": NON_ASCII });
    record.planted = { prefix: `readFile ${at("sources/accents.md")}`, error: disaster() };
    const reference = { id: "c", target: "concepts/c", generatedAt: "t", revision: "r", contentHash: "h" };
    const seenAssessments = await candidateAssessments({ body: "A cited claim, long enough. ^[accents.md:1-1]", hashes: {} }, reference, currentEvidenceReader(project));
    expect(seenAssessments.assessments.map((item) => [item.status, item.reason, item.evidence?.status])).toEqual([
      ["unjudgeable", "Source is missing, unreadable, or outside sources/.", "unavailable"]]);
  });
});

describe("the candidate report: exact bytes, written atomically, and nothing else touched", () => {
  const draft = { title: "Pending", slug: "pending", summary: "Draft", sources: ["accents.md"], body: "A cited claim, long enough. ^[accents.md:1-1]" };

  it("writes the report for an empty queue too, as exactly the JSON of what it returns", async () => {
    const report = await evaluateCandidates(project, "fast");
    expect(await bytesOf(REPORT)).toBe(JSON.stringify(report, null, 2));
    const written = seen("mkdir", "open", "rename").filter((call) => call.includes(".llmwiki/eval"));
    expect(written.map((call) => call.split(" ")[0])).toEqual(["mkdir", "open", "rename"]);
    expect(written[2]).toMatch(/^rename \.llmwiki\/eval\/candidates-latest\.json\.\S+ \| "\S*\.llmwiki\/eval\/candidates-latest\.json"$/);
    expect(callClaude).not.toHaveBeenCalled();
  });

  it("fast: describes the draft without a model call and leaves the queue file byte-identical", async () => {
    await lay({ "sources/accents.md": NON_ASCII });
    const candidate = await writeCandidate(project, { ...draft, sourceStates: { "accents.md": { hash: evaluationHash(NON_ASCII), concepts: [], compiledAt: "2026-01-01" } } });
    const queued = await bytesOf(`.llmwiki/candidates/${candidate.id}.json`);
    const report = await evaluateCandidates(project, "fast");
    expect(report.assessments.map((item) => [item.status, item.evidence?.status, item.evidence?.sourceHash])).toEqual([["eligible", "matches-generation", evaluationHash(NON_ASCII)]]);
    expect(await bytesOf(REPORT)).toBe(JSON.stringify(report, null, 2));
    expect(await bytesOf(`.llmwiki/candidates/${candidate.id}.json`)).toBe(queued);
    expect(callClaude).not.toHaveBeenCalled();
    await expect(nodeFs.access(at(CACHE))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("full: judges through the shared cache under the draft's own identity (module evidence only)", async () => {
    await lay({ "sources/accents.md": NON_ASCII });
    const candidate = await writeCandidate(project, draft);
    const report = await evaluateCandidates(project, "full");
    const judgement = report.assessments[0]?.judgement;
    expect(judgement).toMatchObject({ score: 2, spanText: "Zoë's café — naïve ✓ line one.", pageSlug: `candidate:${candidate.id}@${report.candidates[0]?.revision}` });
    expect(await bytesOf(CACHE)).toBe(`${JSON.stringify(judgement)}\n`);
    mocked(callClaude).mockClear();
    expect((await evaluateCandidates(project, "full")).assessments[0]?.judgement?.claimHash).toBe(judgement?.claimHash);
    expect(callClaude).not.toHaveBeenCalled();
  });

  it("passes a report write failure on untouched", async () => {
    const error = disaster();
    record.planted = { prefix: `mkdir ${at(".llmwiki/eval")}`, error };
    await expect(evaluateCandidates(project, "fast")).rejects.toBe(error);
    await expect(nodeFs.access(at(REPORT))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
