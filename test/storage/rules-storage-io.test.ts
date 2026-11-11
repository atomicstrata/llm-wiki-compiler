/**
 * @file test/storage/rules-storage-io.test.ts
 * @description The rules lane (`rules extract`, `list`, `approve`, `export`)
 * through its REAL functions, with real files under a temp project. The file
 * states behaviour that the move of eight disk calls behind `src/storage/`
 * must not change, so it is run byte for byte against the source both before
 * and after that move.
 *
 * Cases B1 to B7 and R1 assert outcomes: file bytes, a rejection and its
 * message, what is left on disk, what is printed. Only A1 is about arguments.
 * It wraps one boundary, the atomic writer module, passes every call through,
 * and looks ONLY at the three writes it names (the cursor, one candidate, the
 * export). It says nothing about any other caller of the writer and nothing
 * about the writer's inner steps.
 *
 * The provider is never reached: every case that can get to extraction stubs
 * `callClaude` first. Roots are the resolved working directory, except the
 * linked root, whose link path is checked to differ from its resolved path.
 */

import { mkdir, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { restoreEnv, stubEnv } from "../stubs.js";

/** Every call of the atomic writer, as its raw argument list. */
const writer = { calls: [] as unknown[][] };

// Copy the real modules first: vi.mock patches them in place, so a later read would see the mock.
const realUtilsAtomicWrite = { ...(await import("../../src/utils/atomic-write.js")) };

vi.mock("../../src/utils/atomic-write.js", () => {
  const actual = realUtilsAtomicWrite;
  const atomicWrite = (...args: unknown[]): Promise<void> => {
    writer.calls.push(args);
    return (actual.atomicWrite as (...rest: unknown[]) => Promise<void>)(...args);
  };
  return { ...actual, atomicWrite };
});

import { rulesExportCommand, rulesExtractCommand } from "../../src/commands/rules.js";
import { setRuleCandidateStatus, writeRuleCandidate } from "../../src/compiler/rule-candidates.js";
import { extractRuleCandidates } from "../../src/compiler/rule-extractor.js";
import { readRuleState, updateRuleSourceState } from "../../src/compiler/rule-state.js";
import * as lockGate from "../../src/operation-bundles/lock-gate.js";
import { candidateFileId } from "../../src/utils/candidate-store.js";
import { RULE_STATE_FILE } from "../../src/utils/constants.js";
import * as llm from "../../src/utils/llm.js";
import type { RuleCandidate } from "../../src/utils/rule-types.js";
import { restoreProviderEnvAfterEach, seedRuleSource, stubRuleExtraction } from "../fixtures/rule-extraction.js";
import { useTempRoot } from "../fixtures/temp-root.js";

const NOW = "2026-05-31T00:00:00.000Z";
const EMPTY_CURSOR = { version: 1, indexHash: "", sources: {} };
const ENTRY = { hash: "h1", compiledAt: NOW, concepts: [] };
const EXPORT_FILE = "dist/exports/rule-candidates.json";
const NON_ASCII_LINE = "Zażółć gęślą jaźń — 規則は必ず守る";

useTempRoot(["sources"]);
restoreProviderEnvAfterEach();
let printed: string[] = [];
let exitCodeBefore: typeof process.exitCode;

/** The project root as the commands see it: the resolved working directory. */
const root = (): string => process.cwd();
const pretty = (value: unknown): string => JSON.stringify(value, null, 2);
const cursorWith = (file: string): unknown => ({ ...EMPTY_CURSOR, sources: { [file]: ENTRY } });

/** Extract one candidate from the seeded source with the provider stubbed. */
async function extractOne(): Promise<RuleCandidate> {
  await seedRuleSource(root());
  await stubRuleExtraction();
  const { candidates } = await extractRuleCandidates(root(), NOW);
  return candidates[0]!;
}

/** A root reached through a link, whose link path is not its resolved path. */
async function linkedRoot(): Promise<{ link: string; real: string }> {
  const real = path.join(root(), "real-root");
  const link = path.join(root(), "linked-root");
  await mkdir(real);
  await symlink(real, link);
  expect(await realpath(link)).toBe(real);
  expect(link).not.toBe(real);
  return { link, real };
}

beforeEach(() => {
  writer.calls.length = 0;
  printed = [];
  exitCodeBefore = process.exitCode;
  vi.spyOn(console, "log").mockImplementation((...parts: unknown[]) => { printed.push(parts.join(" ")); });
});
afterEach(() => {
  vi.restoreAllMocks();
  restoreEnv();
  process.exitCode = exitCodeBefore;
});

describe("the rule cursor", () => {
  it("B1 reads a missing cursor and a malformed cursor as the empty cursor", async () => {
    expect(await readRuleState(root())).toEqual(EMPTY_CURSOR);
    await mkdir(path.join(root(), ".llmwiki"));
    await writeFile(path.join(root(), RULE_STATE_FILE), "{not json");
    expect(await readRuleState(root())).toEqual(EMPTY_CURSOR);
  });

  it("B2 writes two-space JSON with no trailing newline, and reads it back", async () => {
    await updateRuleSourceState(root(), "a.md", ENTRY);
    expect(await readFile(path.join(root(), RULE_STATE_FILE), "utf-8")).toBe(pretty(cursorWith("a.md")));
    expect(await readRuleState(root())).toEqual(cursorWith("a.md"));
  });

  it("B3 writes through a root that is passed as a link path", async () => {
    const { link, real } = await linkedRoot();
    await updateRuleSourceState(link, "a.md", ENTRY);
    expect(await readFile(path.join(real, RULE_STATE_FILE), "utf-8")).toBe(pretty(cursorWith("a.md")));
  });

  it("B4 refuses when .llmwiki leads out of the project, and writes nothing there", async () => {
    const project = path.join(root(), "project");
    const outside = path.join(root(), "outside");
    await mkdir(project);
    await mkdir(outside);
    await symlink(outside, path.join(project, ".llmwiki"));
    await expect(updateRuleSourceState(project, "a.md", ENTRY)).rejects.toThrow("path escapes project root");
    expect(await readdir(outside)).toEqual([]);
  });
});

describe("rule candidates and the export", () => {
  it("B5 writes a candidate as two-space JSON; approving changes only the status", async () => {
    const candidate = await extractOne();
    const target = await writeRuleCandidate(root(), candidate);
    expect(await readFile(target, "utf-8")).toBe(pretty(candidate));
    await setRuleCandidateStatus(root(), candidateFileId(candidate.id), "approved");
    expect(await readFile(target, "utf-8")).toBe(pretty({ ...candidate, status: "approved" }));
  });

  it("B6 export creates dist/exports and writes the array followed by one newline", async () => {
    const candidate = await extractOne();
    await setRuleCandidateStatus(root(), candidateFileId(candidate.id), "approved");
    await expect(readdir(path.join(root(), "dist"))).rejects.toMatchObject({ code: "ENOENT" });
    await rulesExportCommand();
    const text = await readFile(path.join(root(), EXPORT_FILE), "utf-8");
    expect(text).toBe(`${pretty([{ ...candidate, status: "approved" }])}\n`);
    expect(printed.join("\n")).toContain("Exported 1 rule candidate(s)");
  });

  it("B7 hands non-ASCII source text to the provider unchanged", async () => {
    await seedRuleSource(root());
    await writeFile(path.join(root(), "sources", "guide.md"), `${NON_ASCII_LINE}\nSecond line.`, "utf-8");
    stubEnv("LLMWIKI_OUTPUT_LANG", undefined);
    const call = vi.spyOn(llm, "callClaude").mockResolvedValue('{"rules":[]}');
    const result = await extractRuleCandidates(root(), NOW);
    expect(result.processedSources).toEqual(["guide.md"]);
    expect(call).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(call.mock.calls[0]![0])).toContain(NON_ASCII_LINE);
  });
});

describe("rules extract with no sources folder", () => {
  it("R1 warns and returns before the lock, and creates nothing", async () => {
    await rm(path.join(root(), "sources"), { recursive: true });
    const lock = vi.spyOn(lockGate, "acquireMutationLock").mockResolvedValue(false);
    const call = vi.spyOn(llm, "callClaude").mockResolvedValue('{"rules":[]}');
    await rulesExtractCommand();
    expect(printed.join("\n")).toContain("No sources found");
    expect(lock).not.toHaveBeenCalled();
    expect(call).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(exitCodeBefore);
    expect((await readdir(root())).sort()).toEqual(["wiki"]);
  });
});

describe("the three writes, by argument", () => {
  it("A1 cursor has exactly a confine root as given; candidate and export have two arguments", async () => {
    const candidate = await extractOne();
    const { link } = await linkedRoot();
    writer.calls.length = 0;
    await updateRuleSourceState(link, "a.md", ENTRY);
    const target = await writeRuleCandidate(root(), candidate);
    await rulesExportCommand();
    const cursorPath = path.join(link, RULE_STATE_FILE);
    const exportPath = path.join(root(), EXPORT_FILE);
    const named = writer.calls.filter((args) => [cursorPath, target, exportPath].includes(args[0] as string));
    expect(named).toStrictEqual([
      [cursorPath, pretty(cursorWith("a.md")), { confineRoot: link }],
      [target, pretty(candidate)],
      [exportPath, "[]\n"],
    ]);
  });
});
