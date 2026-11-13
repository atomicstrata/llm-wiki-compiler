/**
 * @file test/storage/rule-extraction-binding.test.ts
 * @description Rule extraction as ONE body over its project steps,
 * `extractRuleCandidatesWith`, bound through `ruleExtractionStepsOver`, with no
 * project directory. This file uses both, which exist only after extraction was
 * given steps of its own, so it has NO before-edit run.
 *
 * HOW IT IS BUILT. Three projects are minted on real disk, once, each COPIED
 * into memory BEFORE the disk ask (the ask writes candidates and the cursor):
 * a fresh source; the same source re-extracted after its candidate was APPROVED
 * and the cursor dropped; and a source already extracted, so the cursor is
 * current. The provider call is the shared offline stub (`stubRuleExtraction`)
 * on both sides, and the provider env and the run's `createdAt` are fixed. The
 * real root `extractRuleCandidates` answers on disk and what it left (candidate
 * files, the cursor) is read back; the directories are removed before any case
 * runs. Each case runs the bound body over a MUTABLE copy and requires the
 * disk's result and leavings.
 *
 * WHAT RUNS FOR REAL IN MEMORY. The extraction body (provenance, language,
 * changed-source selection against the cursor, numbering, the provider call
 * through its stub, candidate building, the human-decision guard, validation)
 * and, under the composition, the REAL cursor read and update, change detection
 * with the source selection and hashing, and the candidate read and write bodies.
 *
 * THE ROOT ROUTE IS UNCHANGED. The six root readers and writers are spied: the
 * disk asks reach them all, the bound route none.
 *
 * NOT SHOWN HERE: the candidate store's confinement, the cursor's hardened
 * replacement and link defenses, and a non-default output language; the rule
 * candidate, rule state and storage I/O suites show those. The doubles are not
 * a hosted store, not an access-control layer and not `ProjectStore`.
 */

import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "bun:test";
import { restoreEnv, stubEnv } from "../stubs.js";
import * as hasher from "../../src/compiler/hasher.js";
import * as ruleCandidates from "../../src/compiler/rule-candidates.js";
import type { RuleCandidateLeaves } from "../../src/compiler/rule-candidates.js";
import { extractRuleCandidates, extractRuleCandidatesWith, ruleExtractionStepsOver } from "../../src/compiler/rule-extractor.js";
import * as ruleState from "../../src/compiler/rule-state.js";
import type { RuleStateLeaf } from "../../src/compiler/rule-state.js";
import * as diskLocations from "../../src/storage/disk-locations.js";
import { candidateFileId } from "../../src/utils/candidate-store.js";
import { RULE_CANDIDATES_DIR, RULE_STATE_FILE } from "../../src/utils/constants.js";
import { seedRuleSource, stubRuleExtraction } from "../fixtures/rule-extraction.js";
import { tempRootTracker } from "../temp-roots.js";
import { copiedLocalReadsOf } from "./copied-local-reads.js";
import { enoent, heldText, mintCopiedBeforeAsk, mintOnceThenRemove, type Copy, type Minted, type Note } from "./copied-project.js";

const PREFIX = "rule-extraction-binding-";
const CREATED_AT = "2026-05-31T00:00:00.000Z";

/** What extraction answered and what it left: candidate files and the cursor, by path. */
interface Outcome { result: unknown; left: Record<string, string> }

/** Read back what extraction can leave, through `list` (null when absent) and `read` (null when absent). */
async function leftBy(list: (relDir: string) => Promise<string[] | null>, read: (rel: string) => Promise<string | null>): Promise<Record<string, string>> {
  const left: Record<string, string> = {};
  for (const name of ((await list(RULE_CANDIDATES_DIR)) ?? []).filter((entry) => entry.endsWith(".json")).sort()) {
    left[`${RULE_CANDIDATES_DIR}/${name}`] = (await read(`${RULE_CANDIDATES_DIR}/${name}`))!;
  }
  const cursor = await read(RULE_STATE_FILE);
  if (cursor !== null) left[RULE_STATE_FILE] = cursor;
  return left;
}

/** The three seeds: a fresh source; one whose candidate was approved and cursor dropped; one already extracted. */
const SEEDS = {
  fresh: (root: string) => seedRuleSource(root),
  decided: async (root: string) => {
    await seedRuleSource(root);
    const { candidates } = await extractRuleCandidates(root, CREATED_AT);
    await ruleCandidates.setRuleCandidateStatus(root, candidateFileId(candidates[0]!.id), "approved");
    await rm(path.join(root, RULE_STATE_FILE));
  },
  current: async (root: string) => { await seedRuleSource(root); await extractRuleCandidates(root, CREATED_AT); },
};
type Name = keyof typeof SEEDS;

/** The six root readers and writers the root route calls. */
const rootSpies = () => [vi.spyOn(ruleState, "readRuleState"), vi.spyOn(hasher, "detectChanges"), vi.spyOn(diskLocations, "readLocationText"),
  vi.spyOn(ruleCandidates, "readRuleCandidate"), vi.spyOn(ruleCandidates, "writeRuleCandidate"), vi.spyOn(ruleState, "updateRuleSourceState")];

const tracker = tempRootTracker();
const minted = {} as Record<Name, Minted<Outcome>>;
let rootReached = [false, false, false, false, false, false];
/** The fresh scenario's disk ask: its root, and each root step's calls with their exact arguments. */
let freshAsk: { root: string; calls: unknown[][][] };

beforeAll(() => { stubEnv("LLMWIKI_PROVIDER", "anthropic"); stubEnv("ANTHROPIC_API_KEY", "test-key"); });
mintOnceThenRemove(tracker, async () => {
  await stubRuleExtraction();
  const spies = rootSpies();
  for (const name of Object.keys(SEEDS) as Name[]) {
    // The seed's own extraction runs are not the ask: the spies count only the disk ask, accumulated over the scenarios.
    const seed = async (root: string) => { await mkdir(path.join(root, "sources"), { recursive: true }); await SEEDS[name](root); spies.forEach((spy) => spy.mockClear()); };
    minted[name] = await mintCopiedBeforeAsk(tracker, PREFIX, seed, async (root) => ({
      result: await extractRuleCandidates(root, CREATED_AT),
      left: await leftBy((relDir) => readdir(path.join(root, relDir)).catch(() => null),
        (rel) => readFile(path.join(root, rel), "utf-8").catch(() => null)),
    }));
    rootReached = rootReached.map((reached, at) => reached || spies[at]!.mock.calls.length > 0);
    if (name === "fresh") freshAsk = { root: minted.fresh.dir, calls: spies.map((spy) => spy.mock.calls.map((call) => [...call])) };
  }
});
afterAll(() => { restoreEnv(); });

/** Hold `text` at `rel` in the mutable copy, listing it under its directory as the disk would. */
function hold(project: Copy, rel: string, text: string): void {
  const dir = path.posix.dirname(rel), name = path.posix.basename(rel), listed = project.listings.get(dir) ?? [];
  project.files.set(rel, text);
  if (!listed.some((entry) => entry.name === name)) project.listings.set(dir, [...listed, { name, kind: "file" }]);
}

/** The cursor leaf over the copy. */
const cursorOf = (project: Copy, note: Note): RuleStateLeaf => ({
  present: async () => { note("present"); return project.files.has(RULE_STATE_FILE); },
  readText: async () => { note("read"); return heldText(project, RULE_STATE_FILE); },
  replace: async (text) => { note("replace"); hold(project, RULE_STATE_FILE, text); },
});

/** The candidate store's leaves over the copy: missing reads are empty text, as on disk. */
function candidatesOf(project: Copy, note: Note): RuleCandidateLeaves {
  const fileOf = (fileId: string, location: "active" | "archive") => `${RULE_CANDIDATES_DIR}${location === "archive" ? "/archive" : ""}/${fileId}.json`;
  return {
    readText: async (fileId, location) => { note(`read ${location}`); return project.files.get(fileOf(fileId, location)) ?? ""; },
    writeText: async (fileId, render) => { note("write"); hold(project, fileOf(fileId, "active"), render()); return fileOf(fileId, "active"); },
    listFileIds: async () => { throw enoent(); },
    archive: async () => { throw enoent(); },
  };
}

/** Run scenario `name`'s extraction over its own fresh mutable copy through the bound composition. */
async function extractOver(name: Name) {
  await stubRuleExtraction();
  const project: Copy = { files: new Map(minted[name].copy.files), listings: new Map(minted[name].copy.listings) };
  const log: string[] = [];
  const note = (seam: string): Note => (call) => { log.push(`${seam}:${call}`); };
  const steps = ruleExtractionStepsOver({ cursor: cursorOf(project, note("cursor")), reads: copiedLocalReadsOf(project, note("reads")), candidates: candidatesOf(project, note("candidates")) });
  const result = await extractRuleCandidatesWith(steps, CREATED_AT);
  const left = await leftBy(async (relDir) => project.listings.get(relDir)?.map((entry) => entry.name) ?? null, async (rel) => project.files.get(rel) ?? null);
  return { outcome: { result, left }, log };
}

describe("rule extraction over copied projects, with the directories gone", () => {
  it("R1 extracts a fresh source exactly as the disk did: one candidate written, the cursor advanced", async () => {
    const { outcome } = await extractOver("fresh");
    expect(outcome).toEqual(minted.fresh.onDisk);
    expect([(minted.fresh.onDisk.result as { candidates: unknown[] }).candidates.length, RULE_STATE_FILE in minted.fresh.onDisk.left]).toEqual([1, true]);
  });

  it("R2 keeps an approved candidate as the disk did, noting it and still advancing the cursor", async () => {
    const { outcome } = await extractOver("decided");
    expect(outcome).toEqual(minted.decided.onDisk);
    expect((minted.decided.onDisk.result as { notes: string[] }).notes.some((line) => line.startsWith("Kept approved candidate"))).toBe(true);
  });

  // Change detection still hashes the source; what the current cursor spares is the extraction itself.
  it("R3 skips a source the cursor already holds, as the disk did: no provider extraction, no candidate read or write", async () => {
    const { outcome, log } = await extractOver("current");
    expect(outcome).toEqual(minted.current.onDisk);
    expect([(minted.current.onDisk.result as { processedSources: string[] }).processedSources, log.some((call) => call.startsWith("candidates:"))]).toEqual([[], false]);
  });

  it("R4 reads the cursor and detects changes first, then per source reads, extracts, guards, writes and advances the cursor", async () => {
    const { log } = await extractOver("fresh");
    const seams = log.map((call) => call.split(":")[0]).filter((seam, at, all) => seam !== all[at - 1]);
    expect(seams).toEqual(["cursor", "reads", "candidates", "cursor"]);
    expect(log.filter((call) => call.startsWith("candidates:"))).toEqual(["candidates:read active", "candidates:read archive", "candidates:write"]);
    // A fresh project has no cursor yet: the advance finds none, then replaces it.
    expect(log.slice(-2)).toEqual(["cursor:present", "cursor:replace"]);
  });

  it("R5 the root route reached all six root steps, the fresh ask with its exact arguments; the bound route reaches none", async () => {
    expect(rootReached).toEqual([true, true, true, true, true, true]);
    const { root, calls: [cursorReads, detections, texts, candidateReads, writes, advances] } = freshAsk;
    const [candidate] = (minted.fresh.onDisk.result as { candidates: Array<{ id: string }> }).candidates;
    const fileId = candidateFileId(candidate!.id);
    expect([cursorReads, detections]).toEqual([[[root]], [[root, { version: 1, indexHash: "", sources: {} }]]]);
    expect(texts).toContainEqual([path.join(root, "sources", "guide.md")]);
    expect([candidateReads, writes]).toEqual([[[root, fileId, "active"], [root, fileId, "archive"]], [[root, candidate]]]);
    expect(advances).toEqual([[root, "guide.md", { hash: expect.any(String), concepts: [], compiledAt: CREATED_AT, outputLanguage: "" }]]);
    const spies = rootSpies();
    await extractOver("fresh");
    expect(spies.map((spy) => spy.mock.calls.length)).toEqual(spies.map(() => 0));
  });
});
