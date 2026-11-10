/**
 * @file test/storage/candidate-publication-binding.test.ts
 * @description The fresh review-candidate writer, WHOLE: `writeFreshCandidateFrom`
 * (identity minting and validation, the record build and serialization, and the
 * shared sixteen-attempt allocator with its namespace checks, the archive
 * recheck at the publication boundary and its failure policy) over a raw
 * publication store held in memory. It exists only after the allocator was
 * given a store of its own, so this file has NO before-edit run.
 *
 * HOW IT IS BUILT. Four projects are minted on real disk, once: an empty one, one
 * whose pending and archive namespaces each hold one of the first two
 * identities, one where the archive gains the first identity at the publication
 * boundary, and one where every attempt collides. The real root-taking
 * `writeFreshCandidate` answers on each, the tree is copied and every minting
 * directory is removed before any case runs. The in-memory store starts from
 * the same seed files, and its final queue is compared with the disk's copied
 * queue. The record's clock (`generatedAt`) is set aside as `<clock>`.
 *
 * WHAT RUNS FOR REAL IN MEMORY. The identity minting and checks, the record
 * build and serialization, the attempt loop and its bound, the namespace order,
 * the archive recheck, and the translation of every store fault.
 *
 * WHAT THE STORE DECIDES. Only what a store can: whether a leaf is held, where
 * an owned directory is, whether the namespaces are healthy (always, here), and
 * an exclusive create that refuses an occupied leaf. Every member logs a call.
 *
 * NOT SHOWN HERE, AND KEPT LOCAL TO THE DISK MECHANISMS: links (a pending link is
 * a collision), the namespace identity and access probes, directory
 * confinement, the no-replace link commit and its committed-cleanup tolerance.
 * Their incumbent regressions are `candidate-fresh-publication-final8.test.ts`
 * and `candidate-writer-final9.test.ts`. Canonical replacement, duplicate
 * deletion, the custody-bound selection, archive and the project lock are not
 * reached by this writer. The store is not a hosted store and not `ProjectStore`.
 */

import path from "node:path";
import { describe, expect, it } from "bun:test";
import {
  CandidatePublicationUnavailableError, FreshCandidateIdExhaustedError, writeFreshCandidate, writeFreshCandidateFrom, type CandidateDraft,
} from "../../src/compiler/candidates.js";
import type { CandidatePublicationStore, FreshCandidateWriteOptions } from "../../src/compiler/candidate-publication.js";
import { UnsafeCandidateDirError } from "../../src/compiler/candidate-store-paths.js";
import { AtomicWriteCollisionError } from "../../src/utils/atomic-write.js";
import { CANDIDATES_ARCHIVE_DIR, CANDIDATES_DIR } from "../../src/utils/constants.js";
import { tempRootTracker } from "../temp-roots.js";
import { mintCopied, mintOnceThenRemove, writeFiles, type Minted, type Note } from "./copied-project.js";
import { expectMintingDirectoryRemoved } from "./minted-directory.js";

const PREFIX = "candidate-publication-binding-";
const MEM_PROJECT = "/memory/project";
/** The record's own clock, set aside on both sides. */
const CLOCK = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g;
const DRAFT: CandidateDraft = { title: "Fresh", slug: "fresh", summary: "", sources: [], body: "new" };
const pending = (id: string): string => `${CANDIDATES_DIR}/${id}.json`;
const archived = (id: string): string => `${CANDIDATES_ARCHIVE_DIR}/${id}.json`;
/** A deterministic identity per attempt; the last one repeats. */
const ids = (...values: string[]) => (_slug: string, attempt: number): string => values[attempt] ?? values.at(-1)!;

/** One scenario: the seed, the options (given a way to plant a file mid-run), and nothing else. */
interface Scenario { seed: Record<string, string>; options: (plant: (rel: string, text: string) => Promise<void>) => FreshCandidateWriteOptions }
/** What one writer answered: the record (or the refusal's name) and the whole queue afterwards, clock set aside. */
interface Answer { outcome: string; queue: Record<string, string> }

const SCENARIOS = {
  empty: { seed: {}, options: () => ({ idForAttemptForTest: ids("fresh-a") }) },
  taken: {
    seed: { [pending("fresh-a")]: "pending-authority", [archived("fresh-b")]: "archive-authority" },
    options: () => ({ idForAttemptForTest: ids("fresh-a", "fresh-b", "fresh-c") }),
  },
  raced: {
    seed: {},
    options: (plant) => ({
      idForAttemptForTest: ids("fresh-a", "fresh-b"),
      beforePublishForTest: async (_id, attempt) => { if (attempt === 0) await plant(archived("fresh-a"), "raced-authority"); },
    }),
  },
  exhausted: { seed: { [pending("fresh-a")]: "pending-authority" }, options: () => ({ idForAttemptForTest: ids("fresh-a") }) },
} satisfies Record<string, Scenario>;

/** The outcome of one write: its record with the clock set aside, or its refusal's name. */
async function outcomeOf(write: Promise<unknown>): Promise<string> {
  return write.then((record) => JSON.stringify(record).replace(CLOCK, "<clock>"), (error: Error) => error.name);
}

/** The candidate queue among held files, with the clock set aside. */
function queueOf(files: Iterable<[string, string]>): Record<string, string> {
  const queue: Record<string, string> = {};
  for (const [rel, text] of files) if (rel.startsWith(`${CANDIDATES_DIR}/`)) queue[rel] = text.replace(CLOCK, "<clock>");
  return queue;
}

const tracker = tempRootTracker();
const minted: Partial<Record<keyof typeof SCENARIOS, Minted<string>>> = {};

mintOnceThenRemove(tracker, async () => {
  for (const [name, scenario] of Object.entries(SCENARIOS) as [keyof typeof SCENARIOS, Scenario][]) {
    minted[name] = await mintCopied(tracker, PREFIX, (root) => writeFiles(root, scenario.seed),
      (root) => outcomeOf(writeFreshCandidate(root, DRAFT, scenario.options((rel, text) => writeFiles(root, { [rel]: text })))));
  }
});

/** A publication store held in memory over `held`, each call logged; `faults` replace members. */
function memoryStoreOf(held: Map<string, string>, note: Note, faults: Partial<CandidatePublicationStore> = {}): CandidatePublicationStore {
  const relOf = (location: string): string => path.posix.relative(MEM_PROJECT, location);
  const holdsUnder = (relDir: string): boolean => [...held.keys()].some((rel) => rel.startsWith(`${relDir}/`));
  return {
    assertNamespacesHealthy: async () => { note("health"); },
    ownedDirectory: async (relDir) => { note(`dir ${relDir}`); return holdsUnder(relDir) ? path.posix.join(MEM_PROJECT, relDir) : null; },
    leafPresent: async (dir, leafName) => { note(`present ${relOf(dir)}/${leafName}`); return held.has(`${relOf(dir)}/${leafName}`); },
    createPending: async (id, text, hooks) => {
      note(`create ${id}`);
      await hooks.afterParentCheck();
      if (held.has(pending(id))) throw new AtomicWriteCollisionError();
      held.set(pending(id), text);
      await hooks.afterCommit?.();
    },
    ...faults,
  };
}

/** Run one scenario's whole writer in memory, from its seed. */
async function inMemory(name: keyof typeof SCENARIOS): Promise<Answer & { log: string[] }> {
  const scenario: Scenario = SCENARIOS[name];
  const held = new Map(Object.entries(scenario.seed));
  const log: string[] = [];
  const plant = async (rel: string, text: string): Promise<void> => { held.set(rel, text); };
  const outcome = await outcomeOf(writeFreshCandidateFrom(memoryStoreOf(held, (call) => log.push(call)), DRAFT, scenario.options(plant)));
  return { outcome, queue: queueOf(held), log };
}

/** What the disk answered for one scenario, with its copied queue. */
function onDisk(name: keyof typeof SCENARIOS): Answer {
  const one = minted[name]!;
  return { outcome: one.onDisk, queue: queueOf(one.copy.files) };
}

describe("the fresh candidate writer over a publication store, with every directory gone", () => {
  it("P1 runs after every minting directory was removed", () => {
    for (const one of Object.values(minted)) expectMintingDirectoryRemoved(one!.dir, PREFIX);
  });

  it("P2 publishes into an empty project exactly as the disk did: the record and the queue's bytes", async () => {
    const { outcome, queue } = await inMemory("empty");
    expect({ outcome, queue }).toEqual(onDisk("empty"));
    expect(Object.keys(queue)).toEqual([pending("fresh-a")]);
  });

  it("P3 skips a pending and an archived identity as the disk did, consulting pending then archive, and rechecks archive at the boundary", async () => {
    const { outcome, queue, log } = await inMemory("taken");
    expect({ outcome, queue }).toEqual(onDisk("taken"));
    expect(log).toEqual([
      "health", `dir ${CANDIDATES_DIR}`, `present ${pending("fresh-a")}`,
      "health", `dir ${CANDIDATES_DIR}`, `present ${pending("fresh-b")}`, `dir ${CANDIDATES_ARCHIVE_DIR}`, `present ${archived("fresh-b")}`,
      "health", `dir ${CANDIDATES_DIR}`, `present ${pending("fresh-c")}`, `dir ${CANDIDATES_ARCHIVE_DIR}`, `present ${archived("fresh-c")}`,
      "create fresh-c", `dir ${CANDIDATES_ARCHIVE_DIR}`, `present ${archived("fresh-c")}`,
    ]);
  });

  it("P4 loses an archive race at the publication boundary and takes the next identity, as the disk did", async () => {
    const { outcome, queue } = await inMemory("raced");
    expect({ outcome, queue }).toEqual(onDisk("raced"));
    expect(queue[archived("fresh-a")]).toBe("raced-authority");
  });

  it("P5 refuses after sixteen collisions with the disk's refusal, leaving the queue as it was", async () => {
    const { outcome, queue, log } = await inMemory("exhausted");
    expect({ outcome, queue }).toEqual(onDisk("exhausted"));
    expect([outcome, log.filter((call) => call === "health").length]).toEqual([FreshCandidateIdExhaustedError.name, 16]);
  });

  it("P6 turns a raw existence or create fault into the fixed publication refusal, and nothing is held", async () => {
    const reached: string[] = [];
    const raw = (member: string): never => { reached.push(member); throw Object.assign(new Error("EACCES: raw"), { code: "EACCES" }); };
    /** An owned directory that exists and is empty, so the existence check is actually asked. */
    const emptyOwned = async (relDir: string): Promise<string> => path.posix.join(MEM_PROJECT, relDir);
    for (const faults of [{ ownedDirectory: emptyOwned, leafPresent: async () => raw("leafPresent") }, { createPending: async () => raw("createPending") }]) {
      const held = new Map<string, string>();
      const write = writeFreshCandidateFrom(memoryStoreOf(held, () => {}, faults), DRAFT, { idForAttemptForTest: ids("fresh-a") });
      await expect(write).rejects.toBeInstanceOf(CandidatePublicationUnavailableError);
      expect(held.size).toBe(0);
    }
    expect(reached).toEqual(["leafPresent", "createPending"]);
  });

  it("P7 lets an unsafe directory pass through unchanged, and retries a create collision with the next identity", async () => {
    const unsafe = memoryStoreOf(new Map(), () => {}, { ownedDirectory: async () => { throw new UnsafeCandidateDirError(); } });
    await expect(writeFreshCandidateFrom(unsafe, DRAFT, { idForAttemptForTest: ids("fresh-a") })).rejects.toBeInstanceOf(UnsafeCandidateDirError);
    const held = new Map<string, string>();
    const once = memoryStoreOf(held, () => {});
    let created = 0;
    const collideOnce = { ...once, createPending: async (...args: Parameters<CandidatePublicationStore["createPending"]>) => {
      if ((created += 1) === 1) throw new AtomicWriteCollisionError();
      return once.createPending(...args);
    } };
    const record = await writeFreshCandidateFrom(collideOnce, DRAFT, { idForAttemptForTest: ids("fresh-a", "fresh-b") });
    expect([record.id, [...held.keys()]]).toEqual(["fresh-b", [pending("fresh-b")]]);
  });
});
