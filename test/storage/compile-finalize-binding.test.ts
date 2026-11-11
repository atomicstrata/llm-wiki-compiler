/**
 * @file test/storage/compile-finalize-binding.test.ts
 * @description Compile's TAIL, WHOLE, with no ambient disk: `seedThenFinalizeWith`
 * and `finalizeUnchangedCompileWith` over the REAL seed body
 * (`generateSeedPagesWith`, its provider a test HOST fake), the real resolution
 * and repair bodies (`resolveLinksFrom`, `repairLinksFrom`) applied through the
 * real compile page-write, planner and held-lock executor bodies, the draft's
 * `loadFrom`/`flushTo` over the accepted state record bodies, and the real
 * index and MOC bodies — all over ONE live in-memory project. The bodies exist
 * only after the tail was given bodies of its own, so this file has NO
 * before-edit run.
 *
 * HOW IT IS BUILT. One project is minted on real disk, once, and copied BEFORE
 * its disk ask. Its seed holds two concept pages and a state record. The ask
 * runs the ROOT `seedThenFinalize` (a scoped run, then a full changed run) and
 * `finalizeUnchangedCompile`, with `callClaude` stubbed by the same fake the
 * memory side hands its seed step, Date fixed, and embeddings off (the default
 * drain would otherwise reach a provider). Each step settles once with the
 * generation's seed slugs and errors (or the result), the status lines and the
 * whole tree. The memory replay must equal the disk. Resolution, index and MOC
 * BYTES are compared by that parity only; the orchestration facts — seed
 * dedup, validation and floor skips, the scoped digest rule, the single flush,
 * the no-flush unchanged route — are also asserted as literals.
 *
 * WHAT IS MEMORY ONLY, AND NOT A REAL GUARD. The ordered step trace, the
 * embeddings recorder, the resolution fault, and the live map's answers. Real
 * confinement, links, the lock and gate, and provider behaviour stay with
 * `compile-*`, `seed-pages-*`, `review-batch-*` and the binding suites of each step.
 */

import { describe, expect, it, vi, setSystemTime } from "bun:test";
import { restoreEnv, stubEnv } from "../stubs.js";
import * as finalize from "../../src/compiler/compile-finalize.js";
import { finalizeUnchangedCompile, finalizeUnchangedCompileWith, seedThenFinalize, seedThenFinalizeWith, type CompileFinalizeSteps } from "../../src/compiler/compile-finalize.js";
import { CompileStateDraft } from "../../src/compiler/compile-state-draft.js";
import * as compileWrite from "../../src/compiler/compile-write.js";
import * as indexgen from "../../src/compiler/indexgen.js";
import * as repair from "../../src/compiler/link-repair.js";
import * as obsidian from "../../src/compiler/obsidian.js";
import * as resolver from "../../src/compiler/resolver.js";
import * as seedPages from "../../src/compiler/seed-pages.js";
import type { MergedConcept, PageGenerationResult } from "../../src/compiler/types.js";
import { buildDefaultSchema, type SchemaConfig } from "../../src/schema/index.js";
import * as diskLeaves from "../../src/storage/disk-guarded-leaves.js";
import * as executor from "../../src/trust/executor.js";
import { ENV_EMBEDDINGS, GENERATED_PAGE_MAX_CHARS, INDEX_FILE, MOC_FILE, STATE_FILE } from "../../src/utils/constants.js";
import * as embeddingsRefresh from "../../src/utils/embeddings-refresh.js";
import * as llm from "../../src/utils/llm.js";
import * as output from "../../src/utils/output.js";
import * as state from "../../src/utils/state.js";
import type { CompileOptions } from "../../src/utils/types.js";
import { tempRootTracker } from "../temp-roots.js";
import { mintCopiedBeforeAsk, writeFiles } from "./copied-project.js";
import { captureStatusLines, diskTree, expectHoldsExactly, mintSingle, regularFiles, sortedTree } from "./project-tree.js";
import { MEM_ROOT, memoryFinalizeSteps, memoryPorts, memoryStores, type Held } from "./compile-memory-steps.js";
import { expectMintingDirectoryRemoved } from "./minted-directory.js";

const PREFIX = "compile-finalize-binding-";
const C = "wiki/concepts";
const NOW = new Date("2026-02-03T04:05:06.000Z");
const source = (concepts: string[]) => ({ hash: "h", concepts, compiledAt: "t" });
const SEED: Record<string, string> = {
  [`${C}/alpha.md`]: "---\ntitle: Alpha\n---\n\nAlpha mentions Beta and the Overview.\n",
  [`${C}/beta.md`]: "---\ntitle: Beta\n---\n\nBeta stands alone.\n",
  [STATE_FILE]: JSON.stringify({ version: 1, indexHash: "", sources: { "a.md": source(["alpha"]) } }),
};
/** Overview is written; its slug twin is dropped before rendering; Huge is floor-refused; Empty fails validation. */
const SCHEMA: SchemaConfig = { ...buildDefaultSchema(), seedPages: [
  { title: "Overview", kind: "overview", summary: "The whole picture.", relatedSlugs: ["alpha"] },
  { title: "overview", kind: "overview", summary: "A slug twin." },
  { title: "Huge", kind: "concept", summary: "Too big." }, { title: "Empty", kind: "concept", summary: "Nothing." },
] };
/** The provider, keyed by the seed title in the request. The same fake serves both sides. */
const complete = async (request: { messages: Array<{ content: unknown }> }): Promise<string> => {
  const asked = String(request.messages[0]!.content);
  if (asked.includes('"Huge"')) return "x".repeat(GENERATED_PAGE_MAX_CHARS + 1);
  return asked.includes('"Empty"') ? " " : "The Overview weaves Alpha and Beta together.";
};
const generation = (written: string[]): PageGenerationResult => ({
  pages: [], errors: [], candidates: [], review: { held: [], forced: [] }, seedSlugs: [],
  writtenPages: written.map((slug) => ({ slug, concept: { is_new: true }, sourceFiles: ["b.md"], combinedContent: "" }) as unknown as MergedConcept),
});

/** One tail surface, root or bound, over one project. */
interface Side {
  load(): Promise<CompileStateDraft>;
  seedThenFinalize(gen: PageGenerationResult, options: CompileOptions, draft: CompileStateDraft | null): Promise<void>;
  unchanged(draft: CompileStateDraft): Promise<unknown>;
  tree(): Promise<Record<string, string>>;
}

/** A scoped changed run, a full changed run, then the no-change route; each settled once with statuses and tree. */
async function runScenario(side: Side): Promise<string[]> {
  const statuses: string[] = [];
  const status = captureStatusLines(statuses);
  setSystemTime(NOW);
  const out: string[] = [];
  const settle = async (name: string, act: () => Promise<unknown>): Promise<void> => {
    const settled = await act().then((value) => value ?? "ok", (error: Error) => `${error.name}: ${error.message}`);
    out.push(JSON.stringify({ name, settled, statuses: statuses.splice(0), tree: await side.tree() }));
  };
  try {
    for (const [name, filter] of [["scoped", () => true], ["full", undefined]] as const) {
      const draft = await side.load();
      draft.setSource("b.md", source(["beta"]));
      const gen = generation(["beta"]);
      await settle(name, async () => { await side.seedThenFinalize(gen, { embeddings: false, changeFilter: filter }, draft); return { seedSlugs: gen.seedSlugs, errors: gen.errors }; });
    }
    await settle("unchanged", async () => side.unchanged(await side.load()));
  } finally {
    setSystemTime();
    status.mockRestore();
  }
  return out;
}

const UNCHANGED_PREP = { schema: SCHEMA, reconciliationSlugs: new Set<string>(), buckets: { unchanged: [{}, {}] } } as never;

const tracker = tempRootTracker();
const minted = mintSingle<string[]>(tracker, () => mintCopiedBeforeAsk(tracker, PREFIX, (root) => writeFiles(root, SEED), async (root) => {
  const provider = vi.spyOn(llm, "callClaude").mockImplementation(complete);
  try {
    return await runScenario({
      load: () => CompileStateDraft.load(root),
      seedThenFinalize: (gen, options, draft) => seedThenFinalize(root, SCHEMA, gen, options, draft),
      unchanged: (draft) => finalizeUnchangedCompile(root, draft, UNCHANGED_PREP, { embeddings: false }),
      tree: () => diskTree(root, regularFiles),
    });
  } finally {
    provider.mockRestore();
  }
}));

/** The copy, after requiring LITERALLY that it holds exactly the seed. */
function seededCopy(): Held {
  const files = minted.copy.files;
  expectHoldsExactly(files, SEED);
  return { files: new Map(files), dirs: new Set(minted.copy.listings.keys()) };
}

/** Every tail step bound to the live map (the shared test-only composition), with this file's HOST provider fake. */
function memorySteps(held: Held, log: string[], faults: { resolve?: Error } = {}): CompileFinalizeSteps {
  return memoryFinalizeSteps(held, memoryPorts(held).write, { complete, log, faults });
}

/** The bound side over a fresh seeded copy. */
function memorySide(log: string[] = [], faults: { resolve?: Error } = {}): Side & { held: Held; steps: CompileFinalizeSteps } {
  const held = seededCopy();
  const steps = memorySteps(held, log, faults);
  const { records } = memoryStores(held);
  return {
    held, steps,
    load: () => CompileStateDraft.loadFrom(records),
    seedThenFinalize: (gen, options, draft) => seedThenFinalizeWith(steps, MEM_ROOT, SCHEMA, gen, options, draft),
    unchanged: (draft) => finalizeUnchangedCompileWith(steps, MEM_ROOT, draft, UNCHANGED_PREP, { embeddings: false }),
    tree: async () => sortedTree(Object.fromEntries(held.files)),
  };
}

type Settled = { name: string; settled: { seedSlugs?: string[]; errors?: string[]; skipped?: number; pages?: string[] }; statuses: string[]; tree: Record<string, string> };
const stateOf = (step: Settled): Record<string, unknown> => JSON.parse(step.tree[STATE_FILE]!);
const SEED_ERRORS = ['Invalid page for "Empty" — failed validation', 'Page "huge" skipped — floor:deny'];

describe("compile's tail over one copied project, with the minting directory gone", () => {
  it("F1 runs after the minting directory was removed, on a copy holding exactly the seed", () => {
    expectMintingDirectoryRemoved(minted.dir, PREFIX);
    seededCopy();
  });

  it("F2 seeds (dedup, validation and floor skips), resolves, repairs, flushes once, indexes and builds the MOC on both changed runs, then re-seeds without a flush when nothing changed, as the disk did", async () => {
    const outcomes = await runScenario(memorySide());
    expect(outcomes).toEqual(minted.onDisk);
    const [scoped, full, unchanged] = outcomes.map((line) => JSON.parse(line) as Settled);
    const { skipped, pages, errors } = unchanged!.settled;
    expect([scoped!.settled, full!.settled, { skipped, pages, errors }]).toEqual([
      { seedSlugs: ["overview"], errors: SEED_ERRORS }, { seedSlugs: ["overview"], errors: SEED_ERRORS },
      { skipped: 2, pages: ["overview"], errors: SEED_ERRORS },
    ]);
    expect([Object.keys(stateOf(scoped!).sources as object), "promptModifiers" in stateOf(scoped!), "promptModifiers" in stateOf(full!)]).toEqual([["a.md", "b.md"], false, true]);
    expect(unchanged!.tree[STATE_FILE]).toBe(full!.tree[STATE_FILE]);
    expect(Object.keys(full!.tree).filter((rel) => rel.startsWith("wiki/")).sort()).toEqual([`${C}/alpha.md`, `${C}/beta.md`, `${C}/overview.md`, MOC_FILE, INDEX_FILE].sort());
    expect(Object.keys(full!.tree).filter((rel) => rel.includes("journal/"))).toEqual([]);
    expect(full!.statuses).toContain('! Seed "overview" collides on slug "overview" with "Overview" — skipped (first wins).');
  });
});

describe("the tail's order and flags over the bound steps (memory only)", () => {
  it("F3 runs seed, resolve, repair, flush, index, MOC, embeddings over the concept page ids, then the timeline; skips embeddings when off and seeding when told", async () => {
    const log: string[] = [];
    const side = memorySide(log);
    vi.spyOn(output, "status").mockImplementation(() => {});
    await side.seedThenFinalize(generation(["beta"]), {}, await side.load());
    await side.seedThenFinalize(generation([]), { skipSeedPages: true, embeddings: false, concurrency: 20 }, null);
    // The compile's --concurrency reaches the timeline, which makes most of a compile's model calls.
    expect(log).toEqual(["seed", "resolve", "repair", "flush", "index", "moc", "embeddings concepts/beta,concepts/overview", "entities", "timeline", "index", "moc", "entities x20", "timeline x20"]);
  });

  it("F4 leaves the state record untouched and the index unbuilt when resolution fails before the flush", async () => {
    const log: string[] = [];
    const side = memorySide(log, { resolve: new Error("injected resolution failure") });
    vi.spyOn(output, "status").mockImplementation(() => {});
    const before = side.held.files.get(STATE_FILE);
    const draft = await side.load();
    draft.setSource("b.md", source(["beta"]));
    await expect(side.seedThenFinalize(generation(["beta"]), { embeddings: false }, draft)).rejects.toThrow("injected resolution failure");
    expect([log, side.held.files.get(STATE_FILE), side.held.files.has(INDEX_FILE)]).toEqual([["seed", "resolve"], before, false]);
  });
});

describe("the bound tail reaches no root step and no disk primitive", () => {
  /** The root steps and the disk primitives beneath them. */
  const spyAll = () => [
    vi.spyOn(seedPages, "generateSeedPages"), vi.spyOn(resolver, "resolveAndApplyLinks"), vi.spyOn(repair, "repairAndApplyLinks"),
    vi.spyOn(indexgen, "generateIndex"), vi.spyOn(obsidian, "generateMOC"), vi.spyOn(embeddingsRefresh, "refreshEmbeddingsDrainingPending"),
    vi.spyOn(state, "readState"), vi.spyOn(state, "writeState"), vi.spyOn(compileWrite, "applyCompilePageWritesLocked"),
    vi.spyOn(executor, "applyApprovedMutationsLocked"), vi.spyOn(diskLeaves, "replaceLeafAtomicWithin"), vi.spyOn(diskLeaves, "writeLeafAtomicUnconfined"),
    vi.spyOn(diskLeaves, "listDirectoryNames"),
  ];

  it("F5 makes no root or disk call in the bound route, while the root tail reaches every one with embeddings on and disabled by env", async () => {
    const spies = spyAll();
    const provider = vi.spyOn(llm, "callClaude").mockImplementation(complete);
    await runScenario(memorySide());
    expect([spies.map((spy) => spy.mock.calls.length), provider.mock.calls.length]).toEqual([spies.map(() => 0), 0]);
    const root = await tracker.create(PREFIX);
    await writeFiles(root, SEED);
    stubEnv(ENV_EMBEDDINGS, "off");
    vi.spyOn(output, "status").mockImplementation(() => {});
    await finalize.seedThenFinalize(root, SCHEMA, generation(["beta"]), {}, await CompileStateDraft.load(root));
    restoreEnv();
    expect([spies.map((spy) => spy.mock.calls.length > 0), provider.mock.calls.length > 0]).toEqual([spies.map(() => true), true]);
  });
});
