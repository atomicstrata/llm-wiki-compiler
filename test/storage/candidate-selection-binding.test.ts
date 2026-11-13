/**
 * @file test/storage/candidate-selection-binding.test.ts
 * @description The strict whole-store candidate selection, WHOLE:
 * `selectCandidateEntriesForMutationWithTotalFrom` (the absence check then the
 * literal store binding, the capped enumeration with its store re-proofs, the
 * sequential strict reads with every record charged to the byte budget before
 * the selector runs, the selection cap before materialization, the generation
 * then UTF-8 order, the whole-batch identity checks, the frozen result and the
 * final store re-proof) over custody-read and scan mechanisms held in memory.
 * They exist only after the strict scan was given mechanisms of its own, so
 * this file has NO before-edit run.
 *
 * HOW IT IS BUILT. Two default projects are minted on real disk, once: one with
 * three candidates written by the real `writeCandidate`, and one that also holds
 * a record whose embedded id differs from its filename. The real root-taking
 * selection answers on disk: the first project gives the positive selection,
 * the cap and the budget; the second is asked ONLY for a whole-store selection,
 * whose identity refusal is captured as a value (every refusal the setup asks
 * for is awaited inside `nameOf`, so none escapes the mint). The trees are
 * copied and the minting directories are removed before any case runs.
 *
 * WHAT THE MECHANISMS DECIDE. Only what a store can: whether a directory is
 * bound and its identity, where a leaf is, a leaf's bytes and identity under the
 * byte cap, and which entries a bound directory streams, in an order that is
 * deliberately NOT sorted, under the caller's caps, recheck and hooks. Identities
 * are SYNTHETIC device and inode numbers standing in for the local physical
 * contract, not a cross-backend identity. Every mechanism call is logged.
 *
 * NOT SHOWN HERE, AND KEPT LOCAL TO THE DISK MECHANISMS: literal-versus-alias
 * directory classification, links and the no-follow open, handle and path
 * re-proofs, real directory drift during a stream, and the real entry caps.
 * Their regressions stay in `candidate-store-binding-final8.test.ts`,
 * `candidate-scan-cap-final9.test.ts` and the namespace suites.
 */

import path from "node:path";
import { describe, expect, it } from "bun:test";
import { CandidateCustodyUnavailableError, type CandidateStoreScanReads } from "../../src/compiler/candidate-custody.js";
import { writeCandidate } from "../../src/compiler/candidates.js";
import {
  CandidateIdentityMismatchError, CandidateMutationScanCapacityError, selectCandidateEntriesForMutationWithTotal,
  selectCandidateEntriesForMutationWithTotalFrom, type CandidateMutationSelection, type CandidateMutationSelector,
} from "../../src/compiler/candidate-selection.js";
import { CANDIDATES_DIR } from "../../src/utils/constants.js";
import { tempRootTracker } from "../temp-roots.js";
import { mintCopied, mintOnceThenRemove, writeFiles, type Minted, type Note } from "./copied-project.js";
import { expectMintingDirectoryRemoved } from "./minted-directory.js";

const PREFIX = "candidate-selection-binding-";
const MEM_PROJECT = "/memory/project";
const pending = (id: string): string => `${CANDIDATES_DIR}/${id}.json`;
const draft = (slug: string) => ({ title: slug, slug, summary: "", sources: [], body: `${slug} body` });
const notBeta: CandidateMutationSelector = (candidate) => candidate.slug !== "beta";
const everything: CandidateMutationSelector = () => true;
const capOne = { maxSelected: 1, overflowError: () => new RangeError("selection cap") };

/** A selection without its physical identities. */
const summaryOf = (selection: CandidateMutationSelection) =>
  ({ totalPending: selection.totalPending, entries: selection.entries.map((entry) => [entry.fileId, entry.custodyReceipt.sha256]) });
const nameOf = (run: Promise<unknown>): Promise<string> => run.then(() => "resolved", (error: Error) => error.name);

/** What the disk answered for the matching store. */
interface OnDisk { selected: ReturnType<typeof summaryOf>; refusals: Record<string, string> }

/** The real strict selection on the matching store: a filtered selection, the cap, and the byte budget that charges unselected records. */
async function askedOnDisk(root: string): Promise<OnDisk> {
  return {
    selected: summaryOf(await selectCandidateEntriesForMutationWithTotal(root, notBeta)),
    refusals: {
      cap: await nameOf(selectCandidateEntriesForMutationWithTotal(root, everything, capOne)),
      budget: await nameOf(selectCandidateEntriesForMutationWithTotal(root, () => false, undefined, { maxMutationBytesForTest: 1 })),
    },
  };
}

/** The real strict selection on the mismatched store, asked only for the whole store: its identity refusal, as a value. */
async function askedMismatchOnDisk(root: string): Promise<{ mismatch: string }> {
  return { mismatch: await nameOf(selectCandidateEntriesForMutationWithTotal(root, everything)) };
}

const tracker = tempRootTracker();
let store: Minted<OnDisk>;
let mismatched: Minted<{ mismatch: string }>;

/** Three candidates, written in order by the real writer. */
async function seedThree(root: string): Promise<void> {
  for (const [slug, id] of [["alpha", "a-1"], ["beta", "b-2"], ["gamma", "c-3"]] as const) {
    await writeCandidate(root, draft(slug), { idForAttemptForTest: () => id });
  }
}

mintOnceThenRemove(tracker, async () => {
  store = await mintCopied(tracker, PREFIX, seedThree, askedOnDisk);
  mismatched = await mintCopied(tracker, PREFIX, async (root) => {
    await seedThree(root);
    await writeFiles(root, { [pending("d-4")]: JSON.stringify({ id: "other", title: "d", slug: "delta", body: "d", sources: [] }) });
  }, askedMismatchOnDisk);
});

/** Scan mechanisms over one copied project; `drift` rebinds the pending store once it is set. */
function memoryScanOf(minted: Minted<unknown>, note: Note, drift: { now: boolean } = { now: false }): CandidateStoreScanReads {
  const files = [...minted.copy.files].filter(([rel]) => rel.startsWith(`${CANDIDATES_DIR}/`));
  const located = (relDir: string) => ({ dir: `${MEM_PROJECT}/${relDir}`, realDir: `${MEM_PROJECT}/${relDir}` });
  return {
    captureDirectory: async (relDir, requireLiteral) => {
      note(`dir${requireLiteral === true ? " literal" : ""}`);
      return files.length === 0 ? null : { ...located(relDir), identity: { dev: 1, ino: drift.now ? 99 : 1 } };
    },
    leafPath: async (fileId) => path.posix.join(MEM_PROJECT, pending(fileId)),
    readLeaf: async (request) => {
      const text = minted.copy.files.get(path.posix.relative(MEM_PROJECT, request.leaf));
      note("read");
      if (text === undefined) return { kind: "absent" };
      const bytes = Buffer.from(text, "utf8");
      return bytes.byteLength > request.maxBytes ? { kind: "unavailable" } : { kind: "ok", bytes, fileIdentity: { dev: 1, ino: bytes.byteLength } };
    },
    enumerate: async (_binding, scan) => {
      await scan.beforeOpen?.(); await scan.recheck(); note("open"); await scan.afterOpen?.(); await scan.recheck();
      const names = files.map(([rel]) => path.posix.basename(rel)).reverse();
      if (names.length > scan.maxDirectEntries || names.length > scan.maxNames) throw scan.overflow();
      await scan.recheck();
      return names.filter((name) => name.endsWith(scan.suffix)).map((name) => name.slice(0, -scan.suffix.length));
    },
  };
}

describe("the strict candidate selection over copied stores, with every minting directory gone", () => {
  it("S1 runs after both minting directories were removed", () => {
    for (const one of [store, mismatched]) expectMintingDirectoryRemoved(one.dir, PREFIX);
  });

  it("S2 selects, counts and orders exactly as the disk did, binding literally and re-proving the store last", async () => {
    const log: string[] = [];
    const selection = await selectCandidateEntriesForMutationWithTotalFrom(memoryScanOf(store, (call) => log.push(call)), notBeta);
    expect(summaryOf(selection)).toEqual(store.onDisk.selected);
    expect([selection.totalPending, selection.entries.map((entry) => entry.fileId)]).toEqual([3, ["a-1", "c-3"]]);
    expect([Object.isFrozen(selection), Object.isFrozen(selection.entries)]).toEqual([true, true]);
    expect([log.slice(0, 3), log.at(-1), log.filter((call) => call === "read").length]).toEqual([["dir", "dir literal", "dir"], "dir", 3]);
  });

  it("S3 refuses the selection cap, the byte budget (charged before the selector) and a selected filename mismatch as the disk did", async () => {
    const reads = memoryScanOf(store, () => {});
    const refusals = {
      cap: await nameOf(selectCandidateEntriesForMutationWithTotalFrom(reads, everything, capOne)),
      budget: await nameOf(selectCandidateEntriesForMutationWithTotalFrom(reads, () => false, undefined, { maxMutationBytesForTest: 1 })),
      mismatch: await nameOf(selectCandidateEntriesForMutationWithTotalFrom(memoryScanOf(mismatched, () => {}), everything)),
    };
    expect(refusals).toEqual({ ...store.onDisk.refusals, mismatch: mismatched.onDisk.mismatch });
    expect([refusals.cap, refusals.budget, refusals.mismatch]).toEqual(["RangeError", CandidateMutationScanCapacityError.name, CandidateIdentityMismatchError.name]);
  });

  it("S4 leaves an unselected mismatched record alone, and finds nothing when the store is absent", async () => {
    const selection = await selectCandidateEntriesForMutationWithTotalFrom(memoryScanOf(mismatched, () => {}), (candidate) => candidate.slug === "alpha");
    expect([selection.totalPending, selection.entries.map((entry) => entry.fileId)]).toEqual([4, ["a-1"]]);
    const empty = { ...mismatched, copy: { files: new Map<string, string>(), listings: new Map() } };
    expect(summaryOf(await selectCandidateEntriesForMutationWithTotalFrom(memoryScanOf(empty, () => {}), everything))).toEqual({ totalPending: 0, entries: [] });
  });

  it("S5 refuses a result whose store drifted before the final re-proof", async () => {
    const drift = { now: false };
    const run = selectCandidateEntriesForMutationWithTotalFrom(memoryScanOf(store, () => {}, drift), everything, undefined, {
      beforeReturnForTest: async () => { drift.now = true; },
    });
    await expect(run).rejects.toBeInstanceOf(CandidateCustodyUnavailableError);
  });
});
