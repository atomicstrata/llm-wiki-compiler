/**
 * @file test/storage/compile-run-binding.test.ts
 * @description The WHOLE `llmwiki compile` run as ONE production orchestration
 * body: `compileAndReportWith` over explicit {@link CompileRunSteps}. The
 * production default (`localCompileRunSteps`) supplies the incumbent root forms;
 * no non-disk production adapter exists; the bound composition is TEST-ONLY
 * (`compile-memory-steps.ts`); this is not a complete migration. The body
 * exists only after the run was given steps, so this file has NO before-edit run.
 *
 * HOW IT IS BUILT. Three projects are minted on real disk, once. Each is seeded
 * by the REAL root `compileAndReport` (same provider stub, fixed clock), then
 * mutated, then copied BEFORE its disk ask, which is the ROOT `compileAndReport`
 * again: `fresh` adds a NEW source after the baseline compile (so the ask is the
 * first compile of THAT source, not the project's first-ever compile);
 * `unchanged` is not mutated; `deleted` removes one of two sources, the removed
 * one owning one EXCLUSIVE and one SHARED concept. The memory replay is
 * `compileAndReportWith` over the bound steps; each side's result, status lines
 * and whole tree must be equal. The clock is fixed (Date only), so nothing is
 * normalised; the copy is the raw original text.
 *
 * WHAT IS NOT PORTED, AND NOT A REAL GUARD. Named non-project collaborators: the
 * provider (a HOST stub, identical on both sides: the fixture model with every
 * `#` heading a concept); the gate's four DOMAIN legs (labelled FAKES in memory,
 * root-bound in production, per-leg rulings OPEN); the embeddings step (off);
 * the compile records' candidate queue (a collecting DOUBLE); `timeStage`
 * (off); the environment readers (concurrency, output language, sources
 * section, provider identity). Frozen-orphan and candidate-HOLD routes are
 * executable but NOT newly proved here (no case has frozen slugs or a non-off
 * review policy).
 */

import { rm } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi, setSystemTime } from "bun:test";
import { restoreEnv, stubEnv } from "../stubs.js";
import * as compileAccess from "../../src/compiler/compile-access.js";
import * as finalize from "../../src/compiler/compile-finalize.js";
import { emptyCompileResult } from "../../src/compiler/compile-phases.js";
import { CompileStateDraft } from "../../src/compiler/compile-state-draft.js";
import * as compileWrite from "../../src/compiler/compile-write.js";
import * as candidates from "../../src/compiler/candidates.js";
import { compileAndReport, compileAndReportWith } from "../../src/compiler/index.js";
import * as orphan from "../../src/compiler/orphan.js";
import * as lockGate from "../../src/operation-bundles/lock-gate.js";
import { FixtureProvider, fixtureModelOverride } from "../fixtures/fixture-provider.js";
import * as diskLeaves from "../../src/storage/disk-guarded-leaves.js";
import * as journalRecovery from "../../src/trust/journal-recovery.js";
import * as activityLog from "../../src/utils/activity-log.js";
import { ENV_EMBEDDINGS, STATE_FILE } from "../../src/utils/constants.js";
import * as embeddingsRefresh from "../../src/utils/embeddings-refresh.js";
import * as lock from "../../src/utils/lock.js";
import * as output from "../../src/utils/output.js";
import { runWithProviderOverride, type LLMMessage, type ProviderOverride } from "../../src/utils/provider.js";
import type { CompileOptions, CompileResult } from "../../src/utils/types.js";
import { tempRootTracker } from "../temp-roots.js";
import { MEM_ROOT, memoryCompileRunSteps, put, type CompileRunFaults, type Held } from "./compile-memory-steps.js";
import { mintCopiedBeforeAsk, mintOnceThenRemove, writeFiles, type Minted } from "./copied-project.js";
import { captureStatusLines, diskTree, regularFiles, sortedTree } from "./project-tree.js";
import { expectMintingDirectoryRemoved } from "./minted-directory.js";

const PREFIX = "compile-run-binding-";
const NOW = new Date("2026-02-03T04:05:06.000Z");
const OPTIONS: CompileOptions = { concurrency: 1, embeddings: false };
const [A, B, C] = ["sources/a.md", "sources/b.md", "sources/c.md"] as const;
const SHARED_A = "# Shared Topic\n\nA writes about the shared topic.\n";
const SHARED_B = "# Shared Topic\n\nB also covers the shared topic.\n\n# Solo Note\n\nOnly B covers the solo note.\n";
const FRESH = "# Fresh Idea\n\nC introduces a fresh idea.\n";
const SCENARIOS = {
  fresh: { baseline: { [A]: SHARED_A }, mutate: (root: string) => writeFiles(root, { [C]: FRESH }), sources: { [A]: SHARED_A, [C]: FRESH } },
  unchanged: { baseline: { [A]: SHARED_A }, mutate: async (_root: string) => {}, sources: { [A]: SHARED_A } },
  deleted: { baseline: { [A]: SHARED_A, [B]: SHARED_B }, mutate: (root: string) => rm(path.join(root, B)), sources: { [A]: SHARED_A } },
};
type Scenario = keyof typeof SCENARIOS;
const GATE = ["lock", "journal", "bundle", "portable", "lifecycle ordinary", "settle"];
const MARKER = "--- SOURCE DOCUMENT ---";

/** The HOST provider stub: the fixture model, except EVERY `#` heading of the source is a concept; calls are counted. */
class HeadingsProvider extends FixtureProvider {
  calls = 0;
  override async complete(system: string, messages: LLMMessage[]): Promise<string> { this.calls += 1; return super.complete(system, messages); }
  override async toolCall(system: string): Promise<string> {
    this.calls += 1;
    const at = system.indexOf(MARKER);
    const lines = (at < 0 ? "" : system.slice(at + MARKER.length)).split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
    const summary = lines.find((line) => !line.startsWith("#")) ?? "";
    const concepts = lines.filter((line) => line.startsWith("# ")).map((line) => ({
      concept: line.slice(2).trim(), summary, is_new: true, tags: ["fixture"], confidence: 1, provenance_state: "extracted",
    }));
    return JSON.stringify({ concepts });
  }
}
const overrideOf = (provider: HeadingsProvider): ProviderOverride => ({ ...fixtureModelOverride(), provider });

/** One compile surface, root or bound, over one project. */
interface Side { compile(options: CompileOptions): Promise<CompileResult>; tree(): Promise<Record<string, string>> }
interface Shown { settled: CompileResult | string; statuses: string[]; tree: Record<string, string> }
const parsed = (text: string): Shown => JSON.parse(text);
/** The settled result, or the settled failure thrown back. */
const resultOf = (shown: Shown): CompileResult => { if (typeof shown.settled === "string") throw new Error(shown.settled); return shown.settled; };

/** One compile under the provider stub and the fixed clock, settled once, with its status lines and the whole tree. */
async function runScenario(side: Side, provider: HeadingsProvider, options: CompileOptions = OPTIONS): Promise<string> {
  const statuses: string[] = [];
  const status = captureStatusLines(statuses);
  setSystemTime(NOW);
  try {
    const settled = await runWithProviderOverride(overrideOf(provider), () => side.compile(options)).then((result) => result, (error: Error) => `${error.name}: ${error.message}`);
    return JSON.stringify({ settled, statuses, tree: await side.tree() });
  } finally {
    setSystemTime();
    status.mockRestore();
  }
}

const diskSide = (root: string): Side => ({ compile: (options) => compileAndReport(root, options), tree: () => diskTree(root, regularFiles) });

/** Seed the baseline, compile it through the ROOT run (which must SUCCEED), then mutate: the copy is taken after this, before the ask. */
async function seedCompiled(root: string, name: Scenario): Promise<void> {
  await writeFiles(root, SCENARIOS[name].baseline);
  expect(resultOf(parsed(await runScenario(diskSide(root), new HeadingsProvider()))).errors).toEqual([]);
  await SCENARIOS[name].mutate(root);
}

const tracker = tempRootTracker();
const minted = new Map<Scenario, Minted<string>>();
const mintedOf = (name: Scenario): Minted<string> => { const held = minted.get(name); if (!held) throw new Error(`${name} not minted`); return held; };
const NAMES: Scenario[] = ["fresh", "unchanged", "deleted"];
mintOnceThenRemove(tracker, async () => {
  for (const name of NAMES) {
    minted.set(name, await mintCopiedBeforeAsk(tracker, PREFIX, (root) => seedCompiled(root, name), (root) => runScenario(diskSide(root), new HeadingsProvider())));
  }
});

/** The bound side over a fresh copy of `name`: `compileAndReportWith` over the test-only steps, every step logged. */
function memorySide(name: Scenario, faults: CompileRunFaults = {}) {
  const { copy } = mintedOf(name);
  const held: Held = { files: new Map(copy.files), dirs: new Set(copy.listings.keys()) };
  const log: string[] = [];
  const { steps, queue } = memoryCompileRunSteps(held, log, faults);
  const side: Side = { compile: (options) => compileAndReportWith(steps, MEM_ROOT, options), tree: async () => sortedTree(Object.fromEntries(held.files)) };
  return { held, log, queue, side };
}

/** Replay `name` in memory and require the disk's outcome; returns the parsed outcome, the side and its provider. */
async function parity(name: Scenario) {
  const memory = memorySide(name);
  const provider = new HeadingsProvider();
  const shown = await runScenario(memory.side, provider);
  expect(shown).toEqual(mintedOf(name).onDisk);
  return { ...parsed(shown), memory, provider };
}
const sourcesOf = (tree: Record<string, string>): string[] => Object.keys(JSON.parse(tree[STATE_FILE]!).sources).sort();
const copiedOf = (name: Scenario, rel: string): string | undefined => mintedOf(name).copy.files.get(rel);

describe("the whole compile run, disk and memory, from three root-compiled copies", () => {
  it("R1 runs after every minting directory was removed, on copies holding the mutated sources, a state record, no lock and no journal", () => {
    for (const name of NAMES) {
      expectMintingDirectoryRemoved(mintedOf(name).dir, PREFIX);
      const files = mintedOf(name).copy.files;
      expect(Object.fromEntries([...files].filter(([rel]) => rel.startsWith("sources/")))).toEqual(SCENARIOS[name].sources);
      expect([files.has(STATE_FILE), files.has(".llmwiki/lock"), [...files.keys()].filter((rel) => rel.startsWith(".llmwiki/journal/"))]).toEqual([true, false, []]);
    }
    expect([copiedOf("deleted", "wiki/concepts/solo-note.md"), copiedOf("deleted", "wiki/concepts/shared-topic.md")]).toEqual([expect.stringContaining("b.md"), expect.stringContaining("a.md")]);
  });

  it("R2 compiles the NEW source of a compiled project (writes its page, records its state, journals Created), as the disk did", async () => {
    const shown = await parity("fresh");
    expect([resultOf(shown).errors, "wiki/concepts/fresh-idea.md" in shown.tree, sourcesOf(shown.tree)]).toEqual([[], true, ["a.md", "c.md"]]);
    expect(shown.tree["log.md"]).toContain("Created: [[fresh-idea]]");
  });

  it("R3 finds nothing to compile, calls no provider and flushes no state, as the disk did", async () => {
    const shown = await parity("unchanged");
    expect([resultOf(shown).errors, shown.statuses.includes("✓ Nothing to compile — all sources up to date."), shown.provider.calls, shown.tree[STATE_FILE]])
      .toEqual([[], true, 0, copiedOf("unchanged", STATE_FILE)]);
  });

  it("R4 orphans the deleted source's EXCLUSIVE page, keeps the SHARED one, and forgets the source, as the disk did", async () => {
    const shown = await parity("deleted");
    expect([resultOf(shown).errors, shown.tree["wiki/concepts/solo-note.md"], shown.tree["wiki/concepts/shared-topic.md"], sourcesOf(shown.tree)])
      .toEqual([[], expect.stringContaining("orphaned: true"), expect.not.stringContaining("orphaned: true"), ["a.md"]]);
    expect(shown.memory.log).toContain("orphan b.md");
  });
});

describe("the bound run's refusals, order, review delegation, and no ambient call (memory only, not real guards)", () => {
  it("R5 refuses a busy lock before any recovery or access, aborts an unsafe compile recovery and still releases, and survives a failing log append", async () => {
    const busy = memorySide("fresh");
    put(busy.held, ".llmwiki/lock", "4343");
    const refused = parsed(await runScenario(busy.side, new HeadingsProvider()));
    expect([refused.settled, refused.statuses, busy.log]).toEqual([
      { ...emptyCompileResult(), errors: ["Could not acquire .llmwiki/lock — another compile is in progress."] }, ["! Could not acquire lock. Try again later."], ["lock"],
    ]);
    const unsafe = memorySide("fresh", { compileRecovery: "unsafe" });
    const aborted = parsed(await runScenario(unsafe.side, new HeadingsProvider()));
    expect([aborted.settled, unsafe.log]).toEqual(["JournalUnsafeError: journal recovery unsafe: pre-compile journal recovery unsafe", [...GATE, "recover", "release"]]);
    const failing = memorySide("fresh", { logAppend: new Error("injected log failure") });
    const logged = parsed(await runScenario(failing.side, new HeadingsProvider()));
    expect([resultOf(logged).errors, logged.statuses.includes("! Skipped log.md update: injected log failure"), logged.tree["log.md"]])
      .toEqual([[], true, copiedOf("fresh", "log.md")]);
  });

  it("R6 traces a changed compile exactly: the gate (its recovery), the compile's OWN recovery, access, draft, both listings BEFORE the batch, finalize, log, release", async () => {
    const { log, side } = memorySide("fresh");
    await runScenario(side, new HeadingsProvider());
    expect(log).toEqual([...GATE, "recover", "access", "draft", "list wiki/concepts", "list wiki/queries", "commit-live",
      "finalize", "seed", "resolve", "repair", "flush", "index", "moc", "entities x1", "timeline x1", "log", "release"]);
    expect(log.filter((entry) => entry === "journal" || entry === "recover")).toEqual(["journal", "recover"]);
  });

  it("R8 delegates review mode: the gate and both recoveries, access, candidates through the memory records, no draft, batch, orphan, finalize or log, then release", async () => {
    const { log, queue, held, side } = memorySide("fresh");
    const shown = parsed(await runScenario(side, new HeadingsProvider(), { ...OPTIONS, review: true }));
    expect([log, queue.drafts.map((draft) => draft.slug), resultOf(shown).errors]).toEqual([[...GATE, "recover", "access", "release"], ["fresh-idea"], []]);
    expect([held.files.get(STATE_FILE), held.files.has("wiki/concepts/fresh-idea.md")]).toEqual([copiedOf("fresh", STATE_FILE), false]);
  });

  it("R7 makes no ambient call in the bound run, while the ROOT run reaches every root collaborator and disk store at its production import site", async () => {
    const root = await tracker.create(PREFIX);
    await seedCompiled(root, "deleted");
    await writeFiles(root, { [A]: "# Shared Topic\n\nA rewrites the shared topic.\n" });
    const recover = vi.spyOn(journalRecovery, "recoverJournalBeforeCompile");
    const spies = [
      vi.spyOn(lockGate, "acquireMutationLock"), vi.spyOn(lock, "acquireLock"), vi.spyOn(lock, "releaseLock"), recover,
      vi.spyOn(compileAccess, "diskCompileAccess"), vi.spyOn(CompileStateDraft, "load"), vi.spyOn(compileWrite, "applyCompilePageWritesLocked"),
      vi.spyOn(orphan, "markOrphaned"), vi.spyOn(finalize, "seedThenFinalize"), vi.spyOn(diskLeaves, "listDirectoryNames"), vi.spyOn(activityLog, "appendLog"),
      vi.spyOn(candidates, "deleteCandidateBySlug"), vi.spyOn(embeddingsRefresh, "refreshEmbeddingsDrainingPending"),
    ];
    // Both runs must SUCCEED, so neither the zero counts nor the positive counts can come from an early failure.
    expect(resultOf(parsed(await runScenario(memorySide("deleted").side, new HeadingsProvider(), { concurrency: 1 }))).errors).toEqual([]);
    expect(spies.map((spy) => spy.mock.calls.length)).toEqual(spies.map(() => 0));
    stubEnv(ENV_EMBEDDINGS, "off");
    try {
      expect(resultOf(parsed(await runScenario(diskSide(root), new HeadingsProvider(), { concurrency: 1 }))).errors).toEqual([]);
    } finally {
      restoreEnv();
    }
    expect(spies.map((spy) => spy.mock.calls.length > 0)).toEqual(spies.map(() => true));
    // Both recoveries of the ROOT run: the gate's own, then compile's own.
    expect(recover.mock.calls.length).toBe(2);
  });
});
