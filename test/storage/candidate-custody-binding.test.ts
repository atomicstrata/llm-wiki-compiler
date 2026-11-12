/**
 * @file test/storage/candidate-custody-binding.test.ts
 * @description The candidate custody reads, WHOLE: the strict mutation reader
 * `readCandidateEntryForMutationFrom` (id admission, the typed confinement
 * refusal, the store binding, the guarded read, the absence / leaf / store
 * classification, the byte policy, the receipt and the record admission) and
 * `observeCandidateCustodyFrom` (the restored / archived / conflict decision),
 * over custody-read mechanisms held in memory. They exist only after the
 * custody reads were given mechanisms of their own, so this file has NO
 * before-edit run.
 *
 * HOW IT IS BUILT. One default project is minted on real disk, once: a
 * candidate written by the real `writeCandidate` (`kept-a`), a malformed leaf
 * (`broken-c`), and a second candidate (`moved-b`) whose custody the real code
 * captures and then observes before, after the real guarded `archiveCandidate`
 * move, and after an equal-bytes leaf is re-created in pending. The real
 * root-taking readers answer on disk, the tree is copied and the minting
 * directory is removed before any case runs.
 *
 * WHAT THE MECHANISMS DECIDE. Only what a store can: whether a directory is
 * bound and its identity, where a leaf is, and a leaf's bytes and identity
 * capped at the byte limit. Identities here are SYNTHETIC device and inode
 * numbers standing in for the local physical contract; they are not a
 * cross-backend identity, and receipts are compared by count and digest only.
 * A leaf keeps its inode when moved and gets a new one when re-created, as on
 * disk. Every mechanism call is logged.
 *
 * NOT SHOWN HERE, AND KEPT LOCAL TO THE DISK MECHANISMS: links, the no-follow
 * open, handle and path identity re-proofs, real directory drift, the guarded
 * move itself, enumeration, namespace and access probes, replacement and
 * deletion. Their incumbent regressions stay in the existing custody suites.
 */

import { writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import {
  captureCandidateCustody, captureCandidateCustodyFrom, CandidateCustodyUnavailableError, CandidateLeafUnavailableError,
  observeCandidateCustody, observeCandidateCustodyFrom, type CandidateCustodyReads,
} from "../../src/compiler/candidate-custody.js";
import { readCandidateEntryForMutation, readCandidateEntryForMutationFrom, type CandidateFileEntry } from "../../src/compiler/candidate-read.js";
import { archiveCandidate, writeCandidate } from "../../src/compiler/candidates.js";
import { CANDIDATES_ARCHIVE_DIR, CANDIDATES_DIR } from "../../src/utils/constants.js";
import { tempRootTracker } from "../temp-roots.js";
import { mintCopied, mintOnceThenRemove, writeFiles, type Minted, type Note } from "./copied-project.js";
import { expectMintingDirectoryRemoved } from "./minted-directory.js";

const PREFIX = "candidate-custody-binding-";
const MEM_PROJECT = "/memory/project";
const pending = (id: string): string => `${CANDIDATES_DIR}/${id}.json`;
const archived = (id: string): string => `${CANDIDATES_ARCHIVE_DIR}/${id}.json`;
const draft = (slug: string) => ({ title: slug, slug, summary: "", sources: [], body: `${slug} body` });

/** What a strict read is, without its physical identities. */
const summaryOf = (entry: CandidateFileEntry) =>
  ({ fileId: entry.fileId, candidate: entry.candidate, byteCount: entry.custodyReceipt.byteCount, sha256: entry.custodyReceipt.sha256 });
const nameOf = (run: Promise<unknown>): Promise<string> => run.then(() => "resolved", (error: Error) => error.name);

/** What the disk answered. */
interface OnDisk { kept: ReturnType<typeof summaryOf>; refusals: Record<string, string>; states: string[] }

/** The real readers on disk, then custody of `moved-b` observed before and after the real move and a re-created leaf. */
async function askedOnDisk(root: string): Promise<OnDisk> {
  const kept = summaryOf(await readCandidateEntryForMutation(root, "kept-a"));
  const refusals = {
    broken: await nameOf(readCandidateEntryForMutation(root, "broken-c")),
    gone: await nameOf(readCandidateEntryForMutation(root, "gone-d")),
    unsafe: await nameOf(readCandidateEntryForMutation(root, "../x")),
  };
  const custody = (await captureCandidateCustody(root, "moved-b"))!;
  const states = [await observeCandidateCustody(root, custody.receipt)];
  await archiveCandidate(root, "moved-b");
  states.push(await observeCandidateCustody(root, custody.receipt));
  await writeFile(path.join(root, pending("moved-b")), custody.bytes);
  states.push(await observeCandidateCustody(root, custody.receipt));
  return { kept, refusals, states };
}

const tracker = tempRootTracker();
let project: Minted<OnDisk>;

mintOnceThenRemove(tracker, async () => {
  project = await mintCopied(tracker, PREFIX, async (root) => {
    await writeCandidate(root, draft("kept"), { idForAttemptForTest: () => "kept-a" });
    await writeCandidate(root, draft("moved"), { idForAttemptForTest: () => "moved-b" });
    await writeFiles(root, { [pending("broken-c")]: "{" });
  }, askedOnDisk);
});

/** A held leaf: its bytes and its synthetic inode. */
interface Held { bytes: Buffer; ino: number }
/** Faults a case may switch on: every leaf read unavailable, and the pending store rebinding after a read. */
interface Faults { leafUnavailable?: boolean; driftAfterRead?: boolean }

/** Custody-read mechanisms over `held`, each call logged; directories exist when they hold a leaf. */
function memoryReadsOf(held: Map<string, Held>, note: Note, faults: Faults = {}): CandidateCustodyReads {
  const dirIno: Record<string, number> = { [CANDIDATES_DIR]: 1, [CANDIDATES_ARCHIVE_DIR]: 2 };
  let drifted = false;
  return {
    captureDirectory: async (relDir) => {
      note(`dir ${relDir}`);
      if (![...held.keys()].some((rel) => rel.startsWith(`${relDir}/`))) return null;
      const location = path.posix.join(MEM_PROJECT, relDir);
      return { dir: location, realDir: location, identity: { dev: 1, ino: drifted && relDir === CANDIDATES_DIR ? 99 : dirIno[relDir]! } };
    },
    leafPath: async (fileId, location) => { note(`leaf ${location} ${fileId}`); return path.posix.join(MEM_PROJECT, location === "pending" ? pending(fileId) : archived(fileId)); },
    readLeaf: async (request) => {
      const rel = path.posix.relative(MEM_PROJECT, request.leaf);
      note(`read ${rel}`);
      drifted = faults.driftAfterRead === true;
      const leaf = held.get(rel);
      if (leaf === undefined) return { kind: "absent" };
      if (faults.leafUnavailable || leaf.bytes.byteLength > request.maxBytes) return { kind: "unavailable" };
      return { kind: "ok", bytes: leaf.bytes, fileIdentity: { dev: 1, ino: leaf.ino } };
    },
  };
}

/** The copied project's candidate leaves, each given its own synthetic inode. */
function heldFromCopy(): Map<string, Held> {
  let ino = 100;
  const held = new Map<string, Held>();
  for (const [rel, text] of project.copy.files) if (rel.startsWith(`${CANDIDATES_DIR}/`)) held.set(rel, { bytes: Buffer.from(text, "utf8"), ino: ino++ });
  return held;
}

describe("the candidate custody reads over copied candidates, with the minting directory gone", () => {
  it("K1 runs after the minting directory was removed", () => {
    expectMintingDirectoryRemoved(project.dir, PREFIX);
  });

  it("K2 reads the written candidate strictly exactly as the disk did: record, byte count and digest, in admission order", async () => {
    const log: string[] = [];
    const entry = await readCandidateEntryForMutationFrom(memoryReadsOf(heldFromCopy(), (call) => log.push(call)), "kept-a");
    expect(summaryOf(entry)).toEqual(project.onDisk.kept);
    expect(log).toEqual([`leaf pending kept-a`, `dir ${CANDIDATES_DIR}`, `read ${pending("kept-a")}`]);
  });

  it("K3 refuses a malformed, an absent and an unsafe id with the disk's errors; the unsafe id reaches no mechanism", async () => {
    const log: string[] = [];
    const reads = memoryReadsOf(heldFromCopy(), (call) => log.push(call));
    const refusals = {
      broken: await nameOf(readCandidateEntryForMutationFrom(reads, "broken-c")),
      gone: await nameOf(readCandidateEntryForMutationFrom(reads, "gone-d")),
    };
    log.length = 0;
    const unsafe = await nameOf(readCandidateEntryForMutationFrom(reads, "../x"));
    expect({ ...refusals, unsafe }).toEqual(project.onDisk.refusals);
    expect(log).toEqual([]);
  });

  it("K4 classifies an unavailable leaf as leaf-unavailable while the store holds, and as custody-unavailable once it drifts", async () => {
    const leafOnly = memoryReadsOf(heldFromCopy(), () => {}, { leafUnavailable: true });
    await expect(readCandidateEntryForMutationFrom(leafOnly, "kept-a")).rejects.toBeInstanceOf(CandidateLeafUnavailableError);
    const drifting = memoryReadsOf(heldFromCopy(), () => {}, { leafUnavailable: true, driftAfterRead: true });
    const outcome = await readCandidateEntryForMutationFrom(drifting, "kept-a").catch((error: Error) => error);
    expect([outcome instanceof CandidateCustodyUnavailableError, outcome instanceof CandidateLeafUnavailableError]).toEqual([true, false]);
  });

  it("K5 refuses an expected store whose identity no longer holds", async () => {
    const reads = memoryReadsOf(heldFromCopy(), () => {});
    const stale = { dir: `${MEM_PROJECT}/${CANDIDATES_DIR}`, realDir: `${MEM_PROJECT}/${CANDIDATES_DIR}`, identity: { dev: 1, ino: 42 } };
    await expect(readCandidateEntryForMutationFrom(reads, "kept-a", stale)).rejects.toBeInstanceOf(CandidateCustodyUnavailableError);
  });

  it("K6 observes restored, archived and conflict exactly as the disk did across a move and an equal-bytes re-creation", async () => {
    const held = heldFromCopy();
    const bytes = held.get(archived("moved-b"))!.bytes;
    held.delete(archived("moved-b"));
    held.set(pending("moved-b"), { bytes, ino: 7 });
    const reads = memoryReadsOf(held, () => {});
    const custody = (await captureCandidateCustodyFrom(reads, "moved-b"))!;
    const states = [await observeCandidateCustodyFrom(reads, custody.receipt)];
    held.set(archived("moved-b"), held.get(pending("moved-b"))!);
    held.delete(pending("moved-b"));
    states.push(await observeCandidateCustodyFrom(reads, custody.receipt));
    held.set(pending("moved-b"), { bytes, ino: 8 });
    states.push(await observeCandidateCustodyFrom(reads, custody.receipt));
    expect(states).toEqual(project.onDisk.states);
    expect(states).toEqual(["restored", "archived", "conflict"]);
  });
});
