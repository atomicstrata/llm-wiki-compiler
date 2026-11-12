/**
 * @file test/storage/scoped-embedding-planner-binding.test.ts
 * @description The affected-only embedding PLANNER, WHOLE, over storage held in
 * memory: `planScopedEmbeddingUpdateFrom` reads the stored embeddings and
 * refuses an unreadable, legacy, other-backend or invalid store before anything
 * else; loads the profile; collects the affected live pages; lets `prepare`
 * admit them; drops affected records that are no longer eligible while keeping
 * unrelated ones verbatim; and reports as pruned only a provably absent page
 * that left no record. It exists only after the planner was given a body of its
 * own, so this file has NO before-edit run.
 *
 * HOW IT IS BUILT. Six projects are minted on real disk, once: one with no
 * private directory, one with a v3 store holding affected and unrelated
 * records, and four with a store the planner must refuse. Each project's OWN
 * disk ask runs its steps through the real root form and settles each step
 * EXACTLY ONCE: the plan as its JSON (with the admitted set listed), plus every
 * `prepare` call, or a refusal as its name and message. The minting directories
 * are removed before any case runs. The memory side runs the same steps through
 * the bound body over the copied tree, with the shared `effectiveProfileOf` and
 * `entityScansOf` doubles; the planner only reads, so the copy is the starting
 * state.
 *
 * AMBIENT CONFIGURATION. The store's compatibility check consults the active
 * embedding configuration from the environment, which both sides share in one
 * process; the seeded stores carry its fingerprint. That is configuration, not
 * storage, and this file does not vary it.
 *
 * WHAT THE MECHANISMS DECIDE. Only physical facts: whether the private
 * directory and each leaf exist, a leaf's bytes, directory listings, page text,
 * and whether a path is a regular file. The call log and the injected EACCES
 * are MEMORY ONLY. Real store integrity checks, links and access refusals stay
 * with the incumbent suites; the writer, refresh, provider and lock are not run.
 */

import { describe, expect, it } from "bun:test";
import type { EmbeddingPageReads } from "../../src/utils/embeddings-pages.js";
import {
  planScopedEmbeddingUpdate, planScopedEmbeddingUpdateFrom, type EmbeddingPrepare, type ScopedEmbeddingSources, type ScopedEmbeddingUpdate,
} from "../../src/utils/embeddings-scoped.js";
import type { StoredEmbeddingReads } from "../../src/utils/embeddings-storage.js";
import { resolveEmbeddingFingerprint, resolveEmbeddingModel } from "../../src/utils/embeddings-store.js";
import { EMBEDDINGS_FILE, LLMWIKI_DIR } from "../../src/utils/constants.js";
import { effectiveProfileOf, entityScansOf, mintCopied, writeFiles, type Copy } from "./copied-project.js";
import { copiedPageReadsOf } from "./embedding-binding-doubles.js";
import { mintEachScenario, settleInOrder } from "./scenario-mint.js";
import { expectMintingDirectoryRemoved } from "./minted-directory.js";

const PREFIX = "scoped-embedding-planner-binding-";
const MEM_ROOT = "/memory/project";
const [ALPHA, BETA, GONE] = ["concepts/alpha", "concepts/beta", "concepts/gone"];
const PAGES = {
  "wiki/concepts/alpha.md": "---\ntitle: Alpha\nsummary: First idea\n---\nAlpha body.\n",
  "wiki/concepts/beta.md": "---\ntitle: Beta\n---\nBeta body.\n",
};
const entry = (pageId: string, vector: number[] = [1, 0]) => ({ pageId, title: pageId, summary: "", embeddingTextHash: "old", vector, updatedAt: "t" });
const chunk = (pageId: string) => ({ pageId, title: pageId, chunkIndex: 0, contentHash: "old", text: "cached", vector: [0, 1], updatedAt: "t" });
/** A v3 store under the active embedding identity, built when the project is seeded. */
const storeText = (extra: object = {}): string => JSON.stringify({ version: 3, model: resolveEmbeddingModel(), fingerprint: resolveEmbeddingFingerprint(),
  dimensions: 2, entries: [entry(ALPHA), entry(BETA), entry(GONE)], chunks: [chunk(ALPHA), chunk(BETA), chunk(GONE)], ...extra });
const withStore = (text: () => string) => async (root: string) => writeFiles(root, { ...PAGES, [EMBEDDINGS_FILE]: text() });
const REFUSED = (reason: string) => `FullEmbeddingReconciliationRequiredError: Embedding store requires full reconciliation: ${reason}. Run compile to reconcile the full embedding store.`;

type Plan = (ids: string[], prepare?: EmbeddingPrepare) => Promise<ScopedEmbeddingUpdate>;
type Step = (plan: Plan) => Promise<unknown>;
/** One plan, with `prepare` admitting all, none, or absent; the plan is listed for JSON with every prepare call. */
const planned = (admit: "all" | "none" | "absent"): Step => async (plan) => {
  const calls: unknown[] = [];
  const prepare: EmbeddingPrepare | undefined = admit === "absent" ? undefined
    : async (ids, hashes) => { calls.push([ids, [...hashes]]); return admit === "all" ? ids : []; };
  const update = await plan([ALPHA, GONE], prepare);
  return { update: { ...update, reembed: [...update.reembed] }, calls };
};

const SCENARIOS = {
  fresh: { seed: (root: string) => writeFiles(root, PAGES), steps: [planned("all")] },
  existing: { seed: withStore(() => storeText()), steps: [planned("all"), planned("none"), planned("absent")] },
  legacy: { seed: withStore(() => JSON.stringify({ version: 2, model: "m", dimensions: 0, entries: [] })), steps: [planned("all")] },
  backend: { seed: withStore(() => storeText({ fingerprint: "another-backend" })), steps: [planned("all")] },
  invalid: { seed: withStore(() => storeText({ entries: [entry(ALPHA, [1, 2, 3])] })), steps: [planned("all")] },
  unreadable: { seed: withStore(() => "{corrupt"), steps: [planned("all")] },
};
type Name = keyof typeof SCENARIOS;

/** Run steps in order, settling each exactly once. */
async function runSteps(steps: Step[], plan: Plan): Promise<string[]> {
  return settleInOrder(steps, (step) => step(plan));
}

const minted = mintEachScenario(Object.keys(SCENARIOS) as Name[], (tracker, name) =>
  mintCopied(tracker, PREFIX, SCENARIOS[name].seed,
    (root) => runSteps(SCENARIOS[name].steps, (ids, prepare) => planScopedEmbeddingUpdate(root, ids, prepare))));

/** The stored-embedding reads over a copied tree. */
function memoryStoreReadsOf(copy: Copy, log: string[]): StoredEmbeddingReads {
  const rel = (name: string): string => `${LLMWIKI_DIR}/${name}`;
  return {
    resolvePrivateDir: async () => { log.push("store.dir"); return copy.listings.has(LLMWIKI_DIR) ? `${MEM_ROOT}/${LLMWIKI_DIR}` : null; },
    leafKind: async (_dir, name) => { log.push(`store.kind ${name}`); return copy.files.has(rel(name)) ? "regular" : "absent"; },
    readLeafBytes: async (_dir, name, maxBytes) => {
      log.push(`store.read ${name}`);
      const bytes = Buffer.from(copy.files.get(rel(name)) ?? "", "utf8");
      return bytes.byteLength > maxBytes ? null : bytes;
    },
  };
}

/** The page reads over a copied tree, POSIX project-relative; each stat is logged first, and `statCodes` injects a stat failure. */
const memoryPageReadsOf = (copy: Copy, log: string[], statCodes: Record<string, string> = {}): EmbeddingPageReads =>
  copiedPageReadsOf(copy, MEM_ROOT, { onStat: (relPath) => { log.push(`pages.stat ${relPath}`); }, statCodes });

/** The bound planner over one copied project. */
function memoryPlan(copy: Copy, log: string[], statCodes?: Record<string, string>): Plan {
  const note = (call: string) => { log.push(call); };
  const sources: ScopedEmbeddingSources = {
    store: memoryStoreReadsOf(copy, log),
    profile: effectiveProfileOf(copy, note),
    live: { pages: memoryPageReadsOf(copy, log, statCodes), entities: entityScansOf(copy, MEM_ROOT, note) },
  };
  return (ids, prepare) => planScopedEmbeddingUpdateFrom(sources, ids, prepare);
}

/** Run `name` in memory and require the disk's settled outcomes. */
async function expectDiskParity(name: Name): Promise<string[]> {
  const outcomes = await runSteps(SCENARIOS[name].steps, memoryPlan(minted[name]!.copy, []));
  expect(outcomes).toEqual(minted[name]!.onDisk);
  return outcomes;
}

type Outcome = { update: { store: { version: number; dimensions: number; entries: { pageId: string }[]; chunks: { pageId: string }[] };
  eligible: string[]; reembed: string[]; pruned: boolean; prunedIds: string[] }; calls: [string[], [string, string][]][] };
const read = (outcome: string): Outcome => JSON.parse(outcome) as Outcome;
const ids = (records: { pageId: string }[]): string[] => records.map((record) => record.pageId);

describe("the affected-only embedding planner over copied projects, with every minting directory gone", () => {
  it("S1 runs after every minting directory was removed", () => {
    for (const one of Object.values(minted)) expectMintingDirectoryRemoved(one!.dir, PREFIX);
  });

  it("S2 plans over an absent store: an empty v3 store, the affected live page admitted, the deleted page pruned, as the disk did", async () => {
    const { update, calls } = read((await expectDiskParity("fresh"))[0]!);
    expect([update.store.version, update.store.dimensions, update.store.entries, update.store.chunks]).toEqual([3, 0, [], []]);
    expect([update.eligible, update.reembed, update.pruned, update.prunedIds]).toEqual([[ALPHA], [ALPHA], false, [GONE]]);
    expect([calls.length, calls[0]![0], calls[0]![1].map(([pageId]) => pageId)]).toEqual([1, [ALPHA], [ALPHA]]);
  });

  it("S3 keeps unrelated records verbatim, drops the affected deleted page, and admits only what prepare returns, as the disk did", async () => {
    const [all, none, absent] = (await expectDiskParity("existing")).map(read);
    const seeded = JSON.parse(minted.existing!.copy.files.get(EMBEDDINGS_FILE)!) as { entries: unknown[]; chunks: unknown[] };
    expect([ids(all!.update.store.entries), ids(all!.update.store.chunks), all!.update.pruned, all!.update.prunedIds])
      .toEqual([[ALPHA, BETA], [ALPHA, BETA], true, [GONE]]);
    expect([all!.update.store.entries[1], all!.update.store.chunks[1]]).toEqual([seeded.entries[1], seeded.chunks[1]]);
    expect([all!.update.reembed, none!.update.reembed, absent!.update.reembed, absent!.calls]).toEqual([[ALPHA], [], [ALPHA], []]);
  });

  it.each([["legacy", "legacy"], ["backend", "backend"], ["invalid", "invalid"],
    ["unreadable", "unreadable (Embedding index could not be read or failed integrity validation.)"]] as const)(
    "S4 refuses a %s store for full reconciliation, as the disk did", async (name, reason) => {
      expect(await expectDiskParity(name)).toEqual([REFUSED(reason)]);
    });

  it("S5 refuses before any profile or page read, reads the store first and existence last, and never prunes an unknown page (memory only)", async () => {
    const refusedLog: string[] = [];
    await runSteps(SCENARIOS.legacy.steps, memoryPlan(minted.legacy!.copy, refusedLog));
    expect(refusedLog.every((call) => call.startsWith("store."))).toBe(true);
    const log: string[] = [];
    const [outcome] = await runSteps([planned("all")], memoryPlan(minted.existing!.copy, log, { "wiki/concepts/gone.md": "EACCES" }));
    expect([read(outcome!).update.pruned, read(outcome!).update.prunedIds]).toEqual([true, []]);
    expect([log[0], log.at(-1), log.findIndex((call) => !call.startsWith("store.")) > log.lastIndexOf("store.read embeddings.json")])
      .toEqual(["store.dir", "pages.stat wiki/concepts/gone.md", true]);
  });
});
