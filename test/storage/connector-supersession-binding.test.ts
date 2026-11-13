/**
 * @file test/storage/connector-supersession-binding.test.ts
 * @description The connector candidate SUPERSESSION consumers, WHOLE:
 * `selectConnectorCandidateEntriesFrom` (the strict key selection and its cap),
 * `selectConnectorCandidateEntriesForRunFrom` (the namespace check, the
 * tolerant key selection, the access preflight, the tolerant count, and the
 * fixed unavailable mapping), `archiveCandidatesWithUndoFrom` and
 * `restoreArchivedCandidatesFrom` (dense exact receipts, the archive
 * preflight, ordered moves each observed after, compensation of EVERY receipt,
 * and the ordered recovery-required result), over store mechanisms held in
 * memory. They exist only after the consumers were given bodies of their own,
 * so this file has NO before-edit run.
 *
 * HOW IT IS BUILT. Six default projects are minted on real disk, once, with the
 * incumbent connector fixtures. Each project's OWN disk ask snapshots the
 * `.llmwiki` tree, then runs its scenario's STEPS through the real root forms.
 * Each step is settled EXACTLY ONCE by the ask, and only there (a value becomes
 * its JSON without file or store identities; a refusal becomes its error
 * name), so no step can escape the mint and no outcome is quoted twice. The
 * trees are copied and the minting directories are removed before any case
 * runs. The memory side runs the same steps through the bound bodies, from the
 * disk's own snapshot, and its files are compared with the copied
 * post-operation tree, byte for byte as UTF-8 text.
 *
 * THE MOVER. A scripted {@link CandidateMovePort} logs each request (direction,
 * file id, and whether its `root` is the legacy root the step was given), may
 * refuse or throw, and otherwise delegates to the default guarded move: the
 * root form on disk, the bound form over the same mechanisms in memory. The
 * memory side passes a project root that no mechanism ever reads.
 *
 * WHAT THE MECHANISMS DECIDE. Only physical facts: which directories exist and
 * their identities, a leaf's bytes and identity, the stream of names, whether a
 * move's source still matches its expectation, the rename, and a non-recursive
 * directory create. Identities are SYNTHETIC device and inode numbers.
 *
 * NOT SHOWN HERE, AND KEPT LOCAL TO THE DISK MECHANISMS: the open handle, links,
 * real access refusals, parent drift, cross-device renames and the act-by-path
 * race windows. Their regressions stay in the incumbent connector suites. The
 * connector RUN and the review commands above these consumers are not run here.
 */

import { writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import {
  moveCandidateWithCustody, moveCandidateWithCustodyFrom,
  type CandidateCustodyMoveRequest, type CandidateCustodyReceipt, type CandidateStoreMoveReads, type CandidateStoreScanReads,
} from "../../src/compiler/candidate-custody.js";
import type { CandidateFileEntry } from "../../src/compiler/candidate-read.js";
import {
  archiveCandidatesWithUndo, archiveCandidatesWithUndoFrom, restoreArchivedCandidates, restoreArchivedCandidatesFrom,
  selectConnectorCandidateEntries, selectConnectorCandidateEntriesForRun, selectConnectorCandidateEntriesForRunFrom,
  selectConnectorCandidateEntriesFrom, type CandidateMovePort,
} from "../../src/connectors/candidate-supersession.js";
import type { LocalEntry } from "../../src/storage/legacy-local-reads.js";
import type { LegacyLocalRecordDirs } from "../../src/storage/legacy-local-record-dirs.js";
import { CANDIDATES_ARCHIVE_DIR, CANDIDATES_DIR, LLMWIKI_DIR } from "../../src/utils/constants.js";
import { connectorCandidateRecord, FIXTURE_IDEMPOTENCY_KEY, plantConnectorCandidate } from "../connectors/final6-fixtures.js";
import { archivedRel, capturedDirectoryOf, heldLeavesOf, MEM_PROJECT, memoryRelOf, memoryStateOf, pendingRel, sequentialIdentity, snapshotTree, unaskedWriteLeaves, type Held, type Tree } from "./candidate-store-doubles.js";
import { enoent, mintCopied, writeFiles, type Note } from "./copied-project.js";
import { mintEachScenario } from "./scenario-mint.js";
import { expectMintingDirectoryRemoved } from "./minted-directory.js";

const PREFIX = "connector-supersession-binding-";
const OTHER_KEY = "b".repeat(64);
const withoutIdentities = (key: string, value: unknown): unknown => (key === "fileIdentity" || key === "storeIdentity" ? undefined : value);
/** THE ONE SETTLEMENT: a value as JSON without synthetic or physical identities, a refusal as its error name. */
const settle = (run: Promise<unknown>): Promise<string> =>
  run.then((value) => JSON.stringify(value, withoutIdentities), (error: Error) => error.name);

/** The consumers, by root on disk or bound in memory, plus the two physical facts a scenario needs. */
interface Api {
  root: string;
  strict(key: string): Promise<CandidateFileEntry[]>;
  run(key: string): Promise<unknown>;
  archive(entries: unknown, mover?: CandidateMovePort): Promise<unknown>;
  restore(receipts: unknown, mover?: CandidateMovePort): Promise<unknown>;
  defaultMove(request: CandidateCustodyMoveRequest): Promise<boolean>;
  tamper(fileId: string): Promise<void>;
}
/** State one scenario's steps share: the entries a step selected. */
interface Shared { entries: CandidateFileEntry[] }
type Step = (api: Api, shared: Shared, moves: string[]) => Promise<unknown>;
interface OnDisk { before: Tree; outcomes: string[]; moves: string[] }

/** A mover that logs each request, refuses an archive of `refuse`, throws on a restore of `fail`, else delegates. */
function scriptedMover(api: Api, moves: string[], faults: { refuse?: string; fail?: string } = {}): CandidateMovePort {
  return { async move(request) {
    moves.push(`${request.direction} ${request.fileId} ${request.root === api.root ? "legacy-root" : "OTHER-ROOT"}`);
    if (request.direction === "archive" && request.fileId === faults.refuse) return false;
    if (request.direction === "restore" && request.fileId === faults.fail) throw new Error("injected restore failure");
    return api.defaultMove(request);
  } };
}

const select: Step = async (api, shared) => { shared.entries = await api.strict(FIXTURE_IDEMPOTENCY_KEY); return shared.entries; };
const receiptsOf = (shared: Shared): CandidateCustodyReceipt[] => shared.entries.map((entry) => entry.custodyReceipt);
const plant = (ids: string[]) => async (root: string) => {
  for (const [at, fileId] of ids.entries()) await plantConnectorCandidate(root, fileId, { generatedAt: `2026-01-0${9 - at}T00:00:00.000Z` });
};

const SCENARIOS = {
  select: { seed: async (root: string) => { await plant(["k-1", "k-2"])(root); await plantConnectorCandidate(root, "o-3", { idempotencyKey: OTHER_KEY }); },
    steps: [select, (api) => api.run(FIXTURE_IDEMPOTENCY_KEY), (api) => api.strict("c".repeat(64)),
      (api) => api.archive("not-a-batch"), (api) => api.restore([{ fileId: "k-1" }])] as Step[] },
  mismatch: { seed: async (root: string) => { await plant(["k-1"])(root); await writeFiles(root, { [pendingRel("mis-2")]: JSON.stringify(connectorCandidateRecord("other")) }); },
    steps: [(api) => api.strict(FIXTURE_IDEMPOTENCY_KEY), (api) => api.run(FIXTURE_IDEMPOTENCY_KEY)] as Step[] },
  archive: { seed: plant(["k-1", "k-2"]), steps: [select, (api, shared) => api.archive(shared.entries)] as Step[] },
  roundTrip: { seed: plant(["k-1", "k-2"]),
    steps: [select, (api, shared) => api.archive(shared.entries), (api, shared) => api.restore(receiptsOf(shared))] as Step[] },
  compensate: { seed: plant(["k-1", "k-2", "k-3"]),
    steps: [select, (api, shared, moves) => api.archive(shared.entries, scriptedMover(api, moves, { refuse: "k-2", fail: "k-3" }))] as Step[] },
  stale: { seed: plant(["k-1", "k-2"]),
    steps: [select, async (api) => { await api.tamper("k-1"); return "tampered"; }, (api, shared, moves) => api.archive(shared.entries, scriptedMover(api, moves))] as Step[] },
};
type Name = keyof typeof SCENARIOS;

/** Run a scenario's steps in order, settling each exactly once. */
async function runSteps(name: Name, api: Api): Promise<{ outcomes: string[]; moves: string[] }> {
  const shared: Shared = { entries: [] };
  const moves: string[] = [];
  const outcomes: string[] = [];
  for (const step of SCENARIOS[name].steps) outcomes.push(await settle(step(api, shared, moves)));
  return { outcomes, moves };
}

/** The real root forms over the project at `root`. */
function diskApi(root: string): Api {
  return {
    root, strict: (key) => selectConnectorCandidateEntries(root, key), run: (key) => selectConnectorCandidateEntriesForRun(root, key),
    archive: (entries, mover) => archiveCandidatesWithUndo(root, entries as CandidateFileEntry[], mover),
    restore: (receipts, mover) => restoreArchivedCandidates(root, receipts as CandidateCustodyReceipt[], mover),
    defaultMove: (request) => moveCandidateWithCustody(request), tamper: (fileId) => writeFile(path.join(root, pendingRel(fileId)), "tampered"),
  };
}

const minted = mintEachScenario(Object.keys(SCENARIOS) as Name[], (tracker, name) =>
  mintCopied<OnDisk>(tracker, PREFIX, SCENARIOS[name].seed, async (root) => {
    const before = await snapshotTree(root, "utf8");
    return { before, ...(await runSteps(name, diskApi(root))) };
  }));


/** Direct entries of `relDir`: held files and directories, as the record listing reports them. */
function entriesOf(held: Map<string, Held>, dirs: Set<string>, relDir: string): LocalEntry[] {
  const files = [...held.keys()].filter((rel) => path.posix.dirname(rel) === relDir).map((rel) => ({ name: path.posix.basename(rel), kind: "file" as const }));
  const subdirs = [...dirs].filter((rel) => path.posix.dirname(rel) === relDir).map((rel) => ({ name: path.posix.basename(rel), kind: "directory" as const }));
  return [...files, ...subdirs];
}

/** Store mechanisms over `held` and `dirs`; every directory create and rename is also recorded to `effect`. */
function memoryStoreOf(held: Map<string, Held>, dirs: Set<string>, effect: Note): CandidateStoreScanReads & CandidateStoreMoveReads {
  const unused = (member: string) => async (): Promise<never> => { throw new Error(`${member} is not part of supersession`); };
  return {
    captureDirectory: capturedDirectoryOf(dirs, sequentialIdentity()),
    probeDirectory: async () => true,
    directoryStillBound: async (binding) => dirs.has(memoryRelOf(binding.dir)),
    ...heldLeavesOf(held, dirs, effect, { capped: true }),
    enumerate: async (_binding, scan) => {
      await scan.beforeOpen?.(); await scan.recheck(); await scan.afterOpen?.(); await scan.recheck();
      const names = entriesOf(held, dirs, CANDIDATES_DIR).map((entry) => entry.name);
      if (names.length > scan.maxDirectEntries) throw scan.overflow();
      await scan.recheck();
      return names.filter((name) => name.endsWith(scan.suffix)).map((name) => name.slice(0, -scan.suffix.length));
    },
    recordDirectory: (realDir) => ({ exists: async () => dirs.has(memoryRelOf(realDir)), listEntries: async () => entriesOf(held, dirs, memoryRelOf(realDir)) }),
    ...unaskedWriteLeaves(unused),
  };
}

/** The tolerant record directories over `held` and `dirs`, for the pending count. */
function memoryRecordsOf(held: Map<string, Held>, dirs: Set<string>): LegacyLocalRecordDirs {
  return {
    directory: async (relDir) => (dirs.has(relDir) ? { exists: async () => dirs.has(relDir), listEntries: async () => entriesOf(held, dirs, relDir) } : null),
    leaf: async (relDir, fileName) => ({ location: `memory:${relDir}/${fileName}`, readText: async () => {
      const leaf = held.get(`${relDir}/${fileName}`);
      if (leaf === undefined) throw enoent();
      return leaf.bytes.toString("utf8");
    } }),
  };
}

/** The bound bodies over the memory mechanisms; `MEM_PROJECT` fills only the move requests' legacy field. */
function memoryApi(reads: CandidateStoreScanReads & CandidateStoreMoveReads, records: LegacyLocalRecordDirs, held: Map<string, Held>): Api {
  return {
    root: MEM_PROJECT, strict: (key) => selectConnectorCandidateEntriesFrom(reads, key),
    run: (key) => selectConnectorCandidateEntriesForRunFrom({ store: reads, records }, key),
    archive: (entries, mover) => archiveCandidatesWithUndoFrom(reads, MEM_PROJECT, entries as CandidateFileEntry[], mover),
    restore: (receipts, mover) => restoreArchivedCandidatesFrom(reads, MEM_PROJECT, receipts as CandidateCustodyReceipt[], mover),
    defaultMove: (request) => moveCandidateWithCustodyFrom(reads, request),
    tamper: async (fileId) => { held.set(pendingRel(fileId), { bytes: Buffer.from("tampered"), ino: 900 }); },
  };
}

/** Run one scenario in memory from the disk's own snapshot; returns outcomes, mover log, files and directories after, and effects. */
async function inMemory(name: Name) {
  const before = minted[name]!.onDisk.before;
  const { held, dirs } = memoryStateOf(before, "utf8");
  const effects: string[] = [];
  const reads = memoryStoreOf(held, dirs, (call) => effects.push(call));
  const { outcomes, moves } = await runSteps(name, memoryApi(reads, memoryRecordsOf(held, dirs), held));
  const files = Object.fromEntries([...held].map(([rel, leaf]) => [rel, leaf.bytes.toString("utf8")]).sort());
  return { outcomes, moves, files, dirs: [...dirs].sort(), effects };
}

/** The disk's copied post-operation `.llmwiki` files and directories. */
function diskAfter(name: Name): { files: Record<string, string>; dirs: string[] } {
  const copy = minted[name]!.copy;
  const under = (rel: string): boolean => rel === LLMWIKI_DIR || rel.startsWith(`${LLMWIKI_DIR}/`);
  return { files: Object.fromEntries([...copy.files].filter(([rel]) => under(rel)).sort()), dirs: [...copy.listings.keys()].filter(under).sort() };
}

/** Run `name` in memory and require the disk's outcomes, mover log, files and directories. */
async function expectDiskParity(name: Name) {
  const run = await inMemory(name);
  const onDisk = minted[name]!.onDisk;
  expect([run.outcomes, run.moves]).toEqual([onDisk.outcomes, onDisk.moves]);
  expect({ files: run.files, dirs: run.dirs }).toEqual(diskAfter(name));
  return run;
}

const kindsOf = (outcome: string): unknown => JSON.parse(outcome).kind;
const idsOf = (outcome: string): unknown => (JSON.parse(outcome) as CandidateFileEntry[]).map((entry) => entry.fileId);

describe("the connector supersession consumers over copied default projects, with every minting directory gone", () => {
  it("C1 runs after every minting directory was removed", () => {
    for (const one of Object.values(minted)) expectMintingDirectoryRemoved(one!.dir, PREFIX);
  });

  it("C2 selects by key strictly and for the run, counts, and refuses malformed batches before any mechanism, as the disk did", async () => {
    const { outcomes } = await expectDiskParity("select");
    const run = JSON.parse(outcomes[1]!) as { entries: CandidateFileEntry[]; totalPending: number };
    expect([idsOf(outcomes[0]!), run.entries.map((entry) => entry.fileId), run.totalPending, outcomes[2]]).toEqual([["k-2", "k-1"], ["k-2", "k-1"], 3, "[]"]);
    expect(outcomes.slice(3)).toEqual(["CandidateCustodyBoundaryError", "CandidateCustodyBoundaryError"]);
    const touched: string[] = [];
    const counted = new Proxy(memoryStoreOf(new Map(), new Set(), () => {}), { get: (target, member) => { touched.push(String(member)); return Reflect.get(target, member); } });
    expect(await settle(archiveCandidatesWithUndoFrom(counted, MEM_PROJECT, "not-a-batch" as never))).toBe("CandidateCustodyBoundaryError");
    expect(await settle(restoreArchivedCandidatesFrom(counted, MEM_PROJECT, [{ fileId: "k-1" }] as never))).toBe("CandidateCustodyBoundaryError");
    expect(touched).toEqual([]);
  });

  it("C3 maps an identity mismatch to the run's fixed unavailable result, while the strict selection refuses typed, as the disk did", async () => {
    const { outcomes } = await expectDiskParity("mismatch");
    expect(outcomes).toEqual(["CandidateIdentityMismatchError", JSON.stringify({ kind: "unavailable", reason: "connector candidate store unavailable" })]);
  });

  it("C4 archives every selected receipt in order with exact bytes, as the disk did", async () => {
    const { outcomes, effects, files } = await expectDiskParity("archive");
    expect([kindsOf(outcomes[1]!), effects]).toEqual(["archived",
      [`ensure ${CANDIDATES_ARCHIVE_DIR}`, `move ${pendingRel("k-2")} -> ${archivedRel("k-2")}`, `move ${pendingRel("k-1")} -> ${archivedRel("k-1")}`]]);
    expect(files[archivedRel("k-1")]).toBe(minted.archive!.onDisk.before.files[pendingRel("k-1")]);
  });

  it("C5 restores every archived receipt with the default mover, leaving the tree where it began, as the disk did", async () => {
    const { outcomes, effects, files } = await expectDiskParity("roundTrip");
    expect([kindsOf(outcomes[1]!), kindsOf(outcomes[2]!), files]).toEqual(["archived", "failed-and-restored", minted.roundTrip!.onDisk.before.files]);
    expect(effects.slice(3)).toEqual([`move ${archivedRel("k-2")} -> ${pendingRel("k-2")}`, `move ${archivedRel("k-1")} -> ${pendingRel("k-1")}`]);
  });

  it("C6 compensates EVERY receipt after a refused archive, reporting the one whose restore threw, as the disk did", async () => {
    const { outcomes, moves, files } = await expectDiskParity("compensate");
    // Selection order is generation time: k-3, k-2, k-1. k-3 archives, k-2 is refused, then EVERY receipt is compensated:
    // k-3's restore throws and it stays archived; k-2 and k-1 still observe restored without a move.
    expect(JSON.parse(outcomes[1]!)).toEqual({ kind: "recovery-required", candidateIds: ["k-3"] });
    expect(moves).toEqual(["archive k-3 legacy-root", "archive k-2 legacy-root", "restore k-3 legacy-root"]);
    expect(Object.keys(files).sort()).toEqual([archivedRel("k-3"), pendingRel("k-1"), pendingRel("k-2")].sort());
  });

  it("C7 refuses a batch whose receipt went stale before any move, compensating every receipt, as the disk did", async () => {
    const { outcomes, moves, effects } = await expectDiskParity("stale");
    expect([JSON.parse(outcomes[2]!), moves, effects]).toEqual([{ kind: "recovery-required", candidateIds: ["k-1"] }, [], []]);
  });
});
