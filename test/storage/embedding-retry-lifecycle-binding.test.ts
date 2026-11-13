/**
 * @file test/storage/embedding-retry-lifecycle-binding.test.ts
 * @description The embedding retry LIFECYCLE, WHOLE, over marker storage held in
 * memory: `loadEmbeddingRetryFrom` (the full drain's fail-open reads),
 * `loadScopedEmbeddingRetryFrom` and `unrecordableScopedIdsFrom` (the scoped
 * refusal on an unreadable marker), `queueScopedEmbeddingRetryFrom`, and the
 * retry they return: `recordPending` before any request, `prepare` with its
 * content-hash admissions, pre-charges, quarantine release and verified write,
 * the recorder, and `settle` exactly once, with retirement durable before a
 * page leaves pending. These bodies exist only after the lifecycle was given
 * storage of its own, so this file has NO before-edit run.
 *
 * HOW IT IS BUILT. Four projects are minted on real disk, once, each seeded
 * with its own markers. Each project's OWN disk ask records whether `.llmwiki`
 * exists and both markers' text, then runs its scenario's STEPS through the
 * real root forms. Each step is observed EXACTLY ONCE, there and only there:
 * its outcome settled once (a value as its JSON, a refusal as its name and
 * message) and its status lines captured, with the spy restored after every
 * step. The minting directories are removed before any case runs. The memory
 * side runs the same steps through the bound bodies from the disk's own
 * starting state, and its final directory presence and marker bytes are
 * compared with the copied tree. No provider is called: a step drives the
 * attempt recorder as the core would.
 *
 * WHAT THE MECHANISMS DECIDE. Only physical facts: whether the private
 * directory exists, each marker's stored text and whether it is over the read
 * cap, the replacement and the unlink. Their ordered call log is MEMORY ONLY.
 * Every injected fault is memory-only too, with no disk twin: a swallowed
 * replacement of one marker or of both.
 *
 * NOT SHOWN HERE, AND KEPT LOCAL TO THE DISK MECHANISMS AND THE INCUMBENT
 * SUITES: links, escapes, read-only directories, the provider run, the refresh
 * that drives this lifecycle, the review commands that queue into it, and the
 * caller's lock.
 */

import path from "node:path";
import { describe, expect, it } from "bun:test";
import {
  loadEmbeddingRetry, loadEmbeddingRetryFrom, loadScopedEmbeddingRetry, loadScopedEmbeddingRetryFrom,
  queueScopedEmbeddingRetry, queueScopedEmbeddingRetryFrom, unrecordableScopedIds, unrecordableScopedIdsFrom,
  type EmbeddingMarkerStorage,
} from "../../src/utils/embeddings-retry.js";
import { LLMWIKI_DIR, MAX_PENDING_EMBEDDINGS_BYTES, MAX_PENDING_EMBEDDING_IDS, PENDING_EMBEDDINGS_FILE, QUARANTINED_EMBEDDINGS_FILE } from "../../src/utils/constants.js";
import { enoent } from "./copied-project.js";
import { expectMarkerParity, markersOnDisk, observeStatus, type Observed, type StoredMarkers as Stored } from "./embedding-binding-doubles.js";
import { mintSeededScenarios } from "./scenario-mint.js";
import { expectMintingDirectoryRemoved } from "./minted-directory.js";

const PREFIX = "embedding-retry-lifecycle-binding-";
const MEM_DIR = "/memory/project/.llmwiki";
const MARKERS = [PENDING_EMBEDDINGS_FILE, QUARANTINED_EMBEDDINGS_FILE] as const;
const [H1, H2] = ["1111111111111111", "2222222222222222"];
const id = (name: string): string => `concepts/${name}`;
const marker = (entries: object[]): string => JSON.stringify(entries);
const CAPACITY = marker(Array.from({ length: MAX_PENDING_EMBEDDING_IDS }, (_, at) => ({ pageId: id(`p-${at}`), attempts: 1 })));
const UNAVAILABLE = "Error: Embedding retry state unavailable; scoped refresh cannot preserve unrelated entries.";

type Retry = Awaited<ReturnType<typeof loadEmbeddingRetry>>;
/** The four lifecycle entries, by root on disk or bound in memory. */
interface Api {
  drain(ids: string[]): Promise<Retry>;
  scoped(ids: string[]): Promise<Retry>;
  unrecordable(ids: string[]): Promise<string[]>;
  queue(ids: string[]): Promise<string[]>;
}
/** The retry a step loaded, shared with the later steps. */
interface Context { retry?: Retry }
type Step = (api: Api, context: Context) => Promise<unknown>;
interface OnDisk { before: Stored; observed: Observed[] }

const load = (ids: string[]): Step => async (api, context) => { context.retry = await api.drain(ids); return context.retry.pageIds; };
const record: Step = async (_api, context) => {
  await context.retry!.recordPending();
  return { pageIds: context.retry!.pageIds, deferred: context.retry!.deferred };
};
const prepare = (hashes: Record<string, string>): Step => (_api, context) =>
  context.retry!.prepare(Object.keys(hashes), new Map(Object.entries(hashes)));
/** Drive the recorder as the core would: every id sent, the given ones failed in the last request. */
const attempt = (ids: string[], failed: string[]): Step => async (_api, context) => {
  const observer = context.retry!.recorder.observe((index) => ids[index]);
  observer.sending(ids.map((_, index) => index));
  observer.failed(failed.map((one) => ids.indexOf(one)));
  return context.retry!.recorder.outcome().kind;
};
const settle = (eligible: string[]): Step => async (_api, context) => {
  await context.retry!.settle({ embedded: [], eligible, pruned: [] });
  return "settled";
};

const DRAIN_STEPS: Step[] = [load([id("c")]), record, prepare({ [id("c")]: H2, [id("a")]: H2, [id("b")]: H1, [id("q")]: H1 }),
  attempt([id("c"), id("a"), id("b")], [id("a")]), settle([id("c"), id("a"), id("b")]), settle([id("c"), id("a"), id("b")])];
const RELEASE_STEPS: Step[] = [load([id("q")]), record, prepare({ [id("q")]: H2, [id("x")]: H1 }),
  attempt([id("x"), id("q")], [id("x")]), settle([id("q"), id("x")])];

const SCENARIOS = {
  drain: { seed: { [PENDING_EMBEDDINGS_FILE]: marker([{ pageId: id("a"), attempts: 0 }, { pageId: id("b"), attempts: 2, contentHash: H1 }]),
    [QUARANTINED_EMBEDDINGS_FILE]: marker([{ pageId: id("q"), attempts: 5, contentHash: H1 }]) }, steps: DRAIN_STEPS },
  release: { seed: { [PENDING_EMBEDDINGS_FILE]: marker([{ pageId: id("x"), attempts: 4, contentHash: H1 }]),
    [QUARANTINED_EMBEDDINGS_FILE]: marker([{ pageId: id("q"), attempts: 5, contentHash: H1 }]) }, steps: RELEASE_STEPS },
  unreadable: { seed: { [PENDING_EMBEDDINGS_FILE]: "{bad" }, steps: [(api) => api.scoped([id("a")]), (api) => api.unrecordable([id("a")]),
    (api) => api.queue([id("a")]), load([id("a")]), record] as Step[] },
  capacity: { seed: { [PENDING_EMBEDDINGS_FILE]: CAPACITY, [QUARANTINED_EMBEDDINGS_FILE]: marker([{ pageId: id("q"), attempts: 5, contentHash: H1 }]) },
    steps: [(api) => api.unrecordable([id("p-0"), id("new"), id("q")]), (api) => api.queue([id("new"), id("p-0")])] as Step[] },
};
type Name = keyof typeof SCENARIOS;

/** Run steps in order, observing each once; in memory, `log` also marks where each step began. */
async function runSteps(steps: Step[], api: Api, log?: string[]): Promise<{ observed: Observed[]; context: Context }> {
  const context: Context = {};
  const observed: Observed[] = [];
  for (const [at, step] of steps.entries()) {
    log?.push(`step ${at + 1}`);
    observed.push(await observeStatus(() => step(api, context)));
  }
  return { observed, context };
}

const minted = mintSeededScenarios(PREFIX, SCENARIOS, async (root, name): Promise<OnDisk> => {
    const before = await markersOnDisk(root, MARKERS);
    const api: Api = { drain: (ids) => loadEmbeddingRetry(root, ids), scoped: (ids) => loadScopedEmbeddingRetry(root, ids),
      unrecordable: (ids) => unrecordableScopedIds(root, ids), queue: (ids) => queueScopedEmbeddingRetry(root, ids) };
    return { before, observed: (await runSteps(SCENARIOS[name].steps, api)).observed };
  });

/** Faults with no disk twin: replacements of the named markers are refused with a plain error, which the writer swallows. */
interface Faults { replaceFails?: Set<string> }

/** Marker storage over `stored`; every call is recorded to `log` first. */
function memoryStorageOf(stored: Stored, log: string[], faults: Faults = {}): EmbeddingMarkerStorage {
  const relOf = (leaf: string): string => path.posix.join(LLMWIKI_DIR, path.posix.relative(MEM_DIR, leaf));
  return {
    readMarkerText: async (markerFile) => {
      log.push(`read ${markerFile}`);
      const text = stored.privateDir ? stored.files[markerFile] : undefined;
      if (text === undefined) return { kind: "absent" };
      return Buffer.byteLength(text, "utf8") > MAX_PENDING_EMBEDDINGS_BYTES ? { kind: "unavailable" } : { kind: "ok", body: text };
    },
    createPrivateDir: async () => { log.push("create"); stored.privateDir = true; return MEM_DIR; },
    existingPrivateDir: async () => { log.push("existing"); return stored.privateDir ? MEM_DIR : null; },
    replaceLeaf: async (_confineRoot, leaf, body) => {
      log.push(`replace ${relOf(leaf)}`);
      if (faults.replaceFails?.has(relOf(leaf))) throw new Error("replace refused");
      stored.files[relOf(leaf)] = body;
    },
    removeLeaf: async (leaf) => {
      log.push(`remove ${relOf(leaf)}`);
      if (!(relOf(leaf) in stored.files)) throw enoent();
      delete stored.files[relOf(leaf)];
    },
  };
}

/** The four bound bodies over one storage. */
const memoryApi = (storage: EmbeddingMarkerStorage): Api => ({
  drain: (ids) => loadEmbeddingRetryFrom(storage, ids), scoped: (ids) => loadScopedEmbeddingRetryFrom(storage, ids),
  unrecordable: (ids) => unrecordableScopedIdsFrom(storage, ids), queue: (ids) => queueScopedEmbeddingRetryFrom(storage, ids),
});

/** A fresh memory copy of the disk's starting state for `name`. */
const startOf = (name: Name): Stored => ({ privateDir: minted[name]!.onDisk.before.privateDir, files: { ...minted[name]!.onDisk.before.files } });

/** Run `name` in memory and require the disk's observations, directory and marker bytes. */
async function expectDiskParity(name: Name) {
  const stored = startOf(name);
  const log: string[] = [];
  const { observed } = await runSteps(SCENARIOS[name].steps, memoryApi(memoryStorageOf(stored, log)), log);
  expectMarkerParity(minted[name]!, observed, stored, MARKERS);
  return { observed, log, stored };
}

const outcomes = (observed: Observed[]): string[] => observed.map((one) => one.outcome);
const after = (log: string[], step: number): string[] => log.slice(log.indexOf(`step ${step}`) + 1);
const QUARANTINED = (pageId: string) => `! Quarantined pending embedding for ${pageId} after 5 failed refresh attempt(s); ` +
  "it will not be retried until its content changes. After fixing the provider, reset its retry entries to re-queue it.";

describe("the embedding retry lifecycle over copied projects, with every minting directory gone", () => {
  it("L1 runs after every minting directory was removed", () => {
    for (const one of Object.values(minted)) expectMintingDirectoryRemoved(one!.dir, PREFIX);
  });

  it("L2 drains: records before preparing, pre-charges by content hash, excludes unchanged quarantine, settles once, as the disk did", async () => {
    const { observed, log, stored } = await expectDiskParity("drain");
    expect(outcomes(observed)).toEqual([JSON.stringify([id("c"), id("a"), id("b")]), JSON.stringify({ pageIds: [id("c"), id("b"), id("a")], deferred: [] }),
      JSON.stringify([id("c"), id("a"), id("b")]), "\"request-failed\"", "\"settled\"", "\"settled\""]);
    expect(JSON.parse(stored.files[PENDING_EMBEDDINGS_FILE]!)).toEqual([{ pageId: id("b"), attempts: 2, contentHash: H1 },
      { pageId: id("c"), attempts: 0, contentHash: H2 }, { pageId: id("a"), attempts: 1, contentHash: H2 }]);
    expect([stored.files[QUARANTINED_EMBEDDINGS_FILE], after(log, 6)]).toEqual([minted.drain!.onDisk.before.files[QUARANTINED_EMBEDDINGS_FILE], []]);
  });

  it("L3 releases changed quarantined content, then retires an exhausted page durably before it leaves pending, as the disk did", async () => {
    const { observed, stored } = await expectDiskParity("release");
    expect(outcomes(observed).slice(2)).toEqual([JSON.stringify([id("x"), id("q")]), "\"request-failed\"", "\"settled\""]);
    expect(observed[4]!.lines).toEqual([QUARANTINED(id("x"))]);
    expect(stored.files).toEqual({ [PENDING_EMBEDDINGS_FILE]: marker([{ pageId: id("q"), attempts: 0, contentHash: H2 }]),
      [QUARANTINED_EMBEDDINGS_FILE]: marker([{ pageId: id("x"), attempts: 5, contentHash: H1 }]) });
  });

  it("L4 refuses every scoped entry on an unreadable marker while the full drain reads fail-open and overwrites it, as the disk did", async () => {
    const { observed, stored } = await expectDiskParity("unreadable");
    expect(outcomes(observed)).toEqual([UNAVAILABLE, UNAVAILABLE, UNAVAILABLE, JSON.stringify([id("a")]), JSON.stringify({ pageIds: [id("a")], deferred: [] })]);
    expect(stored.files[PENDING_EMBEDDINGS_FILE]).toBe(marker([{ pageId: id("a"), attempts: 0 }]));
  });

  it("L5 defers a scoped page the full marker cannot hold, keeping every existing budget byte for byte, as the disk did", async () => {
    const { observed, stored } = await expectDiskParity("capacity");
    expect(outcomes(observed)).toEqual([JSON.stringify([id("new")]), JSON.stringify([id("new")])]);
    expect(stored.files[PENDING_EMBEDDINGS_FILE]).toBe(CAPACITY);
  });

  it("L6 never admits work whose charge did not persist, and refuses a settlement it cannot verify, once (memory only)", async () => {
    const unpersisted = startOf("drain");
    const unpersistedRun = await runSteps(DRAIN_STEPS.slice(0, 3), memoryApi(memoryStorageOf(unpersisted, [], { replaceFails: new Set([PENDING_EMBEDDINGS_FILE]) })));
    expect([unpersistedRun.observed[2]!.outcome, unpersistedRun.context.retry!.deferred]).toEqual(["[]", [id("a"), id("b"), id("c")]]);
    // Prepared and attempted normally; then the pending marker stops persisting, so settlement cannot verify.
    const faults: Faults = {};
    const log: string[] = [];
    const api = memoryApi(memoryStorageOf(startOf("drain"), log, faults));
    const settlementContext = (await runSteps(DRAIN_STEPS.slice(0, 4), api)).context;
    faults.replaceFails = new Set([PENDING_EMBEDDINGS_FILE]);
    const first = await observeStatus(() => settle([id("c"), id("a"), id("b")])(api, settlementContext));
    const marked = log.length;
    const second = await observeStatus(() => settle([id("c"), id("a"), id("b")])(api, settlementContext));
    expect([first.outcome, second.outcome, log.length - marked]).toEqual(["Error: Embedding retry state could not be settled; attempt counts may be stale.", "\"settled\"", 0]);
  });

  it("L7 keeps an exhausted page in pending, with no warning, when its quarantine record does not persist (memory only)", async () => {
    const stored = startOf("release");
    const { observed } = await runSteps(RELEASE_STEPS, memoryApi(memoryStorageOf(stored, [], { replaceFails: new Set([QUARANTINED_EMBEDDINGS_FILE]) })));
    expect([observed[4]!.outcome, observed[4]!.lines]).toEqual(["\"settled\"", []]);
    expect(stored.files).toEqual({ [PENDING_EMBEDDINGS_FILE]: marker([{ pageId: id("q"), attempts: 0, contentHash: H2 }, { pageId: id("x"), attempts: 5, contentHash: H1 }]) });
  });
});
