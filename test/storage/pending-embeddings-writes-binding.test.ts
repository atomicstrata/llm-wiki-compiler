/**
 * @file test/storage/pending-embeddings-writes-binding.test.ts
 * @description The pending-embedding marker WRITERS, WHOLE:
 * `writePendingEmbeddingsStrictFrom` (normalize, CREATE the private directory
 * even for an empty set, an empty set through the best-effort clear, every
 * other failure propagated), `writePendingEmbeddingsFrom` (an empty set straight
 * to the clear with no directory created, a swallowed resolver failure, and the
 * one errno-discriminated warning) and `clearPendingEmbeddingsFrom` (never
 * creating the directory, every failure a no-op), over mechanisms held in
 * memory. They exist only after the three writers were given bodies of their
 * own, so this file has NO before-edit run.
 *
 * HOW IT IS BUILT. Five projects are minted on real disk, once; one already
 * holds both markers. Each project's OWN disk ask records whether `.llmwiki`
 * exists and both markers' text, then runs its scenario's STEPS through the
 * real root forms. Each step is observed EXACTLY ONCE, there and only there:
 * its outcome settled once (a value as its JSON, a refusal as its name and
 * message) and its status lines captured, with the spy restored after every
 * step. The minting directories are removed before any case runs. The memory
 * side runs the same steps through the bound bodies from the disk's own
 * starting state, recording its mechanism calls into ONE ordered log, and its
 * final directory presence and marker bytes are compared with the copied tree.
 *
 * WHAT THE MECHANISMS DECIDE. Only physical facts: whether the private
 * directory exists (created when asked), the stored marker text, the
 * replacement and the unlink, including that unlinking an absent leaf fails.
 * Every injected fault is MEMORY ONLY with no disk twin here: resolver,
 * replace and unlink rejections, and an errno-coded replace failure.
 *
 * NOT SHOWN HERE, AND KEPT LOCAL TO THE DISK MECHANISMS: an escaping or
 * symlinked `.llmwiki`, a symlinked marker leaf, a read-only directory and the
 * temp-file-then-rename write. Their regressions stay in
 * `test/pending-embeddings.test.ts`. The retry lifecycle and the operation
 * executor that call these writers are not run here.
 */

import path from "node:path";
import { describe, expect, it } from "bun:test";
import {
  clearPendingEmbeddings, clearPendingEmbeddingsFrom, writePendingEmbeddings, writePendingEmbeddingsFrom,
  writePendingEmbeddingsStrict, writePendingEmbeddingsStrictFrom, type EmbeddingMarkerWrites,
} from "../../src/utils/pending-embeddings.js";
import { LLMWIKI_DIR, MAX_PENDING_EMBEDDING_IDS, PENDING_EMBEDDINGS_FILE, QUARANTINED_EMBEDDINGS_FILE } from "../../src/utils/constants.js";
import { enoent } from "./copied-project.js";
import { expectMarkerParity, markersOnDisk, observeStatus, type Observed, type StoredMarkers as Stored } from "./embedding-binding-doubles.js";
import { mintSeededScenarios } from "./scenario-mint.js";
import { expectMintingDirectoryRemoved } from "./minted-directory.js";

const PREFIX = "pending-embeddings-writes-binding-";
const MEM_DIR = "/memory/project/.llmwiki";
const MARKERS = [PENDING_EMBEDDINGS_FILE, QUARANTINED_EMBEDDINGS_FILE] as const;
/** Legacy strings, a forged path, bad shapes, and duplicates: the most attempts wins, a tie keeps the hash-bound entry. */
const MIXED: unknown[] = [
  "concepts/a", { pageId: "concepts/a", attempts: 3 }, { pageId: "concepts/b", attempts: 2, contentHash: "0123456789abcdef" },
  { pageId: "concepts/b", attempts: 2 }, "../../etc", { pageId: 5 }, { pageId: "concepts/c", attempts: -1, ineligible: true },
];
const OVER_COUNT = Array.from({ length: MAX_PENDING_EMBEDDING_IDS + 3 }, (_, at) => ({ pageId: `concepts/p-${at}`, attempts: 0 }));
const QUARANTINE = [{ pageId: "concepts/q", attempts: 5, contentHash: "fedcba9876543210" }];

/** The three writers, by root on disk or bound in memory. */
interface Api {
  strict(entries: unknown[]): Promise<void>;
  write(entries: unknown[], markerFile?: (typeof MARKERS)[number]): Promise<void>;
  clear(markerFile?: (typeof MARKERS)[number]): Promise<void>;
}
type Step = (api: Api) => Promise<unknown>;
interface OnDisk { before: Stored; observed: Observed[] }

const SCENARIOS = {
  normalize: { seed: {}, steps: [(api) => api.write(MIXED), (api) => api.write(QUARANTINE, QUARANTINED_EMBEDDINGS_FILE)] as Step[] },
  countCap: { seed: {}, steps: [(api) => api.strict(OVER_COUNT)] as Step[] },
  strictEmpty: { seed: {}, steps: [(api) => api.strict([])] as Step[] },
  bestEffortEmpty: { seed: {}, steps: [(api) => api.write([]), (api) => api.clear()] as Step[] },
  clear: { seed: { [PENDING_EMBEDDINGS_FILE]: "[\"concepts/old\"]", [QUARANTINED_EMBEDDINGS_FILE]: JSON.stringify(QUARANTINE) },
    steps: [(api) => api.clear(), (api) => api.clear(), (api) => api.strict(MIXED), (api) => api.strict([]),
      (api) => api.write([], QUARANTINED_EMBEDDINGS_FILE)] as Step[] },
};
type Name = keyof typeof SCENARIOS;

/** Run a scenario's steps in order, observing each once. */
async function runSteps(name: Name, api: Api): Promise<Observed[]> {
  const observed: Observed[] = [];
  for (const step of SCENARIOS[name].steps) observed.push(await observeStatus(() => step(api)));
  return observed;
}

const minted = mintSeededScenarios(PREFIX, SCENARIOS, async (root, name): Promise<OnDisk> => {
    const before = await markersOnDisk(root, MARKERS);
    const api: Api = {
      strict: (entries) => writePendingEmbeddingsStrict(root, entries as never),
      write: (entries, markerFile) => writePendingEmbeddings(root, entries as never, markerFile),
      clear: (markerFile) => clearPendingEmbeddings(root, markerFile),
    };
    return { before, observed: await runSteps(name, api) };
  });

/** Faults with no disk twin: each mechanism may reject. */
interface Faults { create?: Error; existing?: Error; replace?: Error; remove?: Error }

/** Writer mechanisms over `stored`; every call, with its exact arguments, is recorded to `log` first. */
function memoryWritesOf(stored: Stored, log: string[], faults: Faults = {}): EmbeddingMarkerWrites {
  const relOf = (leaf: string): string => path.posix.join(LLMWIKI_DIR, path.posix.relative(MEM_DIR, leaf));
  return {
    createPrivateDir: async () => { log.push("create"); if (faults.create) throw faults.create; stored.privateDir = true; return MEM_DIR; },
    existingPrivateDir: async () => { log.push("existing"); if (faults.existing) throw faults.existing; return stored.privateDir ? MEM_DIR : null; },
    replaceLeaf: async (confineRoot, leaf, body) => {
      log.push(`replace ${confineRoot} ${leaf}`);
      if (faults.replace) throw faults.replace;
      stored.files[relOf(leaf)] = body;
    },
    removeLeaf: async (leaf) => {
      log.push(`remove ${leaf}`);
      if (faults.remove) throw faults.remove;
      if (!(relOf(leaf) in stored.files)) throw enoent();
      delete stored.files[relOf(leaf)];
    },
  };
}

/** The three bound bodies over one set of memory mechanisms. */
const memoryApi = (writes: EmbeddingMarkerWrites): Api => ({
  strict: (entries) => writePendingEmbeddingsStrictFrom(writes, entries as never),
  write: (entries, markerFile) => writePendingEmbeddingsFrom(writes, entries as never, markerFile),
  clear: (markerFile) => clearPendingEmbeddingsFrom(writes, markerFile),
});

/** Run `name` in memory from the disk's own starting state and require the disk's observations, directory and bytes. */
async function expectDiskParity(name: Name) {
  const before = minted[name]!.onDisk.before;
  const stored: Stored = { privateDir: before.privateDir, files: { ...before.files } };
  const log: string[] = [];
  const observed = await runSteps(name, memoryApi(memoryWritesOf(stored, log)));
  expectMarkerParity(minted[name]!, observed, stored, MARKERS);
  return { observed, log, stored };
}

const PENDING_LEAF = `${MEM_DIR}/pending-embeddings.json`;
const QUARANTINE_LEAF = `${MEM_DIR}/quarantined-embeddings.json`;
const REPLACE_PENDING = `replace /memory/project ${PENDING_LEAF}`;
const QUIET = { outcome: "undefined", lines: [] };

describe("the pending-embedding marker writers over copied projects, with every minting directory gone", () => {
  it("W1 runs after every minting directory was removed", () => {
    for (const one of Object.values(minted)) expectMintingDirectoryRemoved(one!.dir, PREFIX);
  });

  it("W2 normalizes legacy, forged and duplicate entries into the disk's exact pending and quarantine bytes", async () => {
    const { log, stored } = await expectDiskParity("normalize");
    expect(JSON.parse(stored.files[PENDING_EMBEDDINGS_FILE]!)).toEqual([{ pageId: "concepts/a", attempts: 3 },
      { pageId: "concepts/b", attempts: 2, contentHash: "0123456789abcdef" }, { pageId: "concepts/c", attempts: 0, ineligible: true }]);
    expect(log).toEqual(["create", REPLACE_PENDING, "create", `replace /memory/project ${QUARANTINE_LEAF}`]);
  });

  it("W3 caps the strict write to the id count, keeping the head, as the disk did", async () => {
    const { stored } = await expectDiskParity("countCap");
    const kept = JSON.parse(stored.files[PENDING_EMBEDDINGS_FILE]!) as { pageId: string }[];
    expect([kept.length, kept[0]!.pageId, kept.at(-1)!.pageId]).toEqual([MAX_PENDING_EMBEDDING_IDS, "concepts/p-0", `concepts/p-${MAX_PENDING_EMBEDDING_IDS - 1}`]);
  });

  it("W4 creates the private directory for an empty strict write but not for an empty best-effort write, as the disk did", async () => {
    const strict = await expectDiskParity("strictEmpty");
    const bestEffort = await expectDiskParity("bestEffortEmpty");
    expect([strict.log, strict.stored.privateDir]).toEqual([["create", "existing", `remove ${PENDING_LEAF}`], true]);
    expect([bestEffort.log, bestEffort.stored.privateDir, bestEffort.observed]).toEqual([["existing", "existing"], false, [QUIET, QUIET]]);
  });

  it("W5 clears only the chosen marker, tolerates an absent one, and strict-writes then strict-clears, as the disk did", async () => {
    const { log, stored } = await expectDiskParity("clear");
    expect(log).toEqual(["existing", `remove ${PENDING_LEAF}`, "existing", `remove ${PENDING_LEAF}`, "create", REPLACE_PENDING,
      "create", "existing", `remove ${PENDING_LEAF}`, "existing", `remove ${QUARANTINE_LEAF}`]);
    expect(stored.files).toEqual({});
  });

  it("W6 propagates strict resolver and replace failures, and swallows the strict-empty clear's (memory only)", async () => {
    const cases: [Faults, unknown[], string, string[]][] = [
      [{ create: new Error("escape") }, MIXED, "Error: escape", ["create"]],
      [{ replace: Object.assign(new Error("EACCES: denied"), { code: "EACCES" }) }, MIXED, "Error: EACCES: denied", ["create", REPLACE_PENDING]],
      [{ existing: new Error("escape") }, [], "undefined", ["create", "existing"]],
      [{ remove: new Error("EIO: unlink") }, [], "undefined", ["create", "existing", `remove ${PENDING_LEAF}`]],
    ];
    for (const [faults, entries, outcome, calls] of cases) {
      const log: string[] = [];
      const observed = await observeStatus(() => writePendingEmbeddingsStrictFrom(memoryWritesOf({ privateDir: true, files: {} }, log, faults), entries as never));
      expect([observed, log]).toEqual([{ outcome, lines: [] }, calls]);
    }
  });

  it("W7 warns once only for an errno-coded best-effort replace failure, naming the marker; other failures stay quiet (memory only)", async () => {
    const warning = (name: string) => [`! Could not persist the ${name} retry marker (write failed); embedding retry state may be lost.`];
    const coded = () => Object.assign(new Error("ENOSPC: full"), { code: "ENOSPC" });
    const cases: [Faults, (typeof MARKERS)[number], string[]][] = [
      [{ replace: coded() }, PENDING_EMBEDDINGS_FILE, warning("pending-embeddings")],
      [{ replace: coded() }, QUARANTINED_EMBEDDINGS_FILE, warning("quarantined-embeddings")],
      [{ replace: new Error("escapes the root") }, PENDING_EMBEDDINGS_FILE, []],
      [{ create: new Error("escape") }, PENDING_EMBEDDINGS_FILE, []],
    ];
    for (const [faults, markerFile, lines] of cases) {
      const observed = await observeStatus(() => writePendingEmbeddingsFrom(memoryWritesOf({ privateDir: true, files: {} }, [], faults), MIXED as never, markerFile));
      expect(observed).toEqual({ outcome: "undefined", lines });
    }
    for (const faults of [{ existing: new Error("escape") }, { remove: new Error("EIO: unlink") }]) {
      expect(await observeStatus(() => clearPendingEmbeddingsFrom(memoryWritesOf({ privateDir: true, files: {} }, [], faults)))).toEqual(QUIET);
    }
  });
});
