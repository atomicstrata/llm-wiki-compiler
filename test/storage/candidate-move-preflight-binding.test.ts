/**
 * @file test/storage/candidate-move-preflight-binding.test.ts
 * @description The candidate MOVE and the mutation-access PREFLIGHT, WHOLE:
 * `moveCandidateWithCustodyFrom` (capture before any mechanism call, the store
 * bound against the receipt, the archive created only for an archive move, the
 * parents bound and distinct, the confined paths, the guarded move and the
 * post-state observed with the source handle held, every fault inside the
 * `try` as `false`), `archiveCandidateFrom`, and
 * `assertCandidateMutationAccessFrom` (the namespace check, then pending or its
 * creation parent writable, then archive or its parent only when planned), over
 * store mechanisms held in memory. They exist only after the move and the
 * preflight were given mechanisms of their own, so this file has NO before-edit run.
 *
 * HOW IT IS BUILT. Four default projects are minted on real disk, once, seeded
 * by the real `writeFreshCandidate` with deterministic ids. Each project's OWN
 * disk ask snapshots the `.llmwiki` tree (files as exact bytes, and every
 * directory), then runs the real root-taking consumers; every refusal it asks
 * for is captured as a value, so none escapes the mint. The trees are copied and
 * the minting directories are removed before any case runs. The memory side
 * starts from the disk's own snapshot and its files are compared, byte for
 * byte, with the copied post-operation tree. Nothing is normalised: a move
 * keeps bytes.
 *
 * WHAT THE MECHANISMS DECIDE. Only physical facts: which directories exist and
 * their identities, whether a probe passes, a leaf's bytes and identity,
 * whether a move's source still matches its expected bytes and identity (the
 * guarded move's own check), the rename itself, and a non-recursive directory
 * create. The final answer, true or false or a refusal, is the domain's.
 * Identities are SYNTHETIC device and inode numbers, not a hosted guarantee.
 *
 * NOT SHOWN HERE, AND KEPT LOCAL TO THE DISK MECHANISMS: the open handle, links,
 * real parent drift between check and rename, cross-device renames, real access
 * refusals and the act-by-path race windows. Their regressions stay in the
 * incumbent custody, rejection, connector and namespace suites.
 */

import { writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import {
  assertCandidateMutationAccess, assertCandidateMutationAccessFrom, captureCandidateCustody, captureCandidateCustodyFrom,
  moveCandidateWithCustody, moveCandidateWithCustodyFrom, type CandidateStoreMoveReads,
} from "../../src/compiler/candidate-custody.js";
import { archiveCandidate, archiveCandidateFrom, writeFreshCandidate } from "../../src/compiler/candidates.js";
import { CANDIDATES_ARCHIVE_DIR, CANDIDATES_DIR, LLMWIKI_DIR } from "../../src/utils/constants.js";
import { archivedRel, capturedDirectoryOf, heldLeavesOf, MEM_PROJECT, memoryRelOf, memoryStateOf, pendingRel, snapshotTree, unaskedWriteLeaves, type Held, type Tree } from "./candidate-store-doubles.js";
import { mintCopied, type Note } from "./copied-project.js";
import { mintEachScenario } from "./scenario-mint.js";
import { expectMintingDirectoryRemoved } from "./minted-directory.js";

const PREFIX = "candidate-move-preflight-binding-";
const draft = (slug: string) => ({ title: slug, slug, summary: "", sources: [], body: `${slug} body` });
const settle = (run: Promise<unknown>): Promise<string> => run.then((value) => JSON.stringify(value), (error: Error) => error.name);

/** What the disk answered: the tree before, the outcome, and the malformed-request refusal with its getter count. */
interface OnDisk { before: Tree; outcome: string; malformed: string; getterCalls: number }

/** A move request whose `root` is an ACCESSOR: capture must refuse it without evaluating it. */
function getterRequest(counter: { calls: number }, receipt: unknown) {
  return { get root() { counter.calls += 1; return "/x"; }, fileId: "alpha-a", direction: "archive", receipt } as never;
}

/** One scenario: seeds, then the same operation by root on disk and over mechanisms in memory. */
interface Scenario {
  seeds: string[];
  disk: (root: string) => Promise<unknown>;
  memory: (reads: CandidateStoreMoveReads, held: Map<string, Held>) => Promise<unknown>;
}
const tamper = (held: Map<string, Held>) => held.set(pendingRel("alpha-a"), { bytes: Buffer.from("tampered"), ino: 900 });

/** Capture, then archive and (optionally) restore under the same receipt, on disk. */
async function roundTripOnDisk(root: string, restore: boolean, between?: () => Promise<void>): Promise<boolean[]> {
  const receipt = (await captureCandidateCustody(root, "alpha-a"))!.receipt;
  await between?.();
  const moves = [await moveCandidateWithCustody({ root, fileId: "alpha-a", direction: "archive", receipt })];
  if (restore) moves.push(await moveCandidateWithCustody({ root, fileId: "alpha-a", direction: "restore", receipt }));
  return moves;
}

/** The same in memory; `root` fills only the request's validated legacy field. */
async function roundTripInMemory(reads: CandidateStoreMoveReads, restore: boolean, between?: () => void): Promise<boolean[]> {
  const receipt = (await captureCandidateCustodyFrom(reads, "alpha-a"))!.receipt;
  between?.();
  const moves = [await moveCandidateWithCustodyFrom(reads, { root: MEM_PROJECT, fileId: "alpha-a", direction: "archive", receipt })];
  if (restore) moves.push(await moveCandidateWithCustodyFrom(reads, { root: MEM_PROJECT, fileId: "alpha-a", direction: "restore", receipt }));
  return moves;
}

const SCENARIOS = {
  archive: { seeds: ["alpha-a", "beta-u"],
    disk: async (root) => [await settle(assertCandidateMutationAccess(root, true)), await archiveCandidate(root, "alpha-a"), await archiveCandidate(root, "gone-x")],
    memory: async (reads) => [await settle(assertCandidateMutationAccessFrom(reads, true)), await archiveCandidateFrom(reads, MEM_PROJECT, "alpha-a"), await archiveCandidateFrom(reads, MEM_PROJECT, "gone-x")] },
  roundTrip: { seeds: ["alpha-a"], disk: (root) => roundTripOnDisk(root, true), memory: (reads) => roundTripInMemory(reads, true) },
  stale: { seeds: ["alpha-a"],
    disk: (root) => roundTripOnDisk(root, false, () => writeFile(path.join(root, pendingRel("alpha-a")), "tampered")),
    memory: (reads, held) => roundTripInMemory(reads, false, () => { tamper(held); }) },
  empty: { seeds: [], disk: (root) => settle(assertCandidateMutationAccess(root, false)), memory: (reads) => settle(assertCandidateMutationAccessFrom(reads, false)) },
} satisfies Record<string, Scenario>;
type Name = keyof typeof SCENARIOS;

const minted = mintEachScenario(Object.keys(SCENARIOS) as Name[], (tracker, name) => {
  const scenario: Scenario = SCENARIOS[name];
  return mintCopied<OnDisk>(tracker, PREFIX, async (root) => {
    for (const fileId of scenario.seeds) await writeFreshCandidate(root, draft(fileId.split("-")[0]!), { idForAttemptForTest: () => fileId });
  }, async (root) => {
    const before = await snapshotTree(root, "base64");
    const outcome = await settle(scenario.disk(root));
    const counter = { calls: 0 };
    const malformed = await settle(moveCandidateWithCustody(getterRequest(counter, {})));
    return { before, outcome, malformed, getterCalls: counter.calls };
  });
});

/** Faults: probe answers, a store that has drifted, and a guarded move that throws. */
interface Faults { writable?: boolean; drifted?: boolean; moveThrows?: boolean }

/** Store mechanisms over `held` and `dirs`; every call to `note`, every directory create and rename also to `effect`. */
function memoryStoreOf(held: Map<string, Held>, dirs: Set<string>, note: Note, effect: Note, faults: Faults = {}): CandidateStoreMoveReads {
  const identity = (relDir: string) => ({ dev: 1, ino: (relDir === CANDIDATES_DIR && faults.drifted ? 99 : [...dirs].sort().indexOf(relDir) + 1) });
  const unused = (name: string) => async (): Promise<never> => { throw new Error(`${name} is not part of the move or the preflight`); };
  return {
    captureDirectory: capturedDirectoryOf(dirs, identity, note),
    probeDirectory: async (binding, need) => { note(`probe ${need} ${memoryRelOf(binding.dir)}`); return need === "list" || faults.writable !== false; },
    directoryStillBound: async (binding) => !faults.drifted && binding.identity.ino === identity(memoryRelOf(binding.dir)).ino,
    ...heldLeavesOf(held, dirs, effect, { capped: false, moveThrows: faults.moveThrows }),
    recordDirectory: () => { throw new Error("the listing is not part of the move or the preflight"); },
    ...unaskedWriteLeaves(unused),
  };
}

/** Run one scenario in memory from the disk's own snapshot; returns the outcome, files after, and logs. */
async function inMemory(name: Name, faults: Faults = {}) {
  const before = minted[name]!.onDisk.before;
  const { held, dirs } = memoryStateOf(before, "base64");
  const calls: string[] = [];
  const effects: string[] = [];
  const reads = memoryStoreOf(held, dirs, (call) => calls.push(call), (call) => effects.push(call), faults);
  const scenario: Scenario = SCENARIOS[name];
  const outcome = await settle(scenario.memory(reads, held));
  return { outcome, files: Object.fromEntries([...held].map(([rel, leaf]) => [rel, leaf.bytes.toString("base64")])), calls, effects, reads };
}

/** The disk's copied post-operation `.llmwiki` files, exact bytes. */
function diskFiles(name: Name): Record<string, string> {
  const files = [...minted[name]!.copy.files].filter(([rel]) => rel.startsWith(`${LLMWIKI_DIR}/`));
  return Object.fromEntries(files.map(([rel, text]) => [rel, Buffer.from(text, "utf8").toString("base64")]));
}

describe("the candidate move and mutation-access preflight over copied default projects, with every minting directory gone", () => {
  it("M1 runs after every minting directory was removed", () => {
    for (const one of Object.values(minted)) expectMintingDirectoryRemoved(one!.dir, PREFIX);
  });

  it("M2 passes the preflight with the archive's parent fallback, archives with exact bytes and reports an absent id, as the disk did", async () => {
    const { outcome, files, calls, effects } = await inMemory("archive");
    expect([outcome, files]).toEqual([minted.archive!.onDisk.outcome, diskFiles("archive")]);
    expect(effects).toEqual([`ensure ${CANDIDATES_ARCHIVE_DIR}`, `move ${pendingRel("alpha-a")} -> ${archivedRel("alpha-a")}`]);
    expect(files[archivedRel("alpha-a")]).toBe(minted.archive!.onDisk.before.files[pendingRel("alpha-a")]);
    expect(calls.slice(0, 9)).toEqual([`dir ${CANDIDATES_DIR}`, `probe list ${CANDIDATES_DIR}`, `dir ${CANDIDATES_ARCHIVE_DIR}`,
      `dir ${CANDIDATES_DIR}`, `probe write ${CANDIDATES_DIR}`, `dir ${CANDIDATES_ARCHIVE_DIR}`, `dir ${CANDIDATES_DIR}`, `probe write ${CANDIDATES_DIR}`, `dir ${CANDIDATES_DIR}`]);
  });

  it("M3 archives and then restores under one receipt, leaving the bytes where they began, as the disk did", async () => {
    const { outcome, files, effects } = await inMemory("roundTrip");
    expect([outcome, files]).toEqual([minted.roundTrip!.onDisk.outcome, diskFiles("roundTrip")]);
    expect([outcome, effects]).toEqual(["[true,true]", [`ensure ${CANDIDATES_ARCHIVE_DIR}`,
      `move ${pendingRel("alpha-a")} -> ${archivedRel("alpha-a")}`, `move ${archivedRel("alpha-a")} -> ${pendingRel("alpha-a")}`]]);
  });

  it("M4 refuses a move whose source changed after capture, with no rename, as the disk did", async () => {
    const { outcome, files, effects } = await inMemory("stale");
    expect([outcome, files]).toEqual([minted.stale!.onDisk.outcome, diskFiles("stale")]);
    expect([outcome, effects]).toEqual(["[false]", [`ensure ${CANDIDATES_ARCHIVE_DIR}`]]);
  });

  it("M5 refuses the preflight when neither pending nor its parent exists, and when a probe fails", async () => {
    const { outcome } = await inMemory("empty");
    // The `empty` operations settle themselves, so the outer settle JSON-quotes the refusal name.
    const refused = JSON.stringify("CandidateCustodyUnavailableError");
    expect([outcome, minted.empty!.onDisk.outcome]).toEqual([refused, refused]);
    const { reads } = await inMemory("archive", { writable: false });
    expect(await settle(assertCandidateMutationAccessFrom(reads, false))).toBe("CandidateCustodyUnavailableError");
  });

  it("M6 maps a store that no longer re-proves and a failed rename to false, with no rename", async () => {
    for (const faults of [{ drifted: true }, { moveThrows: true }]) {
      const { reads, effects } = await inMemory("roundTrip", faults);
      const receipt = (await captureCandidateCustodyFrom(reads, "alpha-a"))!.receipt;
      expect(await moveCandidateWithCustodyFrom(reads, { root: MEM_PROJECT, fileId: "alpha-a", direction: "archive", receipt })).toBe(false);
      expect(effects.filter((effect) => effect.startsWith("move"))).toEqual([]);
    }
  });

  it("M7 rejects a malformed request before any mechanism call and without evaluating its root, as the disk did", async () => {
    const calls: string[] = [];
    const counter = { calls: 0 };
    const reads = memoryStoreOf(new Map(), new Set(), (call) => calls.push(call), () => {});
    const malformed = await settle(moveCandidateWithCustodyFrom(reads, getterRequest(counter, {})));
    expect([malformed, counter.calls, calls]).toEqual(["CandidateCustodyBoundaryError", 0, []]);
    expect([minted.archive!.onDisk.malformed, minted.archive!.onDisk.getterCalls]).toEqual(["CandidateCustodyBoundaryError", 0]);
  });
});
