/**
 * @file test/storage/review-embedding-intent-binding.test.ts
 * @description The review embedding INTENT, WHOLE: `openReviewEmbeddingIntentFrom`
 * (the private directory, the bounded read and what absent, unavailable and
 * schema-invalid mean, snapshot-key selection and merge, and the session's
 * `record` and `clear`, with the public page-id set changed only after a
 * successful write) and `releaseRejectedIntentFrom` (the raw snapshot key with
 * its targetEntityType normalisation, no storage for an unkeyable record,
 * hand-off before persistence, and unrelated entries retained), over storage
 * mechanisms held in memory. They exist only after the two consumers were given
 * bodies of their own, so this file has NO before-edit run.
 *
 * HOW IT IS BUILT. Seven projects are minted on real disk, once; three hold a
 * corrupt, schema-invalid or oversized intent file. Each project's OWN disk ask
 * records the intent text and whether `.llmwiki` exists, then runs its
 * scenario's STEPS through the real root forms. Each step is settled EXACTLY
 * ONCE, there and only there: a value as its JSON, a refusal as its name and
 * message. The minting directories are removed before any case runs. The memory
 * side runs the same steps through the bound bodies from the disk's own
 * starting state, and its final intent text and `.llmwiki` presence are
 * compared with the copied post-operation tree. The caller's `handOff` hook and
 * the memory mechanisms record into ONE ordered log.
 *
 * WHAT THE MECHANISMS DECIDE. Only physical facts: whether the private
 * directory exists (creating it when asked), the stored text, whether it is
 * over the read cap, and the replacement. Two faults exist only in memory: a
 * replacement that throws, in `record` and in a release. They have no disk twin.
 *
 * NOT SHOWN HERE, AND KEPT LOCAL TO THE DISK MECHANISMS: links, non-regular
 * leaves, an escaping `.llmwiki`, hard links and atomic-write durability. Their
 * regressions stay in `test/review-embedding-intent.test.ts` and the review
 * suites. The embedding retry queue, the review lock and the batch and reject
 * commands are not run here.
 */

import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import {
  openReviewEmbeddingIntent, openReviewEmbeddingIntentFrom, releaseRejectedIntent, releaseRejectedIntentFrom,
  type ReviewEmbeddingIntent, type ReviewEmbeddingIntentStorage,
} from "../../src/commands/review-embedding-intent.js";
import { LLMWIKI_DIR } from "../../src/utils/constants.js";
import type { ReviewCandidate } from "../../src/utils/types.js";
import { mintSeededScenarios, settleInOrder } from "./scenario-mint.js";
import { expectMintingDirectoryRemoved } from "./minted-directory.js";

const PREFIX = "review-embedding-intent-binding-";
const INTENT_REL = `${LLMWIKI_DIR}/review-embedding-intent.json`;
const MEM_DIR = "/memory/project/.llmwiki";
const MAX = 1024 * 1024;
const HUGE = `concepts/${"x".repeat(MAX)}`;
const UNAVAILABLE = "Error: Review embedding intent unavailable; retry after repairing its storage.";
const INVALID = "Error: Invalid review embedding intent; recovery cannot safely continue.";
const EXCEEDS = "Error: Review embedding intent exceeds 1 MiB; finish interrupted batches before continuing.";

/** Only the five snapshot fields matter to the intent; the rest of the record is not read. */
const candidate = (id: string): ReviewCandidate =>
  ({ id, slug: id, title: id, summary: "", sources: [], body: `${id} body`, targetDirectory: "concepts" }) as unknown as ReviewCandidate;
const [A, B, C, T] = ["a-1", "b-2", "c-3", "t-4"].map(candidate) as [ReviewCandidate, ReviewCandidate, ReviewCandidate, ReviewCandidate];
const rawOf = (record: ReviewCandidate, extra: object = {}): Buffer => Buffer.from(JSON.stringify({ ...record, ...extra }));

/** The two consumers, by root on disk or bound in memory. */
interface Api {
  open(candidates: ReviewCandidate[]): Promise<ReviewEmbeddingIntent>;
  release(bytes: Buffer, handOff: (pageIds: string[]) => Promise<void>): Promise<void>;
}
/** Sessions opened by earlier steps, by name. */
type Sessions = Record<string, ReviewEmbeddingIntent>;
type Step = (api: Api, sessions: Sessions, log: string[]) => Promise<unknown>;
/** The intent text and whether `.llmwiki` exists. */
interface Stored { text: string | null; privateDir: boolean }
interface OnDisk { before: Stored; outcomes: string[]; log: string[] }

const handOffTo = (log: string[]) => async (pageIds: string[]) => { log.push(`handOff ${pageIds.join(",")}`); };
const refusingHandOff = (log: string[]) => async (pageIds: string[]) => { log.push(`handOff ${pageIds.join(",")}`); throw new Error("handoff refused"); };
const ids = (intent: ReviewEmbeddingIntent): string[] => [...intent.pageIds];
const recorded = async (api: Api, sessions: Sessions, name: string, open: ReviewCandidate[], pageIds: string[]) => {
  sessions[name] = await api.open(open);
  await sessions[name]!.record(pageIds);
  return ids(sessions[name]!);
};

const corrupt = (text: string) => ({ seed: { [INTENT_REL]: text }, steps: [(api) => api.open([])] as Step[] });
const SCENARIOS = {
  ownership: { seed: {}, steps: [
    (api, sessions) => recorded(api, sessions, "ab", [A, B], ["concepts/shared"]),
    (api, sessions) => recorded(api, sessions, "c", [C], ["concepts/unrelated"]),
    async (api, sessions) => { sessions.retry = await api.open([B, A]); return ids(sessions.retry); },
    async (_api, sessions) => { await sessions.retry!.clear(); return "cleared"; },
    async (api) => ids(await api.open([A])), async (api) => ids(await api.open([C]))] as Step[] },
  malformed: corrupt("{malformed"),
  schema: corrupt("{\"schemaVersion\":2,\"entries\":[]}"),
  oversize: corrupt("x".repeat(MAX + 1)),
  failedRecord: { seed: {}, steps: [
    (api, sessions) => recorded(api, sessions, "a", [A], ["concepts/first"]),
    (_api, sessions) => sessions.a!.record([HUGE]), async (_api, sessions) => ids(sessions.a!),
    (_api, sessions) => sessions.a!.record(["concepts/second"]), async (_api, sessions) => ids(sessions.a!),
    async (api) => ids(await api.open([A]))] as Step[] },
  release: { seed: {}, steps: [
    (api, sessions) => recorded(api, sessions, "ab", [A, B], ["concepts/ab"]),
    (api, sessions) => recorded(api, sessions, "t", [T], ["concepts/t"]),
    async (api, _sessions, log) => { await api.release(rawOf(A), handOffTo(log)); return "released"; },
    async (api, _sessions, log) => { await api.release(rawOf(T, { targetEntityType: 7 }), handOffTo(log)); return "released"; },
    async (api, _sessions, log) => { await api.release(rawOf(C), handOffTo(log)); return "released"; },
    async (api, _sessions, log) => { await api.release(rawOf(B), refusingHandOff(log)); return "released"; }] as Step[] },
  invalidRaw: { seed: {}, steps: [
    async (api, _sessions, log) => { await api.release(Buffer.from("not json"), handOffTo(log)); return "released"; },
    async (api, _sessions, log) => { await api.release(Buffer.from("[1]"), handOffTo(log)); return "released"; }] as Step[] },
};
type Name = keyof typeof SCENARIOS;

/** Run a scenario's steps in order, settling each exactly once; `log` is the one sink the hook (and, in memory, the mechanisms) record into. */
async function runSteps(name: Name, api: Api, log: string[] = []): Promise<{ outcomes: string[]; log: string[] }> {
  const sessions: Sessions = {};
  const outcomes = await settleInOrder(SCENARIOS[name].steps, (step) => step(api, sessions, log));
  return { outcomes, log };
}

/** What the disk holds: the intent text, and whether `.llmwiki` exists. */
async function storedOnDisk(root: string): Promise<Stored> {
  const text = await readFile(path.join(root, INTENT_REL), "utf8").catch(() => null);
  const privateDir = await stat(path.join(root, LLMWIKI_DIR)).then((found) => found.isDirectory(), () => false);
  return { text, privateDir };
}

const minted = mintSeededScenarios(PREFIX, SCENARIOS, async (root, name): Promise<OnDisk> => {
    const before = await storedOnDisk(root);
    const api: Api = { open: (open) => openReviewEmbeddingIntent(root, open), release: (bytes, handOff) => releaseRejectedIntent(root, bytes, handOff) };
    return { before, ...(await runSteps(name, api)) };
  });

/** Faults with no disk twin: the replacement throws. */
interface Faults { replaceThrows?: boolean }

/** Storage mechanisms over `stored`; every call is recorded to `log` first. */
function memoryStorageOf(stored: Stored, log: string[], faults: Faults = {}): ReviewEmbeddingIntentStorage {
  const leaf = (directory: string, file: string): string => path.posix.relative(directory, file);
  return {
    privateDirectory: async () => { log.push("dir"); stored.privateDir = true; return MEM_DIR; },
    readLeafText: async (directory, file, maxBytes) => {
      log.push(`read ${leaf(directory, file)} ${maxBytes}`);
      if (stored.text === null) return { kind: "absent" };
      return Buffer.byteLength(stored.text, "utf8") > maxBytes ? { kind: "unavailable" } : { kind: "ok", body: stored.text };
    },
    replaceLeaf: async (directory, file, body) => {
      log.push(`replace ${leaf(directory, file)}`);
      if (faults.replaceThrows) throw new Error("EIO: replace failed");
      stored.text = body;
    },
  };
}

/** Run one scenario in memory from the disk's own starting state. */
async function inMemory(name: Name) {
  const stored: Stored = { ...minted[name]!.onDisk.before };
  const log: string[] = [];
  const storage = memoryStorageOf(stored, log);
  const api: Api = { open: (open) => openReviewEmbeddingIntentFrom(storage, open), release: (bytes, handOff) => releaseRejectedIntentFrom(storage, bytes, handOff) };
  const { outcomes } = await runSteps(name, api, log);
  return { outcomes, log, stored };
}

/** Run `name` in memory and require the disk's outcomes, hook calls, final intent text and `.llmwiki` presence. */
async function expectDiskParity(name: Name) {
  const run = await inMemory(name);
  const one = minted[name]!;
  expect([run.outcomes, run.log.filter((call) => call.startsWith("handOff"))]).toEqual([one.onDisk.outcomes, one.onDisk.log]);
  expect(run.stored).toEqual({ text: one.copy.files.get(INTENT_REL) ?? null, privateDir: one.copy.listings.has(LLMWIKI_DIR) });
  return run;
}

const READ = "read review-embedding-intent.json 1048576";
const REPLACE = "replace review-embedding-intent.json";
const parsed = (text: string | null): { candidates: string[]; pageIds: string[] }[] => JSON.parse(text!).entries;

describe("the review embedding intent over copied projects, with every minting directory gone", () => {
  it("E1 runs after every minting directory was removed", () => {
    for (const one of Object.values(minted)) expectMintingDirectoryRemoved(one!.dir, PREFIX);
  });

  it("E2 selects, merges and clears by snapshot ownership across a reordered retry, writing the disk's exact bytes", async () => {
    const { outcomes, log, stored } = await expectDiskParity("ownership");
    expect(outcomes).toEqual(["[\"concepts/shared\"]", "[\"concepts/unrelated\"]", "[\"concepts/shared\"]", "\"cleared\"", "[]", "[\"concepts/unrelated\"]"]);
    expect(log).toEqual(["dir", READ, REPLACE, "dir", READ, REPLACE, "dir", READ, REPLACE, "dir", READ, "dir", READ]);
    expect(parsed(stored.text).map((entry) => entry.pageIds)).toEqual([["concepts/unrelated"]]);
  });

  it.each(["malformed", "schema", "oversize"] as const)("E3 fails closed on %s intent, leaving it untouched, as the disk did", async (name) => {
    const { outcomes, log, stored } = await expectDiskParity(name);
    expect([outcomes, log, stored.text]).toEqual([[name === "oversize" ? UNAVAILABLE : INVALID], ["dir", READ], minted[name]!.onDisk.before.text]);
  });

  it("E4 keeps the public page ids and the durable record after a failed record, whose ids stay owned for the retry, as the disk did", async () => {
    const { outcomes, log, stored } = await expectDiskParity("failedRecord");
    expect(outcomes).toEqual(["[\"concepts/first\"]", EXCEEDS, "[\"concepts/first\"]", EXCEEDS, "[\"concepts/first\"]", "[\"concepts/first\"]"]);
    expect([log, parsed(stored.text)[0]!.pageIds]).toEqual([["dir", READ, REPLACE, "dir", READ], ["concepts/first"]]);
  });

  it("E5 hands work off before persisting, normalises the raw key, keeps unrelated entries, and keeps intent when the hand-off throws, as the disk did", async () => {
    const { outcomes, log, stored } = await expectDiskParity("release");
    expect(outcomes.slice(2)).toEqual(["\"released\"", "\"released\"", "\"released\"", "Error: handoff refused"]);
    expect(log.slice(6)).toEqual(["dir", READ, "handOff concepts/ab", REPLACE, "dir", READ, "handOff concepts/t", REPLACE,
      "dir", READ, "dir", READ, "handOff concepts/ab"]);
    expect(parsed(stored.text).map((entry) => [entry.candidates.length, entry.pageIds])).toEqual([[1, ["concepts/ab"]]]);
  });

  it("E6 releases an unkeyable record without touching storage: no private directory on disk, no mechanism call in memory", async () => {
    const { outcomes, log, stored } = await expectDiskParity("invalidRaw");
    expect([outcomes, log, stored]).toEqual([["\"released\"", "\"released\""], [], { text: null, privateDir: false }]);
  });

  it("E7 keeps durable intent and the public ids when a replacement throws, in a record and in a release (memory only)", async () => {
    const log: string[] = [];
    const stored: Stored = { text: null, privateDir: false };
    const intent = await openReviewEmbeddingIntentFrom(memoryStorageOf(stored, log, { replaceThrows: true }), [A]);
    await expect(intent.record(["concepts/first"])).rejects.toThrow("EIO: replace failed");
    expect([ids(intent), stored.text]).toEqual([[], null]);
    const held = await openReviewEmbeddingIntentFrom(memoryStorageOf(stored, log), [A]);
    await held.record(["concepts/a"]);
    const before = stored.text;
    await expect(releaseRejectedIntentFrom(memoryStorageOf(stored, log, { replaceThrows: true }), rawOf(A), handOffTo(log))).rejects.toThrow("EIO");
    expect([stored.text, log.slice(-2)]).toEqual([before, ["handOff concepts/a", REPLACE]]);
  });
});
