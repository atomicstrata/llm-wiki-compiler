/**
 * @file test/storage/query-publication-binding.test.ts
 * @description The WHOLE query publication consumer, `maybeSaveQueryPageFrom`,
 * over the bound composition `queryPublicationStepsOver`, with no project
 * directory. This file uses both, which exist only after publication was given
 * steps of its own, so it has NO before-edit run.
 *
 * HOW IT IS BUILT. Small projects are minted on real disk once and COPIED into
 * memory BEFORE the disk ask, because the ask writes. The real root
 * `maybeSaveQueryPage` then answers on disk and what it left (saved query pages,
 * the index, pending candidates) is read back; the directories are removed
 * before any case runs. Each case runs the bound composition over a MUTABLE copy
 * and requires the disk's answer and what it left, with clocks and minted
 * candidate ids hidden on both sides. Embedding refreshes are switched off
 * (`LLMWIKI_EMBEDDINGS=false`) on both sides, so the refresh is the incumbent
 * skip; its seam here would log and throw if reached.
 *
 * WHAT RUNS FOR REAL IN MEMORY. The publication body (the `save` gate, the lock
 * around every decision, the direct-save profile gate, the canonical document,
 * fresh strict validation and its refusals, stage or save) and, under the
 * composition, the REAL lower bodies: the profile gate, the citation index and
 * its post-write projection, the proposal's ENOENT-only precondition and the
 * fresh-candidate allocator, the save's write, notice and index regeneration.
 *
 * THE LOCK IS THE HOST'S. The memory lock only records acquire and release.
 * THE ROOT ROUTE IS UNCHANGED. Five root-taking functions are wrapped by pass-
 * through spies; the disk asks reach all five, the bound route none.
 *
 * NOT SHOWN HERE: the disk's lock, confinement, atomic and no-replace writes, a
 * usable embedding store or a typed index section. The query publication suites
 * (`query-publication-race`, `query-publication-sdk-mcp`, `query-proposal`,
 * `answer-publication*`) show those. The doubles are not a hosted store, not an
 * access-control layer and not `ProjectStore`.
 */

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi, type Mock } from "bun:test";
import { restoreEnv, stubEnv } from "../stubs.js";
import { passThrough } from "./pass-through-mock.js";
import { collectAnswerCitationIndex } from "../../src/citations/answer-index.js";
import type { CandidatePublicationStore } from "../../src/compiler/candidate-publication.js";
import { writeCandidate, writeFreshCandidate } from "../../src/compiler/candidates.js";
import { collectPageSummariesFrom, generateIndex, type IndexGenerationSources } from "../../src/compiler/indexgen.js";
import {
  maybeSaveQueryPage, maybeSaveQueryPageFrom, queryPublicationStepsOver, type QueryPublicationSources,
} from "../../src/commands/query-publication.js";
import { loadNonDefaultProfile, loadNonDefaultProfileFrom } from "../../src/profile/block.js";
import { CANDIDATES_ARCHIVE_DIR, CANDIDATES_DIR, CONCEPTS_DIR, INDEX_FILE, QUERIES_DIR } from "../../src/utils/constants.js";
import { updateEmbeddingsLockedCore } from "../../src/utils/embeddings.js";
import { PAPERS_PROFILE } from "../fixtures/typed-grounding.js";
import { writeProfileFile } from "../fixtures/profile-fixtures.js";
import { tempRootTracker } from "../temp-roots.js";
import { copiedCitationSourcesOf } from "./copied-local-reads.js";
import {
  effectiveProfileOf, expectRemovedDefaultCopies, expectRemovedLegacyProfileCopies, heldText, mintCopiedBeforeAsk, mintOnceThenRemove, pageScanOf, stepsOf,
  unasked, writeFiles, type Copy, type Minted, type Note,
} from "./copied-project.js";

// Copy the real modules first: vi.mock patches them in place, so a later read would see the mock.
const realIndexgen = { ...(await import("../../src/compiler/indexgen.js")) };
const realEmbeddings = { ...(await import("../../src/utils/embeddings.js")) };
const realCandidates = { ...(await import("../../src/compiler/candidates.js")) };
const realAnswerIndex = { ...(await import("../../src/citations/answer-index.js")) };
const realBlock = { ...(await import("../../src/profile/block.js")) };

vi.mock("../../src/compiler/indexgen.js", () => passThrough(realIndexgen, "generateIndex"));
vi.mock("../../src/utils/embeddings.js", () => passThrough(realEmbeddings, "updateEmbeddingsLockedCore"));
vi.mock("../../src/compiler/candidates.js", () => passThrough(realCandidates, "writeFreshCandidate"));
vi.mock("../../src/citations/answer-index.js", () => passThrough(realAnswerIndex, "collectAnswerCitationIndex"));
vi.mock("../../src/profile/block.js", () => passThrough(realBlock, "loadNonDefaultProfile"));

/** The five root-taking functions the root publication route calls. */
const ROOT_STEPS = [generateIndex, updateEmbeddingsLockedCore, writeFreshCandidate, collectAnswerCitationIndex, loadNonDefaultProfile]
  .map((step) => step as unknown as Mock<(...args: never[]) => unknown>);

const PREFIX = "query-publication-binding-";
const QUESTION = "How does alpha relate?";
const SLUG = "how-does-alpha-relate";
const page = (title: string, body: string): string => `---\ntitle: ${title}\nsummary: ${title} summary.\n---\n\n${body}\n`;
const WIKI = {
  [INDEX_FILE]: "# Index\n", [`${CONCEPTS_DIR}/alpha.md`]: page("Alpha", "Alpha body."), [`${CONCEPTS_DIR}/beta.md`]: page("Beta", "Beta body."),
};

/** One publication scenario: what is seeded, and what publication is asked. */
interface Scenario { seed(root: string): Promise<void>; answer: string; review?: boolean }
const SCENARIOS = {
  save: { seed: (root) => writeFiles(root, WIKI), answer: "Alpha relates to [[Beta]]." },
  stage: { seed: (root) => writeFiles(root, WIKI), answer: "Alpha relates to [[Beta]].", review: true },
  stageOverExisting: { seed: (root) => writeFiles(root, { ...WIKI, [`${QUERIES_DIR}/${SLUG}.md`]: page("Old", "Old answer.") }), answer: "See [[Alpha]].", review: true },
  broken: { seed: (root) => writeFiles(root, WIKI), answer: "See [[Gone]]." },
  pendingDirect: { seed: seedPending, answer: "See [[pending-topic]]." },
  pendingProposal: { seed: seedPending, answer: "See [[pending-topic]].", review: true },
  profileEnabled: { seed: async (root) => { await writeFiles(root, WIKI); await writeProfileFile(root, PAPERS_PROFILE); }, answer: "See [[Alpha]]." },
} satisfies Record<string, Scenario>;
type Name = keyof typeof SCENARIOS;

/** A default wiki with one pending review candidate whose slug an answer can cite. */
async function seedPending(root: string): Promise<void> {
  await writeFiles(root, WIKI);
  await writeCandidate(root, { title: "Pending topic", slug: "pending-topic", summary: "", sources: [], body: page("Pending topic", "Later.") });
}

/** What publication answered and what it left: saved query pages, the index, and pending candidates, by path. */
interface Outcome { result: unknown; left: Record<string, string> }

/** Clocks and minted candidate ids hidden, so two runs of the same publication compare equal. */
const unclocked = (value: unknown): unknown => JSON.parse(JSON.stringify(value)
  .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z/gu, "<at>")
  .replace(/(pending-topic|how-does-alpha-relate)-[0-9a-f]{8,}/gu, "$1-<id>"));

/** Read back what publication can leave, through `list` (null when absent) and `read`. */
async function leftBy(list: (relDir: string) => Promise<string[] | null>, read: (rel: string) => Promise<string>): Promise<Record<string, string>> {
  const left: Record<string, string> = { [INDEX_FILE]: await read(INDEX_FILE) };
  for (const relDir of [QUERIES_DIR, CANDIDATES_DIR]) {
    for (const name of (await list(relDir)) ?? []) left[`${relDir}/${name}`] = await read(`${relDir}/${name}`);
  }
  return left;
}

const tracker = tempRootTracker();
const minted = {} as Record<Name, Minted<Outcome>>;
let rootReached: boolean[];

beforeAll(() => { stubEnv("LLMWIKI_EMBEDDINGS", "false"); ROOT_STEPS.forEach((step) => step.mockClear()); });
mintOnceThenRemove(tracker, async () => {
  for (const name of Object.keys(SCENARIOS) as Name[]) {
    const scenario: Scenario = SCENARIOS[name];
    minted[name] = await mintCopiedBeforeAsk(tracker, PREFIX, scenario.seed, async (root) => ({
      result: await maybeSaveQueryPage({ root, question: QUESTION, answer: scenario.answer, save: true, review: scenario.review }),
      left: await leftBy((relDir) => readdir(path.join(root, relDir)).catch(() => null), (rel) => readFile(path.join(root, rel), "utf-8")),
    }));
  }
  rootReached = ROOT_STEPS.map((step) => step.mock.calls.length > 0);
});
afterAll(() => { restoreEnv(); });

/** Hold `text` at `rel` in the mutable copy, listing it (and any new directory) as the disk would. */
function hold(project: Copy, rel: string, text: string): void {
  project.files.set(rel, text);
  for (let child = rel, dir = path.posix.dirname(rel); child !== "."; child = dir, dir = path.posix.dirname(dir)) {
    const key = dir === "." ? "" : dir, listed = project.listings.get(key) ?? [];
    const name = path.posix.basename(child), kind = child === rel ? "file" as const : "directory" as const;
    if (!listed.some((entry) => entry.name === name)) project.listings.set(key, [...listed, { name, kind }]);
  }
}

/** The candidate store over the mutable copy, under a memory project root; nothing here decides custody. */
function candidateStoreOf(project: Copy, note: Note): CandidatePublicationStore {
  const relOf = (location: string): string => path.posix.relative("/memory/project", location);
  const located = (relDir: string): string | null => project.listings.has(relDir) ? `/memory/project/${relDir}` : null;
  return {
    assertNamespacesHealthy: async () => {
      const [pending, archive] = [CANDIDATES_DIR, CANDIDATES_ARCHIVE_DIR].map(located);
      note("health");
      return { pending: pending ?? null, archive: archive ?? null };
    },
    ownedDirectory: async (relDir) => { note(`dir ${relDir}`); return located(relDir); },
    leafPresent: async (dir, leafName) => { note(`present ${leafName}`); return project.files.has(`${relOf(dir)}/${leafName}`); },
    createPending: async (id, text, hooks) => {
      note("create");
      await hooks.afterParentCheck();
      hold(project, `${CANDIDATES_DIR}/${id}.json`, text);
      await hooks.afterCommit?.();
    },
  };
}

/** The index generation over the mutable copy: the real summary and profile bodies, publishing into the copy. */
function indexSourcesOf(project: Copy, note: Note): IndexGenerationSources {
  return {
    conceptSummaries: () => collectPageSummariesFrom(pageScanOf(project, CONCEPTS_DIR, note)),
    querySummaries: () => collectPageSummariesFrom(pageScanOf(project, QUERIES_DIR, note)),
    loadProfile: () => loadNonDefaultProfileFrom(effectiveProfileOf(project, note)),
    collectEntityPages: unasked("index.collectEntityPages"),
    publishIndex: async (content) => { note("publish"); hold(project, INDEX_FILE, content); },
  };
}

/** Every publication seam over the mutable `project`, each call logged as `<seam>:<call>`; `faults` replace seams. */
function sourcesOf(project: Copy, log: string[], faults: Partial<QueryPublicationSources> = {}): QueryPublicationSources {
  const note = (seam: string): Note => (call) => { log.push(`${seam}:${call}`); };
  return {
    lock: { acquire: async () => note("lock")("acquire"), release: async () => note("lock")("release") },
    profile: effectiveProfileOf(project, note("profile")),
    citations: copiedCitationSourcesOf(project, note("citations")),
    readTargetText: async (rel) => { note("target")(rel); return heldText(project, rel); },
    candidates: candidateStoreOf(project, note("candidates")),
    writePage: async (rel, text) => { note("page")(rel); hold(project, rel, text); },
    locate: (rel) => `/memory/project/${rel}`,
    index: indexSourcesOf(project, note("index")),
    embeddings: new Proxy({}, { get: (_target, seam) => { note("embeddings")(String(seam)); throw new Error("embeddings reached"); } }) as QueryPublicationSources["embeddings"],
    ...faults,
  };
}

/** Publish scenario `name` over its own fresh mutable copy; `request` overrides what it is asked. */
async function publishOver(name: Name, request: { save?: boolean } = {}, faults: Partial<QueryPublicationSources> = {}) {
  const project: Copy = { files: new Map(minted[name].copy.files), listings: new Map(minted[name].copy.listings) };
  const log: string[] = [], scenario: Scenario = SCENARIOS[name];
  const ask = { question: QUESTION, answer: scenario.answer, save: true, review: scenario.review, ...request };
  const result = await maybeSaveQueryPageFrom(queryPublicationStepsOver(sourcesOf(project, log, faults)), ask);
  const left = await leftBy(async (relDir) => project.listings.get(relDir)?.map((entry) => entry.name) ?? null, async (rel) => heldText(project, rel));
  return { result, left, log, steps: stepsOf(log) };
}

/** The scenario's memory outcome, required to equal the disk's with clocks and ids hidden. */
async function expectDiskOutcome(name: Name): Promise<Awaited<ReturnType<typeof publishOver>>> {
  const run = await publishOver(name);
  expect(unclocked({ result: run.result, left: run.left })).toEqual(unclocked(minted[name].onDisk));
  return run;
}

describe("query publication over copied projects, with the directories gone", () => {
  it("P1 the copies were taken before the asks and every minting directory is gone", () => {
    expectRemovedDefaultCopies((Object.keys(SCENARIOS) as Name[]).filter((name) => name !== "profileEnabled").map((name) => minted[name]), PREFIX);
    expectRemovedLegacyProfileCopies([minted.profileEnabled], PREFIX);
  });

  it("P2 a direct save writes the page and regenerates the index as the disk did, in order, under the lock", async () => {
    const run = await expectDiskOutcome("save");
    expect(run.result).toEqual({ saved: SLUG });
    expect(run.steps).toEqual(["lock", "profile", "citations", "page", "index", "lock"]);
  });

  it("P3 a reviewed save stages the candidate the disk staged, without the profile gate, for an absent and an existing target", async () => {
    for (const name of ["stage", "stageOverExisting"] as const) {
      const run = await expectDiskOutcome(name);
      expect(run.steps).toEqual(["lock", "citations", "target", "candidates", "lock"]);
    }
    expect(JSON.stringify(minted.stage.onDisk.left)).toContain("expectTargetAbsent");
    expect(JSON.stringify(minted.stageOverExisting.onDisk.left)).toContain("expectedTargetHash");
  });

  it("P4 refuses a broken citation, a pending one on a direct save, and a profile-enabled direct save as the disk did, releasing the lock", async () => {
    const codes: unknown[] = [];
    for (const name of ["broken", "pendingDirect", "profileEnabled"] as const) {
      const run = await expectDiskOutcome(name);
      codes.push((run.result as { publicationRefusal?: { code: string } }).publicationRefusal?.code);
      expect([run.steps[0], run.steps.at(-1), run.steps.includes("page")]).toEqual(["lock", "lock", false]);
    }
    expect(codes).toEqual(["broken", "pending", "profile-disabled"]);
    expect(((await expectDiskOutcome("pendingProposal")).result as { candidateId?: string }).candidateId).toMatch(/^how-does-alpha-relate-/u);
  });
});

describe("what publication refuses and propagates", () => {
  it("P5 an unavailable citation index refuses as unavailable; a precondition fault and a page-write fault reject after release", async () => {
    const down = await publishOver("save", {}, { citations: { resolveProject: async () => { throw new Error("index down"); } } });
    expect((down.result as { publicationRefusal: { code: string } }).publicationRefusal.code).toBe("unavailable");
    const fault = Object.assign(new Error("EACCES: denied"), { code: "EACCES" });
    for (const [name, faults] of [["stage", { readTargetText: async () => { throw fault; } }], ["save", { writePage: async () => { throw fault; } }]] as const) {
      const log: string[] = [];
      const project: Copy = { files: new Map(minted[name].copy.files), listings: new Map(minted[name].copy.listings) };
      const scenario: Scenario = SCENARIOS[name];
      await expect(maybeSaveQueryPageFrom(queryPublicationStepsOver(sourcesOf(project, log, faults)),
        { question: QUESTION, answer: scenario.answer, save: true, review: scenario.review })).rejects.toBe(fault);
      expect(log.at(-1)).toBe("lock:release");
    }
  });

  it("P6 without save nothing is asked, not even the lock", async () => {
    const run = await publishOver("save", { save: false });
    expect([run.result, run.log]).toEqual([{}, []]);
  });

  it("P7 the root route reached all five root functions; the bound route reaches none", async () => {
    expect(rootReached).toEqual(ROOT_STEPS.map(() => true));
    ROOT_STEPS.forEach((step) => step.mockClear());
    for (const name of Object.keys(SCENARIOS) as Name[]) await publishOver(name);
    expect(ROOT_STEPS.map((step) => step.mock.calls.length)).toEqual(ROOT_STEPS.map(() => 0));
  });
});

