/**
 * @file test/storage/candidate-write-delete-binding.test.ts
 * @description The candidate WRITERS, WHOLE: `writeCandidateFrom` (the answer
 * branch, first-identity minting and validation before any store access, the
 * tolerant target-key selection, the earliest canonical replaced under its
 * exact receipt, the duplicates deleted in order, and the shared exclusive
 * publisher when nothing matches), `deleteCandidateFrom` and
 * `deleteCandidateBySlugFrom` (the shared exact-receipt deletion, with the
 * namespace policy as domain code), over store mechanisms held in memory. They
 * exist only after the writers were given mechanisms of their own, so this
 * file has NO before-edit run.
 *
 * HOW IT IS BUILT. Six default projects are minted on real disk, once, each
 * seeded by the real `writeFreshCandidate` with deterministic ids. Each
 * project's OWN disk ask snapshots the pending queue (the existing
 * `snapshotCandidateQueue`), then runs the real root-taking writer; every
 * refusal it asks for is captured as a value, so none escapes the mint. The
 * trees are copied and the minting directories are removed before any case
 * runs. The memory side starts from the disk's own pre-operation snapshot and
 * is compared with the copied post-operation queue. The only thing set aside
 * is the `generatedAt` FIELD, matched by name and never any other
 * timestamp-looking text, which a write necessarily stamps afresh. Records an
 * operation must not touch are also compared byte for byte with the snapshot.
 *
 * WHAT THE MECHANISMS DECIDE. Only what a store can: whether a directory is
 * bound and its identity, that access probes pass, the direct entries of a
 * directory, a leaf's bytes and identity, an exclusive create, an atomic
 * replace (a new inode, as on disk) and a removal. Identities are SYNTHETIC
 * device and inode numbers standing in for the local physical contract, not a
 * hosted guarantee. Every call is logged; creates, replaces and removals also
 * go to a separate effect log.
 *
 * NOT SHOWN HERE, AND KEPT LOCAL TO THE DISK MECHANISMS: links, the no-follow
 * open, real directory drift, real access refusals, confinement refusals of a
 * path, the atomic writers' temp files and the archive move. Their regressions
 * stay in the incumbent writer, deletion, namespace and durability suites.
 */

import { writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import type { CandidateStoreWriteReads } from "../../src/compiler/candidate-custody.js";
import {
  deleteCandidate, deleteCandidateBySlug, deleteCandidateBySlugFrom, deleteCandidateFrom, writeCandidate, writeCandidateFrom,
  writeFreshCandidate, type CandidateDraft, type CandidateWriteOptions,
} from "../../src/compiler/candidates.js";
import { AtomicWriteCollisionError } from "../../src/utils/atomic-write.js";
import { CANDIDATES_DIR } from "../../src/utils/constants.js";
import { answerDraft } from "../fixtures/answer-candidate.js";
import { snapshotCandidateQueue } from "../fixtures/candidate-queue.js";
import { tempRootTracker } from "../temp-roots.js";
import { mintCopied, mintOnceThenRemove, type Minted, type Note } from "./copied-project.js";
import { expectMintingDirectoryRemoved } from "./minted-directory.js";

const PREFIX = "candidate-write-delete-binding-";
const MEM_PROJECT = "/memory/project";
/** The record's own `generatedAt` field, and nothing else, is set aside on both sides. */
const GENERATED_AT = /("generatedAt":\s?)"[^"]*"/g;
const unclock = (text: string): string => text.replace(GENERATED_AT, '$1"<clock>"');
const draft = (slug: string, body = `${slug} body`): CandidateDraft => ({ title: slug, slug, summary: "", sources: [], body });
const id = (value: string) => ({ idForAttemptForTest: () => value });
const settle = (run: Promise<unknown>): Promise<string> =>
  run.then((value) => unclock(JSON.stringify(value)), (error: Error) => error.name);

/**
 * The seeded records: two duplicates on `concepts/alpha`; a typed record that
 * shares only the slug (`papers/alpha`); a validated answer on its own target
 * (`queries/answer`); and an unrelated record.
 */
const SEEDS = {
  dupA: async (root: string) => { await writeFreshCandidate(root, draft("alpha"), id("alpha-a")); },
  dupB: async (root: string) => { await writeFreshCandidate(root, draft("alpha"), id("alpha-b")); },
  typed: async (root: string) => { await writeFreshCandidate(root, { ...draft("alpha"), targetEntityType: "papers" }, id("alpha-p")); },
  answer: async (root: string) => { await writeFreshCandidate(root, answerDraft(), id("answer-q")); },
  unrelated: async (root: string) => { await writeFreshCandidate(root, draft("beta"), id("beta-u")); },
};
type Seed = keyof typeof SEEDS;

/** One scenario: its seeds, then the same operation on disk (by root) and in memory (by mechanisms and the held map). */
interface Scenario {
  seeds: Seed[];
  disk: (root: string) => Promise<unknown>;
  memory: (reads: CandidateStoreWriteReads, held: Map<string, Held>) => Promise<unknown>;
}
interface Held { bytes: Buffer; ino: number }
const pendingRel = (fileId: string): string => `${CANDIDATES_DIR}/${fileId}.json`;
const replacement = draft("alpha", "new alpha body");
/** The answer draft with its answer metadata stripped: a GENERIC draft on the same target as the answer (`queries/answer`). */
const { candidateKind: _kind, citationManifest: _manifest, ...genericOnAnswerTarget } = answerDraft();
const tamper = (held: Map<string, Held>) => async () => { held.set(pendingRel("alpha-a"), { bytes: Buffer.from("tampered"), ino: 900 }); };

const SCENARIOS = {
  canonical: { seeds: ["dupA", "dupB", "typed", "answer", "unrelated"], disk: (root) => writeCandidate(root, replacement, id("alpha-z")),
    memory: (reads) => writeCandidateFrom(reads, replacement, id("alpha-z")) },
  fresh: { seeds: ["typed", "answer"], disk: (root) => writeCandidate(root, replacement, id("alpha-z")),
    memory: (reads) => writeCandidateFrom(reads, replacement, id("alpha-z")) },
  refused: { seeds: ["dupA", "dupB"],
    disk: (root) => writeCandidate(root, replacement, { beforePublishForTest: async () => { await writeFile(path.join(root, pendingRel("alpha-a")), "tampered"); } }),
    memory: (reads, held) => writeCandidateFrom(reads, replacement, { beforePublishForTest: tamper(held) } satisfies CandidateWriteOptions) },
  slug: { seeds: ["dupA", "dupB", "typed", "answer", "unrelated"], disk: (root) => deleteCandidateBySlug(root, "alpha"),
    memory: (reads) => deleteCandidateBySlugFrom(reads, "alpha") },
  answer: { seeds: ["answer"],
    disk: async (root) => [await settle(writeCandidate(root, answerDraft(), id("answer-z"))), await settle(writeCandidate(root, genericOnAnswerTarget, id("answer-g")))],
    memory: async (reads) => [await settle(writeCandidateFrom(reads, answerDraft(), id("answer-z"))), await settle(writeCandidateFrom(reads, genericOnAnswerTarget, id("answer-g")))] },
  direct: { seeds: ["dupA", "unrelated"],
    disk: async (root) => [await deleteCandidate(root, "beta-u"), await deleteCandidate(root, "gone-x")],
    memory: async (reads) => [await deleteCandidateFrom(reads, "beta-u"), await deleteCandidateFrom(reads, "gone-x")] },
} satisfies Record<string, Scenario>;
type Name = keyof typeof SCENARIOS;

/** What the disk answered: the queue before, the outcome, and the refusals for invalid identities. */
interface OnDisk { before: Record<string, string>; outcome: string; invalid: string[] }

const tracker = tempRootTracker();
const minted: Partial<Record<Name, Minted<OnDisk>>> = {};

mintOnceThenRemove(tracker, async () => {
  for (const [name, scenario] of Object.entries(SCENARIOS) as [Name, Scenario][]) {
    minted[name] = await mintCopied(tracker, PREFIX, async (root) => { for (const seed of scenario.seeds) await SEEDS[seed](root); },
      async (root) => ({
        before: await snapshotCandidateQueue(root),
        outcome: await settle(scenario.disk(root)),
        invalid: [await settle(writeCandidate(root, draft("../x"))), await settle(deleteCandidateBySlug(root, "../x"))],
      }));
  }
});

/** Store mechanisms over `held`; every call to `note`, every create/replace/remove also to `effect`. */
function memoryStoreOf(held: Map<string, Held>, note: Note, effect: Note): CandidateStoreWriteReads {
  let nextIno = 500;
  const relOf = (location: string): string => path.posix.relative(MEM_PROJECT, location);
  const under = (relDir: string): string[] => [...held.keys()].filter((rel) => rel.startsWith(`${relDir}/`)).map((rel) => rel.slice(relDir.length + 1));
  const leafId = (leaf: string): string => path.posix.basename(leaf, ".json");
  return {
    captureDirectory: async (relDir) => {
      note(`dir ${relDir}`);
      const location = path.posix.join(MEM_PROJECT, relDir);
      return under(relDir).length === 0 ? null : { dir: location, realDir: location, identity: { dev: 1, ino: relDir === CANDIDATES_DIR ? 1 : 2 } };
    },
    probeDirectory: async () => { note("probe"); return true; },
    recordDirectory: (realDir) => ({
      exists: async () => under(relOf(realDir)).length > 0,
      listEntries: async () => [...new Set(under(relOf(realDir)).map((rest) => rest.split("/")[0]!))]
        .map((name) => ({ name, kind: under(relOf(realDir)).includes(name) ? "file" as const : "directory" as const })),
    }),
    leafPath: async (fileId, location) => path.posix.join(MEM_PROJECT, location === "pending" ? pendingRel(fileId) : `${CANDIDATES_DIR}/archive/${fileId}.json`),
    readLeaf: async (request) => {
      note("read");
      const leaf = held.get(relOf(request.leaf));
      if (leaf === undefined) return { kind: "absent" };
      return leaf.bytes.byteLength > request.maxBytes ? { kind: "unavailable" } : { kind: "ok", bytes: leaf.bytes, fileIdentity: { dev: 1, ino: leaf.ino } };
    },
    leafPresent: async (dir, leafName) => held.has(`${relOf(dir)}/${leafName}`),
    createLeaf: async (leaf, text, hooks) => {
      await hooks.afterParentCheck();
      if (held.has(relOf(leaf))) throw new AtomicWriteCollisionError();
      held.set(relOf(leaf), { bytes: Buffer.from(text, "utf8"), ino: nextIno++ });
      effect(`create ${leafId(leaf)}`);
      await hooks.afterCommit?.();
    },
    replaceLeaf: async (leaf, text) => { held.set(relOf(leaf), { bytes: Buffer.from(text, "utf8"), ino: nextIno++ }); effect(`replace ${leafId(leaf)}`); },
    removeLeaf: async (leaf) => {
      if (!held.delete(relOf(leaf))) throw Object.assign(new Error("ENOENT: not held"), { code: "ENOENT" });
      effect(`remove ${leafId(leaf)}`);
    },
  };
}

/** Run one scenario in memory from the disk's own pre-operation queue; returns the outcome, the queue after, and both logs. */
async function inMemory(name: Name) {
  const one = minted[name]!;
  const held = new Map(Object.entries(one.onDisk.before).map(([file, b64], index) => [`${CANDIDATES_DIR}/${file}`, { bytes: Buffer.from(b64, "base64"), ino: 100 + index }]));
  const calls: string[] = [];
  const effects: string[] = [];
  const reads = memoryStoreOf(held, (call) => calls.push(call), (call) => effects.push(call));
  const scenario: Scenario = SCENARIOS[name];
  const outcome = await settle(scenario.memory(reads, held));
  const raw = Object.fromEntries([...held].map(([rel, leaf]) => [rel, leaf.bytes.toString("utf8")]));
  const queue = Object.fromEntries(Object.entries(raw).map(([rel, text]) => [rel, unclock(text)]));
  return { outcome, queue, raw, calls, effects };
}

/** The disk's copied post-operation queue, clock set aside. */
function diskQueue(name: Name): Record<string, string> {
  const files = [...minted[name]!.copy.files].filter(([rel]) => rel.startsWith(`${CANDIDATES_DIR}/`) && rel.endsWith(".json"));
  return Object.fromEntries(files.map(([rel, text]) => [rel, unclock(text)]));
}

/** One seeded record's exact bytes in the disk's pre-operation snapshot. */
const beforeText = (name: Name, fileId: string): string => Buffer.from(minted[name]!.onDisk.before[`${fileId}.json`]!, "base64").toString("utf8");

describe("the candidate writers over copied default projects, with every minting directory gone", () => {
  it("W1 runs after every minting directory was removed", () => {
    for (const one of Object.values(minted)) expectMintingDirectoryRemoved(one!.dir, PREFIX);
  });

  it("W2 replaces the earliest canonical under its receipt and deletes the duplicate, leaving typed, answer and unrelated records, as the disk did", async () => {
    const { outcome, queue, raw, effects } = await inMemory("canonical");
    expect([outcome, queue]).toEqual([minted.canonical!.onDisk.outcome, diskQueue("canonical")]);
    expect(effects).toEqual(["replace alpha-a", "remove alpha-b"]);
    for (const kept of ["alpha-p", "answer-q", "beta-u"]) expect(raw[pendingRel(kept)]).toBe(beforeText("canonical", kept));
    expect(Object.keys(queue).sort()).toEqual(["alpha-a", "alpha-p", "answer-q", "beta-u"].map(pendingRel));
  });

  it("W3 takes the fresh allocator when no non-answer record has the target (the typed record shares only the slug), as the disk did", async () => {
    const { outcome, queue, effects } = await inMemory("fresh");
    expect([outcome, queue]).toEqual([minted.fresh!.onDisk.outcome, diskQueue("fresh")]);
    expect(effects).toEqual(["create alpha-z"]);
  });

  it("W4 refuses a canonical whose custody changed before the replace, with no effect, as the disk did", async () => {
    const { outcome, queue, effects } = await inMemory("refused");
    expect([outcome, queue]).toEqual([minted.refused!.onDisk.outcome, diskQueue("refused")]);
    expect([outcome, effects]).toEqual(["CandidateCustodyUnavailableError", []]);
  });

  it("W5 deletes every concepts match for a slug in order, leaving the typed, answer and unrelated records, as the disk did", async () => {
    const { outcome, queue, effects } = await inMemory("slug");
    expect([outcome, queue]).toEqual([minted.slug!.onDisk.outcome, diskQueue("slug")]);
    expect([outcome, effects]).toEqual(["true", ["remove alpha-a", "remove alpha-b"]]);
  });

  it("W6 deletes one record directly and reports an absent one, as the disk did", async () => {
    const { outcome, queue, effects } = await inMemory("direct");
    expect([outcome, queue]).toEqual([minted.direct!.onDisk.outcome, diskQueue("direct")]);
    expect([outcome, effects]).toEqual(["[true,false]", ["remove beta-u"]]);
  });

  it("W8 sends an answer to the fresh allocator, and a generic write to the answer's own target never replaces the answer, as the disk did", async () => {
    const { outcome, queue, raw, effects } = await inMemory("answer");
    expect([outcome, queue]).toEqual([minted.answer!.onDisk.outcome, diskQueue("answer")]);
    expect(effects).toEqual(["create answer-z", "create answer-g"]);
    expect(raw[pendingRel("answer-q")]).toBe(beforeText("answer", "answer-q"));
  });

  it("W7 refuses an invalid slug before any store access, as the disk did", async () => {
    const calls: string[] = [];
    const reads = memoryStoreOf(new Map(), (call) => calls.push(call), () => {});
    const invalid = [await settle(writeCandidateFrom(reads, draft("../x"))), await settle(deleteCandidateBySlugFrom(reads, "../x"))];
    expect(invalid).toEqual(minted.direct!.onDisk.invalid);
    expect([invalid, calls]).toEqual([["UnsafeCandidateIdError", "UnsafeCandidateIdError"], []]);
  });
});
