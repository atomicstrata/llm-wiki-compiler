/**
 * @file test/storage/embedding-writer-binding.test.ts
 * @description The embedding WRITER's locked core, WHOLE, over storage held in
 * memory: `updateEmbeddingsLockedCoreFrom` honours the disable switch, drains
 * (profile, live pages, the stored store, migration, `prepare` before any
 * provider call, the persist condition, the fingerprint stamp, one validated
 * write, `markPersisted` after it), and runs the affected-only scope through the
 * bound planner and the bound validated write. It exists only after the core was
 * given a body of its own, so this file has NO before-edit run.
 *
 * HOW IT IS BUILT. Five projects are minted on real disk, once, and each tree is
 * copied BEFORE its disk ask (`mintCopiedBeforeAsk`), because the writer changes
 * the disk. Each project's OWN disk ask then runs its steps through the real root
 * form and settles each step EXACTLY ONCE: the result or the error, the provider
 * and `prepare` calls in order, the recorder's outcome, and what the private
 * directory then holds. The minting directories are removed before any case
 * runs. Before every memory replay the copy is checked LITERALLY against the
 * seed. The memory side then runs the same steps through the bound body, over
 * ONE store map that its reads and its raw writes share, so a later step reads
 * what an earlier one wrote.
 *
 * WHAT IS NOT BOUND, AND HOW IT IS HELD STILL. The provider is replaced at its
 * real seam, `getEmbeddingProvider`, by a stub that returns fixed vectors and
 * never reaches the network (`fetch` throws). The embedding configuration,
 * including the disable switch and the binary opt-in, is stubbed per step and
 * restored after it; the clock is frozen. No paid inference happens. The call
 * log, the refused publication and the order checks are MEMORY ONLY; the lock,
 * links, access refusals and capacity stay with the incumbent suites.
 */

import { createHash } from "node:crypto";
import { describe, expect, it } from "bun:test";
import { EmbeddingAttemptRecorder } from "../../src/utils/embedding-attempts.js";
import { updateEmbeddingsLockedCore, updateEmbeddingsLockedCoreFrom, type EmbeddingRefreshScope, type EmbeddingWriterSources } from "../../src/utils/embeddings.js";
import type { EmbeddingPageReads } from "../../src/utils/embeddings-pages.js";
import type { EmbeddingPrepare } from "../../src/utils/embeddings-scoped.js";
import { resolveEmbeddingFingerprint, resolveEmbeddingModel } from "../../src/utils/embeddings-store.js";
import { EMBEDDINGS_FILE, LLMWIKI_DIR } from "../../src/utils/constants.js";
import { effectiveProfileOf, entityScansOf, mintCopiedBeforeAsk, writeFiles, type Copy } from "./copied-project.js";
import {
  copiedPageReadsOf, restoreClockAfterSuite, privateDirLeaves, privateLeafStoreOf, recordingInto, withEmbeddingEnvironment, type EmbeddingEnvironment, type Leaves,
} from "./embedding-binding-doubles.js";
import { expectMintsRemovedThenSeeded, failureText, mintEachScenario } from "./scenario-mint.js";

const PREFIX = "embedding-writer-binding-";
const MEM_ROOT = "/memory/project";
const AT = "2026-10-12T00:00:00.000Z";
const [ALPHA, BETA, GONE] = ["concepts/alpha", "concepts/beta", "concepts/gone"];
const PAGES = {
  "wiki/concepts/alpha.md": "---\ntitle: Alpha\nsummary: First idea\n---\nAlpha body.\n",
  "wiki/concepts/beta.md": "---\ntitle: Beta\nsummary: Second idea\n---\nBeta body.\n",
};
const REFUSED_LEGACY = "FullEmbeddingReconciliationRequiredError: Embedding store requires full reconciliation: legacy. Run compile to reconcile the full embedding store.";
const sha = (bytes: string | Uint8Array): string => createHash("sha256").update(bytes).digest("hex").slice(0, 16);
const entry = (pageId: string) => ({ pageId, title: pageId, summary: "", embeddingTextHash: "old", vector: [1, 0], updatedAt: "t" });
const chunk = (pageId: string) => ({ pageId, title: pageId, chunkIndex: 0, contentHash: "old", text: "cached", vector: [0, 1], updatedAt: "t" });
/** A v3 store under the active (stubbed) embedding identity, holding alpha, beta and a deleted page's records. */
const v3Store = (): string => JSON.stringify({ version: 3, model: resolveEmbeddingModel(), fingerprint: resolveEmbeddingFingerprint(),
  dimensions: 2, entries: [entry(ALPHA), entry(BETA), entry(GONE)], chunks: [chunk(ALPHA), chunk(BETA), chunk(GONE)] });
const V2_STORE = JSON.stringify({ version: 2, model: "m", dimensions: 2, entries: [{ slug: "alpha", title: "A", summary: "", vector: [1, 0], updatedAt: "t" }] });

interface Step { scope: EmbeddingRefreshScope; changed: string[]; enabled?: boolean; prepare?: boolean }
type Core = (step: Step, prepare: EmbeddingPrepare | undefined, recorder: EmbeddingAttemptRecorder) => Promise<unknown>;

const SCENARIOS = {
  fresh: { seed: PAGES, steps: [{ scope: "drain", changed: [], prepare: true }, { scope: "drain", changed: [] }] as Step[] },
  disabled: { seed: PAGES, steps: [{ scope: "drain", changed: [ALPHA], enabled: false }] as Step[] },
  empty: { seed: { "README.md": "x" }, steps: [{ scope: "drain", changed: [] }] as Step[] },
  affected: { seed: { ...PAGES, [EMBEDDINGS_FILE]: v3Store }, steps: [{ scope: "affected-only", changed: [ALPHA] }, { scope: "affected-only", changed: [GONE] }] as Step[] },
  legacy: { seed: { ...PAGES, [EMBEDDINGS_FILE]: () => V2_STORE }, steps: [{ scope: "affected-only", changed: [ALPHA] }, { scope: "drain", changed: [] }] as Step[] },
};
type Name = keyof typeof SCENARIOS;

/** The writer witness's environment: embeddings on or off, never strict, a provider that never fails. */
const environment = (enabled: boolean): EmbeddingEnvironment => ({ enabled, strict: false, fail: false, at: AT, witness: "writer" });

/** Seed `files` (a value or a builder evaluated under the stubbed configuration) under `root`. */
async function seedOf(root: string, files: Record<string, string | (() => string)>): Promise<void> {
  const texts = await withEmbeddingEnvironment(environment(true), () => {}, async () => Object.fromEntries(Object.entries(files).map(([rel, text]) => [rel, typeof text === "string" ? text : text()])));
  await writeFiles(root, texts);
}

/** Run steps in order, settling each exactly once, then reading the calls, the recorder's outcome and the leaves. */
async function runSteps(steps: Step[], core: Core, leaves: () => Promise<Leaves>, log: string[] = []): Promise<string[]> {
  const outcomes: string[] = [];
  for (const step of steps) {
    const { calls, record } = recordingInto(log);
    const recorder = new EmbeddingAttemptRecorder();
    const prepare: EmbeddingPrepare | undefined = step.prepare ? async (ids) => { record(`prepare ${[...ids].sort().join(",")}`); return ids; } : undefined;
    const settled = await withEmbeddingEnvironment(environment(step.enabled ?? true), record, () => core(step, prepare, recorder))
      .then((value) => JSON.stringify(value), failureText);
    outcomes.push(JSON.stringify({ settled, calls, outcome: recorder.outcome().kind, leaves: await leaves() }));
  }
  return outcomes;
}

/** What the real private directory holds: each regular leaf's digest, or another entry's kind. */
const diskLeaves = (root: string): Promise<Leaves> => privateDirLeaves(root, (_name, bytes) => sha(bytes));

restoreClockAfterSuite();
const minted = mintEachScenario(Object.keys(SCENARIOS) as Name[], (tracker, name) =>
  mintCopiedBeforeAsk(tracker, PREFIX, (root) => seedOf(root, SCENARIOS[name].seed), (root) => runSteps(SCENARIOS[name].steps,
    (step, prepare, recorder) => updateEmbeddingsLockedCore(root, step.changed, prepare, step.scope, recorder), () => diskLeaves(root))));

/** `name`'s copy, after requiring LITERALLY that it holds the seed: the private directory's only leaf, or none. */
function seededCopy(name: Name): Copy {
  const copy = minted[name]!.copy;
  const store = copy.files.get(EMBEDDINGS_FILE);
  expect(copy.listings.get(LLMWIKI_DIR)?.map((one) => `${one.name}:${one.kind}`) ?? null).toEqual(name === "affected" || name === "legacy" ? ["embeddings.json:file"] : null);
  if (name === "legacy") expect(store).toBe(V2_STORE);
  if (name === "affected") expect(JSON.parse(store!).entries.map((one: { pageId: string }) => one.pageId)).toEqual([ALPHA, BETA, GONE]);
  return copy;
}

/** The store's raw reads and writes over ONE private directory seeded from `copy`; `refusal` rejects every replacement. */
function memoryStoreOf(copy: Copy, log: string[], refusal?: Error) {
  const store = privateLeafStoreOf(copy, log, { prefix: "store.", dir: `${MEM_ROOT}/${LLMWIKI_DIR}`, refusal });
  return { reads: store.reads, writes: store.writes, leaves: () => store.leaves((_name, bytes) => sha(bytes)) };
}

/** The live page reads over a copied tree, POSIX project-relative; each directory resolution and stat is logged first. */
const memoryPageReadsOf = (copy: Copy, log: string[]): EmbeddingPageReads => copiedPageReadsOf(copy, MEM_ROOT,
  { onDirectory: (relDir) => { log.push(`pages.dir ${relDir}`); }, onStat: (relPath) => { log.push(`pages.stat ${relPath}`); } });

/** The bound core over one seeded copy: its sources, its shared log, and its leaves. */
function memoryCore(name: Name, log: string[], refusal?: Error): { core: Core; leaves: () => Promise<Leaves> } {
  const copy = seededCopy(name);
  const store = memoryStoreOf(copy, log, refusal);
  const note = (call: string) => { log.push(`profile ${call}`); };
  const sources: EmbeddingWriterSources = { store: store.reads, writes: store.writes, profile: effectiveProfileOf(copy, note),
    live: { pages: memoryPageReadsOf(copy, log), entities: entityScansOf(copy, MEM_ROOT, note) } };
  return { core: (step, prepare, recorder) => updateEmbeddingsLockedCoreFrom(sources, step.changed, prepare, step.scope, recorder), leaves: store.leaves };
}

/** Run `name` in memory from its seeded copy and require the disk's settled outcomes. */
async function expectDiskParity(name: Name, log: string[] = []): Promise<{ settled: string; calls: string[]; outcome: string; leaves: Leaves }[]> {
  const { core, leaves } = memoryCore(name, log);
  const outcomes = await runSteps(SCENARIOS[name].steps, core, leaves, log);
  expect(outcomes).toEqual(minted[name]!.onDisk);
  return outcomes.map((outcome) => JSON.parse(outcome));
}

describe("the embedding writer's locked core over copied projects, with every minting directory gone", () => {
  it("W1 runs after every minting directory was removed, on copies holding exactly the seed", () => {
    expectMintsRemovedThenSeeded(minted, PREFIX, Object.keys(SCENARIOS) as Name[], seededCopy);
  });

  it("W2 drains a fresh project: prepare first, both pages embedded, one store persisted; then a second drain is a no-op, as the disk did", async () => {
    const [first, second] = await expectDiskParity("fresh");
    const [once, again] = [JSON.parse(first!.settled), JSON.parse(second!.settled)];
    expect([[...once.embedded].sort(), [...once.eligible].sort(), once.pruned, first!.calls[0], first!.outcome, Object.keys(first!.leaves!)])
      .toEqual([[ALPHA, BETA], [ALPHA, BETA], [], `prepare ${ALPHA},${BETA}`, "persisted", ["embeddings.json"]]);
    expect([again.embedded, [...again.eligible].sort(), again.pruned, second!.calls, second!.outcome, second!.leaves])
      .toEqual([[], [ALPHA, BETA], [], [], "before-requests", first!.leaves]);
  });

  it("W3 does nothing when disabled, and keeps an empty project clean, as the disk did", async () => {
    const log: string[] = [];
    const [disabled] = await expectDiskParity("disabled", log);
    const [empty] = await expectDiskParity("empty");
    const none = { embedded: [], eligible: [], pruned: [] };
    expect([JSON.parse(disabled!.settled), disabled!.calls, disabled!.leaves, log]).toEqual([none, [], null, []]);
    expect([JSON.parse(empty!.settled), empty!.calls, empty!.leaves]).toEqual([none, [], null]);
  });

  it("W4 re-embeds only the affected page, then prunes a deleted page's records with no provider call, as the disk did", async () => {
    const [embedded, pruned] = await expectDiskParity("affected");
    expect([JSON.parse(embedded!.settled), embedded!.outcome, embedded!.calls.length > 0]).toEqual([{ embedded: [ALPHA], eligible: [ALPHA], pruned: [] }, "persisted", true]);
    expect([JSON.parse(pruned!.settled), pruned!.calls, pruned!.outcome]).toEqual([{ embedded: [], eligible: [], pruned: [GONE] }, [], "before-requests"]);
    expect(pruned!.leaves).not.toEqual(embedded!.leaves);
  });

  it("W5 refuses a legacy store for affected-only work before any provider call, then a drain migrates it to v3, as the disk did", async () => {
    const [refused, migrated] = await expectDiskParity("legacy");
    const seeded = { "embeddings.json": sha(V2_STORE) };
    expect([refused!.settled, refused!.calls, refused!.leaves]).toEqual([REFUSED_LEGACY, [], seeded]);
    expect([[...JSON.parse(migrated!.settled).eligible].sort(), migrated!.outcome, migrated!.leaves === null || migrated!.leaves["embeddings.json"] === seeded["embeddings.json"]])
      .toEqual([[ALPHA, BETA], "persisted", false]);
  });

  it("W6 reads profile and pages, then the store, then prepares, embeds, creates and replaces, in that order (memory only)", async () => {
    const log: string[] = [];
    const { core, leaves } = memoryCore("fresh", log);
    await runSteps([SCENARIOS.fresh.steps[0]!], core, leaves, log);
    const at = (prefix: string): number => log.findIndex((call) => call.startsWith(prefix));
    expect([at("profile") < at("pages.dir"), at("pages.dir") < at("store.dir"), at("store.dir") < at("prepare"), at("prepare") < at("embed"),
      at("embed") < at("store.create"), log.at(-1)]).toEqual([true, true, true, true, true, `store.replace ${EMBEDDINGS_FILE}`]);
  });

  it("W7 passes a refused publication on after the provider was paid, and never marks it persisted (memory only)", async () => {
    const log: string[] = [];
    const { core, leaves } = memoryCore("fresh", log, Object.assign(new Error("publication refused"), { code: "EIO" }));
    const [outcome] = await runSteps([SCENARIOS.fresh.steps[0]!], core, leaves, log);
    expect([JSON.parse(outcome!).settled, JSON.parse(outcome!).outcome, JSON.parse(outcome!).leaves, log.at(-1)])
      .toEqual(["Error: publication refused", "after-requests", {}, `store.replace ${EMBEDDINGS_FILE}`]);
  });
});
