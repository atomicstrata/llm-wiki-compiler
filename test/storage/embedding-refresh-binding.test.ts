/**
 * @file test/storage/embedding-refresh-binding.test.ts
 * @description The embedding REFRESH, WHOLE, over storage held in memory:
 * `refreshEmbeddingsFrom` returns early when disabled, loads the retry (a
 * scoped load refuses an unavailable marker non-fatally, strict mode rethrows),
 * records intent before any provider call, runs the core, settles exactly once
 * and reports. It exists only after the refresh was given a body of its own, so
 * this file has NO before-edit run.
 *
 * HOW IT IS BUILT. Five projects are minted on real disk, once, and each tree is
 * copied BEFORE its disk ask (`mintCopiedBeforeAsk`), because the refresh writes.
 * Each project's OWN disk ask runs its steps through the real root forms and
 * settles each step EXACTLY ONCE: the returned value or the error, the provider
 * calls, and what the private directory then holds (each marker's text, the
 * store's digest, or another entry's kind). The minting directories are removed
 * before any case runs. Before every memory replay the copy is checked LITERALLY
 * against the seed. The memory side then runs the same steps through the bound
 * body, over ONE map that the store's and the markers' reads and writes share, so
 * a later refresh reads what an earlier one wrote.
 *
 * WHAT IS NOT BOUND, AND HOW IT IS HELD STILL. The provider is replaced at its
 * real seam, `getEmbeddingProvider` (fixed vectors, or a failure when the step
 * asks for one), and `fetch` throws. The embedding configuration, including the
 * disable switch and strict mode, is stubbed per step and restored after it; the
 * clock is frozen. No paid inference happens. The caller-held project lock is not
 * taken: the refresh never takes it. The call log is MEMORY ONLY.
 */

import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import { refreshAffectedEmbeddings, refreshEmbeddingsDrainingPending, refreshEmbeddingsFrom, type EmbeddingRefreshSources } from "../../src/utils/embeddings-refresh.js";
import type { EmbeddingRefreshScope } from "../../src/utils/embeddings.js";
import { LLMWIKI_DIR, MAX_PENDING_EMBEDDINGS_BYTES, PENDING_EMBEDDINGS_FILE } from "../../src/utils/constants.js";
import { effectiveProfileOf, enoent, entityScansOf, writeFiles, type Copy } from "./copied-project.js";
import {
  copiedPageReadsOf, restoreClockAfterSuite, privateDirLeaves, privateLeafStoreOf, recordingInto, withEmbeddingEnvironment, type Leaves,
} from "./embedding-binding-doubles.js";
import { expectMintsRemovedThenSeeded, failureText, mintSeededScenarios } from "./scenario-mint.js";

const PREFIX = "embedding-refresh-binding-";
const MEM_ROOT = "/memory/project";
const MEM_DIR = `${MEM_ROOT}/${LLMWIKI_DIR}`;
const AT = "2026-10-12T00:00:00.000Z";
const [ALPHA, BETA, PRIOR] = ["concepts/alpha", "concepts/beta", "concepts/prior"];
const PAGES = {
  "wiki/concepts/alpha.md": "---\ntitle: Alpha\nsummary: First idea\n---\nAlpha body.\n",
  "wiki/concepts/beta.md": "---\ntitle: Beta\nsummary: Second idea\n---\nBeta body.\n",
};
const PRIOR_MARKER = `[{"pageId":"${PRIOR}","attempts":2}]\n`;
const UNAVAILABLE = "Error: Embedding retry state unavailable; scoped refresh cannot preserve unrelated entries.";
const sha = (bytes: string | Uint8Array): string => createHash("sha256").update(bytes).digest("hex").slice(0, 16);

interface Step { scope: EmbeddingRefreshScope; changed: string[]; enabled?: boolean; strict?: boolean; fail?: boolean }
type Refresh = (step: Step) => Promise<unknown>;

const SCENARIOS = {
  drain: { seed: (root: string) => writeFiles(root, PAGES), steps: [{ scope: "drain", changed: [] }, { scope: "drain", changed: [] }] as Step[] },
  scoped: { seed: (root: string) => writeFiles(root, { ...PAGES, [PENDING_EMBEDDINGS_FILE]: PRIOR_MARKER }), steps: [{ scope: "affected-only", changed: [ALPHA] }] as Step[] },
  disabled: { seed: (root: string) => writeFiles(root, { ...PAGES, [PENDING_EMBEDDINGS_FILE]: PRIOR_MARKER }),
    steps: [{ scope: "drain", changed: [ALPHA], enabled: false }] as Step[] },
  unavailable: { seed: async (root: string) => { await writeFiles(root, PAGES); await mkdir(path.join(root, PENDING_EMBEDDINGS_FILE), { recursive: true }); },
    steps: [{ scope: "affected-only", changed: [ALPHA] }, { scope: "affected-only", changed: [ALPHA], strict: true }] as Step[] },
  failure: { seed: (root: string) => writeFiles(root, PAGES), steps: [{ scope: "drain", changed: [], fail: true }, { scope: "drain", changed: [] }] as Step[] },
};
type Name = keyof typeof SCENARIOS;

/** Run steps in order, settling each exactly once, then reading the provider calls and the leaves. */
async function runSteps(steps: Step[], refresh: Refresh, leaves: () => Promise<Leaves>, log: string[] = []): Promise<string[]> {
  const outcomes: string[] = [];
  for (const step of steps) {
    const { calls, record } = recordingInto(log);
    const env = { enabled: step.enabled !== false, strict: step.strict === true, fail: step.fail === true, at: AT, witness: "refresh" };
    const settled = await withEmbeddingEnvironment(env, record, () => refresh(step))
      .then((value) => JSON.stringify(value ?? null), failureText);
    outcomes.push(JSON.stringify({ settled, calls, leaves: await leaves() }));
  }
  return outcomes;
}

/** A leaf as the outcome shows it: a marker's text, the store's digest. */
const shown = (name: string, bytes: Buffer): string => (name.startsWith("embeddings") ? sha(bytes) : bytes.toString("utf-8"));

/** What the real private directory holds. */
const diskLeaves = (root: string): Promise<Leaves> => privateDirLeaves(root, shown);

/** The real root forms, as a project's own callers reach them. */
const diskRefresh = (root: string): Refresh => (step) => (step.scope === "drain"
  ? refreshEmbeddingsDrainingPending(root, step.changed) : refreshAffectedEmbeddings(root, step.changed));

restoreClockAfterSuite();
const minted = mintSeededScenarios(PREFIX, SCENARIOS, (root, name) => runSteps(SCENARIOS[name].steps, diskRefresh(root), () => diskLeaves(root)), true);

/** `name`'s copy, after requiring LITERALLY that its private directory holds the seed: nothing, the prior marker, or a directory in its place. */
function seededCopy(name: Name): Copy {
  const copy = minted[name]!.copy;
  const listing = copy.listings.get(LLMWIKI_DIR)?.map((one) => `${one.name}:${one.kind}`) ?? null;
  const marker = path.posix.basename(PENDING_EMBEDDINGS_FILE);
  const expected = { drain: null, failure: null, scoped: [`${marker}:file`], disabled: [`${marker}:file`], unavailable: [`${marker}:directory`] }[name];
  expect(listing).toEqual(expected);
  if (name === "scoped" || name === "disabled") expect(copy.files.get(PENDING_EMBEDDINGS_FILE)).toBe(PRIOR_MARKER);
  return copy;
}

/** The store's and the markers' raw reads and writes over ONE private directory seeded from `copy`, each call logged. */
function memoryStorageOf(copy: Copy, log: string[]): { writer: Omit<EmbeddingRefreshSources["writer"], "profile" | "live">; markers: EmbeddingRefreshSources["markers"]; leaves: () => Promise<Leaves> } {
  const store = privateLeafStoreOf(copy, log, { prefix: "store.", dir: MEM_DIR });
  const markers: EmbeddingRefreshSources["markers"] = {
    readMarkerText: async (markerFile) => {
      log.push(`marker.read ${path.posix.basename(markerFile)}`);
      const leaf = store.isCreated() ? store.held.get(path.posix.basename(markerFile)) : undefined;
      if (leaf === undefined) return { kind: "absent" };
      return !Buffer.isBuffer(leaf) || leaf.byteLength > MAX_PENDING_EMBEDDINGS_BYTES ? { kind: "unavailable" } : { kind: "ok", body: leaf.toString("utf-8") };
    },
    createPrivateDir: async () => { log.push("marker.create"); store.markCreated(); return MEM_DIR; },
    existingPrivateDir: async () => { log.push("marker.existing"); return store.isCreated() ? MEM_DIR : null; },
    replaceLeaf: async (_confineRoot, leaf, body) => { log.push(`marker.replace ${path.posix.basename(leaf)}`); store.put(path.posix.basename(leaf), body); },
    removeLeaf: async (leaf) => {
      log.push(`marker.remove ${path.posix.basename(leaf)}`);
      if (!store.held.delete(path.posix.basename(leaf))) throw enoent();
    },
  };
  return { writer: { store: store.reads, writes: store.writes }, markers, leaves: () => store.leaves(shown) };
}

/** The bound refresh over one seeded copy, with its shared log and its leaves. */
function memoryRefresh(name: Name, log: string[]): { refresh: Refresh; leaves: () => Promise<Leaves> } {
  const copy = seededCopy(name);
  const storage = memoryStorageOf(copy, log);
  const note = (call: string) => { log.push(`profile ${call}`); };
  const sources: EmbeddingRefreshSources = { markers: storage.markers,
    writer: { ...storage.writer, profile: effectiveProfileOf(copy, note), live: { pages: copiedPageReadsOf(copy, MEM_ROOT), entities: entityScansOf(copy, MEM_ROOT, note) } } };
  // A drain's root form returns nothing, so its result is dropped here too; affected-only returns the boolean.
  const refresh: Refresh = (step) => (step.scope === "drain"
    ? refreshEmbeddingsFrom(sources, step.changed, step.scope).then(() => undefined) : refreshEmbeddingsFrom(sources, step.changed, step.scope));
  return { refresh, leaves: storage.leaves };
}

/** Run `name` in memory from its seeded copy and require the disk's settled outcomes. */
async function expectDiskParity(name: Name, log: string[] = []): Promise<{ settled: string; calls: string[]; leaves: Leaves }[]> {
  const { refresh, leaves } = memoryRefresh(name, log);
  const outcomes = await runSteps(SCENARIOS[name].steps, refresh, leaves, log);
  expect(outcomes).toEqual(minted[name]!.onDisk);
  return outcomes.map((outcome) => JSON.parse(outcome));
}

/** A marker's entries, as `{ pageId: attempts }`, or `{}` when it is absent or empty. */
const attemptsIn = (leaves: Leaves, file = "pending-embeddings.json"): Record<string, number> => Object.fromEntries(
  ((leaves?.[file] ? JSON.parse(leaves[file]!) : []) as { pageId: string; attempts: number }[]).map((one) => [one.pageId, one.attempts]));

describe("the embedding refresh over copied projects, with every minting directory gone", () => {
  it("R1 runs after every minting directory was removed, on copies holding exactly the seed", () => {
    expectMintsRemovedThenSeeded(minted, PREFIX, Object.keys(SCENARIOS) as Name[], seededCopy);
  });

  it("R2 drains a fresh project into one persisted store with no retry left, then a second drain is a no-op, as the disk did", async () => {
    const [first, second] = await expectDiskParity("drain");
    expect([first!.settled, first!.calls.length > 0, "embeddings.json" in first!.leaves!, attemptsIn(first!.leaves)]).toEqual(["null", true, true, {}]);
    expect([second!.settled, second!.calls, second!.leaves!["embeddings.json"], attemptsIn(second!.leaves)])
      .toEqual(["null", [], first!.leaves!["embeddings.json"], {}]);
  });

  it("R3 refreshes only the affected page and keeps an unrelated retry budget, as the disk did", async () => {
    const [only] = await expectDiskParity("scoped");
    expect([only!.settled, only!.calls.length > 0, "embeddings.json" in only!.leaves!, attemptsIn(only!.leaves)]).toEqual(["true", true, true, { [PRIOR]: 2 }]);
  });

  it("R4 touches nothing when disabled, as the disk did", async () => {
    const log: string[] = [];
    const [only] = await expectDiskParity("disabled", log);
    expect([only!.settled, only!.calls, only!.leaves, log]).toEqual(["null", [], { "pending-embeddings.json": PRIOR_MARKER }, []]);
  });

  it("R5 refuses an unavailable retry marker for scoped work with no provider call, non-fatally, then rethrows in strict mode, as the disk did", async () => {
    const [lenient, strict] = await expectDiskParity("unavailable");
    expect([lenient!.settled, lenient!.calls, strict!.settled, strict!.calls, strict!.leaves])
      .toEqual(["false", [], UNAVAILABLE, [], { "pending-embeddings.json": "directory" }]);
  });

  it("R6 keeps the charge for pages a failed provider was sent, then a healthy drain clears it, as the disk did", async () => {
    const [failed, healed] = await expectDiskParity("failure");
    const charged = attemptsIn(failed!.leaves);
    expect([failed!.settled, failed!.calls.length > 0, "embeddings.json" in (failed!.leaves ?? {}), Object.keys(charged).length > 0,
      Object.entries(charged).every(([id, attempts]) => [ALPHA, BETA].includes(id) && attempts === 1)]).toEqual(["null", true, false, true, true]);
    expect([healed!.settled, "embeddings.json" in healed!.leaves!, attemptsIn(healed!.leaves)]).toEqual(["null", true, {}]);
  });

  it("R7 records the retry intent before the provider, persists the store, then settles the marker last (memory only)", async () => {
    const log: string[] = [];
    const { refresh, leaves } = memoryRefresh("drain", log);
    await runSteps([SCENARIOS.drain.steps[0]!], refresh, leaves, log);
    const first = (prefix: string): number => log.findIndex((call) => call.startsWith(prefix));
    const last = (prefix: string): number => log.map((call) => call.startsWith(prefix)).lastIndexOf(true);
    expect([first("marker.replace pending") >= 0, first("marker.replace pending") < first("embed"), first("embed") < first("store.replace"),
      last("marker.") > first("store.replace")]).toEqual([true, true, true, true]);
  });
});
