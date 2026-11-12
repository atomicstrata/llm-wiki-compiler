/**
 * @file test/storage/review-approve-binding.test.ts
 * @description `review approve`'s under-lock WRITE HALF, WHOLE, with no ambient
 * disk for its writes: `approveUnderLockWith` drives the REAL planner body
 * (`planPageMutationFrom`), the REAL held-lock executor body over raw journal and
 * page I/O held in memory, and the REAL review tail (`finalizeReviewApprovalsWith`:
 * source state first through the accepted state record bodies, resolution and
 * repair through the compile write and id bodies, index, MOC, then the
 * embeddings drain, here a recorder). The bodies exist only after approval was
 * given bodies of its own, so this file has NO before-edit run.
 *
 * WHAT STAYS ROOT-BOUND, AND IS FAKED HERE AND LABELLED. The AUTHORITY
 * collaborators — the custody-aware candidate re-read (here: the copied record's
 * JSON), the target precondition, the candidate-store access check, the
 * publication check and the typed promotion — and the custody-aware candidate
 * deletion (here: dropping the copied record). They are not storage ports and
 * this file proves nothing about them; the incumbent suites own them. The lock,
 * its recovery gate and the pre-lock fast-fail stay in `runReviewUnderLock`.
 *
 * HOW IT IS BUILT. One project is minted on real disk, once, and copied BEFORE
 * its disk ask; its seed is two pages, a state record, an invalid candidate and
 * a valid one, staged by the real `writeCandidate`. The ask runs the ROOT
 * `review approve` command from the project (as its CLI tests do) with Date fixed
 * and embeddings disabled by env, settling each candidate once with the exit
 * code, the status lines (root shown as `<root>`) and the pages, state record
 * and candidate records. The memory replay must equal the disk.
 */

import { realpath } from "node:fs/promises";
import { describe, expect, it, vi, setSystemTime } from "bun:test";
import { restoreEnv, stubEnv } from "../stubs.js";
import * as candidates from "../../src/compiler/candidates.js";
import { writeCandidate } from "../../src/compiler/candidates.js";
import { CandidateCustodyUnavailableError } from "../../src/compiler/candidate-custody.js";
import * as custody from "../../src/compiler/candidate-custody.js";
import { applyCompilePageWritesWith, type CompilePageWriteSteps } from "../../src/compiler/compile-write.js";
import { applyCompilePageWritesWithIdsWith, type CompilePageWritePass } from "../../src/compiler/compile-write-ids.js";
import * as indexgen from "../../src/compiler/indexgen.js";
import { collectPageSummariesFrom, generateIndexFrom } from "../../src/compiler/indexgen.js";
import * as repair from "../../src/compiler/link-repair.js";
import { repairLinksFrom } from "../../src/compiler/link-repair.js";
import * as obsidian from "../../src/compiler/obsidian.js";
import { generateMOCFrom } from "../../src/compiler/obsidian.js";
import * as resolver from "../../src/compiler/resolver.js";
import { resolveLinksFrom } from "../../src/compiler/resolver.js";
import reviewApproveCommand, { approveUnderLockWith, type ReviewApproveSteps } from "../../src/commands/review-approve.js";
import * as reviewFinalize from "../../src/commands/review-finalize.js";
import { finalizeReviewApprovalsWith, type ReviewFinalizeSteps } from "../../src/commands/review-finalize.js";
import * as publication from "../../src/commands/review-publication.js";
import * as targetPrecondition from "../../src/commands/review-target-precondition.js";
import type { LegacyLocalReads } from "../../src/storage/legacy-local-reads.js";
import type { LegacyLocalRecordDirs } from "../../src/storage/legacy-local-record-dirs.js";
import type { LegacyLocalRecords } from "../../src/storage/legacy-local-records.js";
import * as executor from "../../src/trust/executor.js";
import { applyApprovedMutationsLockedFrom, type ApprovedMutationPorts } from "../../src/trust/executor.js";
import * as planner from "../../src/trust/planner.js";
import { planPageMutationFrom } from "../../src/trust/planner.js";
import { CandidateProfileError } from "../../src/trust/promote.js";
import { CANDIDATES_DIR, ENV_EMBEDDINGS, INDEX_FILE, MOC_FILE, STATE_FILE } from "../../src/utils/constants.js";
import * as embeddingsRefresh from "../../src/utils/embeddings-refresh.js";
import * as output from "../../src/utils/output.js";
import * as state from "../../src/utils/state.js";
import { readStateFrom, writeStateTo } from "../../src/utils/state.js";
import type { ReviewCandidate } from "../../src/utils/types.js";
import { tempRootTracker } from "../temp-roots.js";
import { MEM_ROOT, keyOf, memoryIo, memoryStores as compileMemoryStores, namesIn, put, type Held } from "./compile-memory-steps.js";
import { enoent, mintCopiedBeforeAsk, writeFiles } from "./copied-project.js";
import { diskTree, captureStatusLines, mintSingle, sortedTree, type KeepLeaf } from "./project-tree.js";
import { expectMintingDirectoryRemoved } from "./minted-directory.js";

const PREFIX = "review-approve-binding-";
const C = "wiki/concepts";
const NOW = new Date("2026-02-03T04:05:06.000Z");
const page = (title: string, text: string): string => `---\ntitle: ${title}\n---\n\n${text}\n`;
const SEED: Record<string, string> = {
  [`${C}/alpha.md`]: page("Alpha", "Alpha mentions Beta."),
  [STATE_FILE]: JSON.stringify({ version: 1, indexHash: "", sources: { "a.md": { hash: "ha", concepts: ["alpha"], compiledAt: "t" } } }),
};
const draft = (slug: string, body: string) =>
  ({ title: slug, slug, summary: "S", sources: ["b.md"], body, sourceStates: { "b.md": { hash: "hb", concepts: [], compiledAt: "t" } } });
/** What the comparison sees: pages, the state record and candidate records, nothing private beyond them. */
const shown = (rel: string): boolean => rel.startsWith("wiki/") || rel === STATE_FILE || (rel.startsWith(`${CANDIDATES_DIR}/`) && rel.endsWith(".json"));

/** One approval surface, root or bound, over one project. */
interface Side { displayRoot: string; approve(id: string): Promise<void>; tree(): Promise<Record<string, string>> }

/** Approve the invalid candidate, then the valid one; each settled once with exit code, statuses and the shown tree. */
async function runScenario(side: Side, ids: { bad: string; good: string }): Promise<string[]> {
  const statuses: string[] = [];
  const status = captureStatusLines(statuses, (text) => text.split(side.displayRoot).join("<root>"));
  setSystemTime(NOW);
  const out: string[] = [];
  try {
    for (const [name, id] of [["refuse-invalid", ids.bad], ["approve", ids.good]] as const) {
      process.exitCode = 0;
      const settled = await side.approve(id).then(() => "ok", (error: Error) => `${error.name}: ${error.message}`);
      out.push(JSON.stringify({ name, settled, exitCode: process.exitCode ?? 0, statuses: statuses.splice(0), tree: await side.tree() }));
    }
  } finally {
    process.exitCode = 0;
    setSystemTime();
    status.mockRestore();
  }
  return out;
}

/** The shown files under `root`. */
const shownFile: KeepLeaf = (rel, entry) => entry.isFile() && shown(rel);

/** Run `fn` from `root` with embeddings disabled by env, as the CLI tests do. */
async function fromRoot<T>(root: string, fn: () => Promise<T>): Promise<T> {
  const previous = process.cwd();
  process.chdir(root);
  stubEnv(ENV_EMBEDDINGS, "off");
  try {
    return await fn();
  } finally {
    restoreEnv();
    process.chdir(previous);
  }
}

const tracker = tempRootTracker();
const ids = { bad: "", good: "" };
const minted = mintSingle<string[]>(tracker, () => mintCopiedBeforeAsk(tracker, PREFIX, async (root) => {
  await writeFiles(root, SEED);
  ids.bad = (await writeCandidate(root, draft("bad", "no frontmatter at all\n"))).id;
  ids.good = (await writeCandidate(root, draft("beta", page("Beta", "Beta mentions Alpha.")))).id;
}, async (root) => {
  const real = await realpath(root);
  return fromRoot(root, () => runScenario({ displayRoot: real, approve: (id) => reviewApproveCommand(id), tree: () => diskTree(root, shownFile) }, ids));
}));

/** A member these bodies never expect to be asked. */
const unasked = (name: string) => async (): Promise<never> => { throw new Error(`${name} not asked`); };

/** The copy, after requiring that it holds the seed and both staged candidate records. */
function seededCopy(): Held {
  const files = minted.copy.files;
  expect(Object.keys(SEED).map((rel) => files.get(rel))).toEqual(Object.values(SEED));
  expect([ids.bad, ids.good].map((id) => files.has(`${CANDIDATES_DIR}/${id}.json`))).toEqual([true, true]);
  return { files: new Map(files), dirs: new Set(minted.copy.listings.keys()) };
}

/** The legacy reads and state records over the live map; only the members these bodies ask. */
function memoryStores(held: Held): { reads: LegacyLocalReads; records: LegacyLocalRecords } {
  const reads = {
    exists: async (rel: string) => held.files.has(rel) || held.dirs.has(rel),
    listNames: async (rel: string) => { if (!held.dirs.has(rel)) throw enoent(); return namesIn(held, rel); },
    statNoFollow: async (rel: string) => { if (held.files.has(rel)) return "file" as const; throw enoent(); },
    readConfinedPage: async (relDir: string, slug: string) => {
      const text = held.files.get(`${relDir}/${slug}.md`);
      return text === undefined ? { dropped: "escapes-dir" } : { content: text };
    },
  } as unknown as LegacyLocalReads;
  return { reads, records: compileMemoryStores(held).records };
}

/** The review tail over the live map: the real bodies, with the embeddings drain recorded. */
function memoryTail(held: Held, write: CompilePageWriteSteps, drained: string[][]): ReviewFinalizeSteps {
  const { reads, records } = memoryStores(held);
  const pass: CompilePageWritePass = (root, items, options) => applyCompilePageWritesWith(write, root, items, options);
  // Pending candidates only steer repair for links that are already broken; none are here, so none are listed.
  const candidateDirs = { directory: async () => null, leaf: unasked("candidates.leaf") } as unknown as LegacyLocalRecordDirs;
  const scan = (dir: string) => ({ listNames: () => reads.listNames(dir), readPage: (slug: string) => reads.readConfinedPage(dir, slug) });
  return {
    readState: () => readStateFrom(records), writeState: (_root, next) => writeStateTo(records, next),
    resolveLinks: async (root, changed, created, before) => applyCompilePageWritesWithIdsWith(pass, root, await resolveLinksFrom(reads, changed, created), before),
    repairLinks: async (root, before) => applyCompilePageWritesWithIdsWith(pass, root, await repairLinksFrom({ pages: reads, candidates: candidateDirs }), before),
    generateIndex: () => generateIndexFrom({
      conceptSummaries: () => collectPageSummariesFrom(scan(C)), querySummaries: () => collectPageSummariesFrom(scan("wiki/queries")),
      loadProfile: async () => undefined, collectEntityPages: unasked("collectEntityPages"), publishIndex: async (text) => { put(held, INDEX_FILE, text); },
    }),
    generateMOC: () => generateMOCFrom({ listConceptNames: () => reads.listNames(C), readConceptPage: (slug) => reads.readConfinedPage(C, slug), publishMoc: async (text) => { put(held, MOC_FILE, text); } }),
    refreshDraining: async (_root, pageIds) => { drained.push(pageIds); },
    refreshAffected: unasked("refreshAffected"),
  };
}

/** The approval collaborators over the live map: real write bodies; the AUTHORITY and custody steps are labelled fakes. */
function memorySteps(held: Held, drained: string[][] = []): ReviewApproveSteps {
  const io = memoryIo(held);
  const fail = unasked("non-page handler");
  const ports: ApprovedMutationPorts = { journal: io, page: io, writeOne: async (file, text) => { put(held, keyOf(file), text); }, notes: () => {}, handlers: { relation: fail, lifecycle: fail, artifact: fail } };
  const write: CompilePageWriteSteps = { plan: (input) => planPageMutationFrom(io, input), apply: (root, planned) => applyApprovedMutationsLockedFrom(ports, root, planned) };
  const tail = memoryTail(held, write, drained);
  const record = (id: string): string => `${CANDIDATES_DIR}/${id}.json`;
  return {
    readCandidate: async (_root, id) => JSON.parse(held.files.get(record(id))!) as ReviewCandidate, // FAKE: custody-aware re-read
    targetUnchanged: async () => true, // FAKE: these candidates carry no target precondition
    assertMutationAccess: async () => {}, // FAKE: custody authority
    checkPublication: async () => true, // FAKE: no citations to check
    applyTyped: unasked("applyTyped"),
    plan: (input) => planPageMutationFrom(io, input),
    applyPlanned: (root, planned) => applyApprovedMutationsLockedFrom(ports, root, planned),
    finalize: (root, approved) => finalizeReviewApprovalsWith(tail, root, approved),
    deleteCandidate: async (_root, id) => held.files.delete(record(id)), // FAKE: custody-aware deletion
  };
}

/** The bound side over a fresh seeded copy. */
function memorySide(drained: string[][] = []): Side & { held: Held } {
  const held = seededCopy();
  const steps = memorySteps(held, drained);
  return {
    held, displayRoot: MEM_ROOT,
    approve: (id) => approveUnderLockWith(steps, MEM_ROOT, id, {}),
    tree: async () => sortedTree(Object.fromEntries([...held.files].filter(([rel]) => shown(rel)))),
  };
}

type Settled = { name: string; settled: string; exitCode: number; statuses: string[]; tree: Record<string, string> };

describe("review approval's write half over one copied project, with the minting directory gone", () => {
  it("A1 runs after the minting directory was removed, on a copy holding the seed and the two staged records", () => {
    expectMintingDirectoryRemoved(minted.dir, PREFIX);
    seededCopy();
  });

  it("A2 refuses an invalid page and keeps its record, then writes, merges source state, resolves, indexes, drains and clears the valid one, as the disk did", async () => {
    const drained: string[][] = [];
    const outcomes = await runScenario(memorySide(drained), ids);
    expect(outcomes).toEqual(minted.onDisk);
    const [refused, approved] = outcomes.map((line) => JSON.parse(line) as Settled);
    expect([refused!.exitCode, refused!.statuses, approved!.exitCode, approved!.settled]).toEqual([
      1, [`! Candidate ${ids.bad} failed page validation; not approved.`], 0, "ok"]);
    expect([`${CANDIDATES_DIR}/${ids.bad}.json` in approved!.tree, `${CANDIDATES_DIR}/${ids.good}.json` in approved!.tree, `${C}/beta.md` in approved!.tree]).toEqual([true, false, true]);
    expect(JSON.parse(approved!.tree[STATE_FILE]!).sources["b.md"]).toEqual({ hash: "hb", concepts: ["beta"], compiledAt: NOW.toISOString() });
    expect([approved!.statuses.at(-1), drained]).toEqual([`✓ Candidate ${ids.good} cleared.`, [["concepts/beta"]]]);
  });
});

describe("approval's authority order and tail failure over recorded collaborators (memory only)", () => {
  const base = { id: "c1", title: "Beta", slug: "beta", summary: "S", sources: [], generatedAt: "t", reviewMode: "default", heldReasons: [], body: page("Beta", "Beta.") } as unknown as ReviewCandidate;
  /** Every collaborator recorded and agreeing, then `overrides` applied; the real write and tail do not run. */
  const recorded = (log: string[], candidate: ReviewCandidate, overrides: Partial<ReviewApproveSteps> = {}): ReviewApproveSteps => ({
    readCandidate: async () => { log.push("read"); return candidate; },
    targetUnchanged: async () => { log.push("target"); return true; },
    assertMutationAccess: async () => { log.push("access"); },
    checkPublication: async () => { log.push("publication"); return true; },
    applyTyped: async () => { log.push("typed"); return "wiki/x/beta.md"; },
    plan: async () => { log.push("plan"); return { planned: [{ kind: "page" }], decision: "allow", checks: [] } as never; },
    applyPlanned: async () => { log.push("apply"); },
    finalize: async () => { log.push("finalize"); },
    deleteCandidate: async () => { log.push("delete"); },
    ...overrides,
  });
  /** One approval: the calls made, the exit code, and the outcome. */
  const run = async (candidate: ReviewCandidate, overrides: (log: string[]) => Partial<ReviewApproveSteps> = () => ({})): Promise<unknown[]> => {
    const log: string[] = [];
    process.exitCode = 0;
    vi.spyOn(output, "status").mockImplementation(() => {});
    const settled = await approveUnderLockWith(recorded(log, candidate, overrides(log)), MEM_ROOT, "c1", {}).then(() => "ok", (error: Error) => error.message);
    const exitCode = process.exitCode ?? 0;
    process.exitCode = 0;
    return [log, exitCode, settled];
  };

  it("A3 stops at the first refusing authority — pin, target, store, publication, typed promotion — with exit 1, nothing written and nothing deleted", async () => {
    expect([
      await run({ ...base, reviewMode: "connector" } as ReviewCandidate),
      await run(base, (log) => ({ targetUnchanged: async () => { log.push("target"); return false; } })),
      await run(base, (log) => ({ assertMutationAccess: async () => { log.push("access"); throw new CandidateCustodyUnavailableError(); } })),
      await run(base, (log) => ({ checkPublication: async () => { log.push("publication"); return false; } })),
      await run({ ...base, targetEntityType: "paper" } as ReviewCandidate, (log) => ({ applyTyped: async () => { log.push("typed"); throw new CandidateProfileError("paper", "no-profile"); } })),
    ]).toEqual([
      [["read"], 1, "ok"], [["read", "target"], 1, "ok"], [["read", "target", "access"], 1, "ok"],
      [["read", "target", "access", "publication"], 0, "ok"], [["read", "target", "access", "publication", "typed"], 1, "ok"],
    ]);
  });

  it("A4 writes then finalizes then deletes; a failing tail propagates and leaves the candidate undeleted", async () => {
    expect([
      await run(base),
      await run(base, (log) => ({ finalize: async () => { log.push("finalize"); throw new Error("injected tail failure"); } })),
    ]).toEqual([
      [["read", "target", "access", "publication", "plan", "apply", "finalize", "delete"], 0, "ok"],
      [["read", "target", "access", "publication", "plan", "apply", "finalize"], 0, "injected tail failure"],
    ]);
  });
});

describe("the bound approval reaches no root collaborator for its writes", () => {
  /** The root collaborators the local steps call. */
  const spyAll = () => [
    vi.spyOn(targetPrecondition, "targetUnchangedSincePropose"), vi.spyOn(custody, "assertCandidateMutationAccess"),
    vi.spyOn(publication, "checkCandidatePublication"), vi.spyOn(planner, "planPageMutation"), vi.spyOn(executor, "applyApprovedMutationsLocked"),
    vi.spyOn(reviewFinalize, "finalizeReviewApprovals"), vi.spyOn(candidates, "deleteCandidate"), vi.spyOn(state, "readState"), vi.spyOn(state, "writeState"),
    vi.spyOn(resolver, "resolveAndApplyLinks"), vi.spyOn(repair, "repairAndApplyLinks"), vi.spyOn(indexgen, "generateIndex"), vi.spyOn(obsidian, "generateMOC"),
    vi.spyOn(embeddingsRefresh, "refreshEmbeddingsDrainingPending"),
  ];

  it("A5 makes no root call in the bound route, while the root command reaches every one", async () => {
    const spies = spyAll();
    await runScenario(memorySide(), ids);
    expect(spies.map((spy) => spy.mock.calls.length)).toEqual(spies.map(() => 0));
    const root = await tracker.create(PREFIX);
    await writeFiles(root, SEED);
    const id = (await writeCandidate(root, draft("beta", page("Beta", "Beta mentions Alpha.")))).id;
    vi.spyOn(output, "status").mockImplementation(() => {});
    await fromRoot(root, () => reviewApproveCommand(id));
    expect([spies.map((spy) => spy.mock.calls.length > 0), process.exitCode ?? 0]).toEqual([spies.map(() => true), 0]);
  });
});
