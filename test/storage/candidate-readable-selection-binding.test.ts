/**
 * @file test/storage/candidate-readable-selection-binding.test.ts
 * @description The LIVE tolerant candidate discovery and selection, WHOLE:
 * `listCandidateFileEntriesFrom` (the alias-tolerant absence check, the direct
 * `.json` file listing, the public-policy reads, which faults skip a leaf and
 * which propagate, and the generation-then-UTF-8 order) and
 * `selectReadableCandidateEntriesForMutationFrom` (the alias-tolerant binding,
 * the hooks, the selector over the whole listing before the cap, the
 * selected-batch identity checks and the final store re-proof), over
 * mechanisms held in memory. They exist only after the tolerant path was given
 * mechanisms of its own, so this file has NO before-edit run.
 *
 * HOW IT IS BUILT. Two default projects are minted on real disk, once. Both
 * hold three candidates written by the real `writeCandidate`, a malformed leaf,
 * an archived leaf (nested, never listed), a DIRECTORY named `dir.json` (a
 * non-file entry, never listed) and a record whose embedded id differs from
 * its filename. The `tolerant` project also holds a leaf whose filename is an
 * unsafe id. Each project has its OWN disk ask, and every refusal the setup
 * asks for is awaited inside `nameOf`, so none escapes the mint. The trees are
 * copied and the minting directories are removed before any case runs.
 *
 * WHAT THE MECHANISMS DECIDE. Only what a store can: whether a directory is
 * bound and its identity, its DIRECT entries with their kinds (straight from the
 * copied listing), where a leaf is, and a leaf's bytes and identity. Identities
 * are SYNTHETIC device and inode numbers standing in for the local physical
 * contract, not a hosted guarantee. Every mechanism call and hook is logged.
 *
 * NOT SHOWN HERE, AND KEPT LOCAL TO THE DISK MECHANISMS: alias resolution,
 * links and the no-follow open, handle and path re-proofs, real drift, and the
 * skip note's console output (not asserted). Their regressions stay in the
 * incumbent candidate, connector and namespace suites.
 */

import path from "node:path";
import { describe, expect, it } from "bun:test";
import { CandidateCustodyUnavailableError, CandidateLeafUnavailableError, type CandidateStoreListReads } from "../../src/compiler/candidate-custody.js";
import { listCandidateFileEntries, listCandidateFileEntriesFrom, type CandidateFileEntry } from "../../src/compiler/candidate-read.js";
import {
  selectReadableCandidateEntriesForMutation, selectReadableCandidateEntriesForMutationFrom, type CandidateMutationSelector,
} from "../../src/compiler/candidate-selection.js";
import { writeCandidate } from "../../src/compiler/candidates.js";
import { CANDIDATES_DIR } from "../../src/utils/constants.js";
import { tempRootTracker } from "../temp-roots.js";
import { mintCopied, mintOnceThenRemove, writeFiles, type Minted, type Note } from "./copied-project.js";
import { expectMintingDirectoryRemoved } from "./minted-directory.js";

const PREFIX = "candidate-readable-selection-binding-";
const MEM_PROJECT = "/memory/project";
const leaf = (name: string): string => `${CANDIDATES_DIR}/${name}`;
const draft = (slug: string) => ({ title: slug, slug, summary: "", sources: [], body: `${slug} body` });
const valid: CandidateMutationSelector = (candidate) => candidate.slug !== "beta" && candidate.slug !== "mu";
const everything: CandidateMutationSelector = () => true;
const capOne = { maxSelected: 1, overflowError: () => new RangeError("selection cap") };

/** A listing or selection without physical identities. */
const idsOf = (entries: readonly CandidateFileEntry[]) => entries.map((entry) => [entry.fileId, entry.custodyReceipt.sha256]);
const nameOf = (run: Promise<unknown>): Promise<string> => run.then(() => "resolved", (error: Error) => error.name);

/** The shared seed: three written candidates, a malformed leaf, an archived leaf, a non-file `.json` entry, a mismatched record. */
async function seedStore(root: string): Promise<void> {
  for (const [slug, id] of [["alpha", "a-1"], ["beta", "b-2"], ["gamma", "c-3"]] as const) {
    await writeCandidate(root, draft(slug), { idForAttemptForTest: () => id });
  }
  await writeFiles(root, {
    [leaf("bad.json")]: "{",
    [leaf("archive/x-9.json")]: JSON.stringify({ id: "x-9", title: "x", slug: "xi", body: "x", sources: [] }),
    [leaf("dir.json/keep")]: "not a leaf",
    [leaf("m-5.json")]: JSON.stringify({ id: "other", title: "m", slug: "mu", body: "m", sources: [], generatedAt: "2000-01-01T00:00:00.000Z" }),
  });
}

/** The `tolerant` project's disk answers: the public listing, and the unsafe id refused when ids must be safe. */
async function askedTolerantOnDisk(root: string) {
  return {
    listed: idsOf(await listCandidateFileEntries(root)),
    unsafeList: await nameOf(listCandidateFileEntries(root, true)),
    unsafeSelect: await nameOf(selectReadableCandidateEntriesForMutation(root, everything)),
  };
}

/** The `selectable` project's disk answers: a selection that leaves the mismatch unselected, the mismatch selected, and the cap. */
async function askedSelectableOnDisk(root: string) {
  return {
    selected: idsOf(await selectReadableCandidateEntriesForMutation(root, valid)),
    mismatch: await nameOf(selectReadableCandidateEntriesForMutation(root, (candidate) => candidate.slug === "mu")),
    cap: await nameOf(selectReadableCandidateEntriesForMutation(root, everything, capOne)),
  };
}

const tracker = tempRootTracker();
let tolerant: Minted<Awaited<ReturnType<typeof askedTolerantOnDisk>>>;
let selectable: Minted<Awaited<ReturnType<typeof askedSelectableOnDisk>>>;

mintOnceThenRemove(tracker, async () => {
  tolerant = await mintCopied(tracker, PREFIX, async (root) => {
    await seedStore(root);
    await writeFiles(root, { [leaf(".hidden.json")]: JSON.stringify({ id: ".hidden", title: "h", slug: "eta", body: "h", sources: [] }) });
  }, askedTolerantOnDisk);
  selectable = await mintCopied(tracker, PREFIX, seedStore, askedSelectableOnDisk);
});

/** Faults: one leaf read unavailable (optionally drifting the store as it is refused); the store rebinding once `drift.now` is set; the listing failing. */
interface Faults { unavailable?: string; driftOnUnavailable?: boolean; drift?: { now: boolean }; listingFails?: boolean }

/** List mechanisms over one copied project: direct entries straight from the copied listing, each call logged. */
function memoryListOf(minted: Minted<unknown>, note: Note, faults: Faults = {}): CandidateStoreListReads {
  const located = `${MEM_PROJECT}/${CANDIDATES_DIR}`;
  return {
    captureDirectory: async () => {
      note("dir");
      return minted.copy.listings.has(CANDIDATES_DIR) ? { dir: located, realDir: located, identity: { dev: 1, ino: faults.drift?.now ? 99 : 1 } } : null;
    },
    recordDirectory: (realDir) => ({
      exists: async () => realDir === located,
      listEntries: async () => {
        note("list");
        if (faults.listingFails) throw new Error("EIO: listing failed");
        return [...minted.copy.listings.get(CANDIDATES_DIR)!];
      },
    }),
    leafPath: async (fileId) => path.posix.join(MEM_PROJECT, leaf(`${fileId}.json`)),
    readLeaf: async (request) => {
      const rel = path.posix.relative(MEM_PROJECT, request.leaf);
      note(`read ${path.posix.basename(rel)}`);
      if (faults.unavailable !== undefined && rel === leaf(`${faults.unavailable}.json`)) {
        if (faults.driftOnUnavailable && faults.drift) faults.drift.now = true;
        return { kind: "unavailable" };
      }
      const text = minted.copy.files.get(rel);
      if (text === undefined) return { kind: "absent" };
      const bytes = Buffer.from(text, "utf8");
      return { kind: "ok", bytes, fileIdentity: { dev: 1, ino: bytes.byteLength } };
    },
  };
}

describe("the live tolerant candidate discovery and selection over copied stores, with every minting directory gone", () => {
  it("T1 runs after both minting directories were removed", () => {
    for (const one of [tolerant, selectable]) expectMintingDirectoryRemoved(one.dir, PREFIX);
  });

  it("T2 lists as the disk did: direct files only, malformed and unsafe leaves skipped, generation then UTF-8 order; unsafe ids refused on request", async () => {
    const log: string[] = [];
    const listed = await listCandidateFileEntriesFrom(memoryListOf(tolerant, (call) => log.push(call)));
    expect(idsOf(listed)).toEqual(tolerant.onDisk.listed);
    expect(listed.map((entry) => entry.fileId)).toEqual(["m-5", "a-1", "b-2", "c-3"]);
    expect(log.filter((call) => call.startsWith("read")).sort()).toEqual(["read a-1.json", "read b-2.json", "read bad.json", "read c-3.json", "read m-5.json"]);
    const unsafeList = await nameOf(listCandidateFileEntriesFrom(memoryListOf(tolerant, () => {}), true));
    expect(unsafeList).toBe(tolerant.onDisk.unsafeList);
  });

  it("T3 selects as the disk did: the unselected mismatch tolerated, the selected mismatch refused, the cap before identity, unsafe ids refused", async () => {
    const reads = memoryListOf(selectable, () => {});
    const answers = {
      selected: idsOf(await selectReadableCandidateEntriesForMutationFrom(reads, valid)),
      mismatch: await nameOf(selectReadableCandidateEntriesForMutationFrom(reads, (candidate) => candidate.slug === "mu")),
      cap: await nameOf(selectReadableCandidateEntriesForMutationFrom(reads, everything, capOne)),
    };
    expect(answers).toEqual(selectable.onDisk);
    expect([answers.mismatch, answers.cap]).toEqual(["CandidateIdentityMismatchError", "RangeError"]);
    const unsafeSelect = await nameOf(selectReadableCandidateEntriesForMutationFrom(memoryListOf(tolerant, () => {}), everything));
    expect([unsafeSelect, tolerant.onDisk.unsafeSelect]).toEqual(["UnsafeCandidateIdError", "UnsafeCandidateIdError"]);
  });

  it("T4 skips an unavailable leaf while the store holds, but propagates a drifted store and a failed listing", async () => {
    const skipped = await listCandidateFileEntriesFrom(memoryListOf(selectable, () => {}, { unavailable: "b-2" }));
    expect(skipped.map((entry) => entry.fileId)).toEqual(["m-5", "a-1", "c-3"]);
    const drifting = memoryListOf(selectable, () => {}, { unavailable: "b-2", driftOnUnavailable: true, drift: { now: false } });
    const drifted = await listCandidateFileEntriesFrom(drifting).catch((error: Error) => error);
    expect([drifted instanceof CandidateCustodyUnavailableError, drifted instanceof CandidateLeafUnavailableError]).toEqual([true, false]);
    const listing = await nameOf(listCandidateFileEntriesFrom(memoryListOf(selectable, () => {}, { listingFails: true })));
    expect(listing).toBe(CandidateCustodyUnavailableError.name);
  });

  it("T5 runs the hooks in order around the listing and refuses a store that drifted before the final re-proof", async () => {
    const log: string[] = [];
    const drift = { now: false };
    const hook = (name: string, then?: () => void) => async () => { log.push(`hook ${name}`); then?.(); };
    const run = selectReadableCandidateEntriesForMutationFrom(memoryListOf(selectable, (call) => log.push(call), { drift }), valid, undefined, {
      afterInitialCustodyForTest: hook("initial"), afterOpenForTest: hook("open"), afterEnumerationForTest: hook("enumerated"),
      beforeReturnForTest: hook("return", () => { drift.now = true; }),
    });
    await expect(run).rejects.toBeInstanceOf(CandidateCustodyUnavailableError);
    expect(log.filter((call) => call.startsWith("hook") || call === "list")).toEqual(["hook initial", "hook open", "list", "hook enumerated", "hook return"]);
    expect([log[0], log.at(-1)]).toEqual(["dir", "dir"]);
  });
});
