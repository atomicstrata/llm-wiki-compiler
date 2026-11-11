/**
 * @file test/storage/compile-orphan-binding.test.ts
 * @description Compile's ORPHAN PASSES and its PAGE-WRITE leg, WHOLE, with no
 * ambient disk: `markOrphanedWith` and `orphanUnownedFrozenPagesWith` over a
 * memory page read, the real dropped-read warning body over a memory presence
 * probe, and `applyCompilePageWritesWith` composed from the REAL planner body
 * (`planPageMutationFrom`) and the REAL held-lock executor body
 * (`applyApprovedMutationsLockedFrom`) over raw journal and page I/O held in one
 * map. The bodies exist only after these consumers were given bodies of their
 * own, so this file has NO before-edit run.
 *
 * HOW IT IS BUILT. One project is minted on real disk, once, and copied BEFORE
 * its disk ask (`mintCopiedBeforeAsk`). Its seed covers an exclusive page, a
 * shared one, an already-orphaned one, one whose frontmatter the floor refuses,
 * a frozen unowned page, an owned frozen page, an absent slug, an unsafe slug and
 * a symlinked page escaping its directory. The ask runs the ROOT `markOrphaned`
 * then `orphanUnownedFrozenPages` over one draft, settling each once with the
 * status lines, the sources the draft forgot and the whole tree. The memory
 * replay must equal the disk, and both must equal the literals here.
 *
 * WHAT IS MEMORY ONLY, AND NOT A REAL GUARD. The memory page read (an absent or
 * linked page is simply `escapes-dir`), the presence probe, the write fault and
 * the option accessors. Real confinement, links, the floor on disk and crash
 * recovery stay with `compile-write`, `compile-reroute-phases`,
 * `executor-held-lock-binding` and the confined-read suites. Status lines go to
 * the incumbent `output.status` on both sides and are captured there.
 */

import { symlink } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "bun:test";
import * as confinedWikiRead from "../../src/compiler/confined-wiki-read.js";
import type { CompileStateDraft } from "../../src/compiler/compile-state-draft.js";
import * as compileWrite from "../../src/compiler/compile-write.js";
import {
  applyCompilePageWritesWith, type BeforeCompilePageWrites, type CompilePageWrite, type CompilePageWriteSteps,
} from "../../src/compiler/compile-write.js";
import {
  markOrphaned, markOrphanedWith, orphanUnownedFrozenPages, orphanUnownedFrozenPagesWith, type OrphanDraft, type OrphanPassSteps,
} from "../../src/compiler/orphan.js";
import * as diskLeaves from "../../src/storage/disk-guarded-leaves.js";
import * as executor from "../../src/trust/executor.js";
import { applyApprovedMutationsLockedFrom, type ApprovedMutationPorts, type WriteOne } from "../../src/trust/executor.js";
import * as planner from "../../src/trust/planner.js";
import * as output from "../../src/utils/output.js";
import * as confine from "../../src/utils/path-confine.js";
import type { WikiState } from "../../src/utils/types.js";
import { tempRootTracker } from "../temp-roots.js";
import { mintCopiedBeforeAsk, writeFiles } from "./copied-project.js";
import { captureStatusLines, diskTree, expectBoundSilentThenFreshRoot, expectHoldsExactly, mintSingle, regularFiles, sortedTree } from "./project-tree.js";
import { keyOf, MEM_ROOT, memoryOrphanSteps, memoryPorts, memoryStores, put, type Held } from "./compile-memory-steps.js";
import { expectMintingDirectoryRemoved } from "./minted-directory.js";

const PREFIX = "compile-orphan-binding-";
const C = "wiki/concepts";
const page = (title: string): string => `---\ntitle: ${title}\n---\n\n${title.toLowerCase()}\n`;
const orphaned = (title: string): string => `---\norphaned: true\ntitle: ${title}\n---\n\n${title.toLowerCase()}\n`;
const BAD = "---\ntitle: [unclosed\n---\n\nbad\n";
const SEED: Record<string, string> = {
  [`${C}/bad.md`]: BAD, [`${C}/frozen.md`]: page("Frozen"), [`${C}/kept.md`]: page("Kept"),
  [`${C}/old.md`]: "---\norphaned: true\ntitle: Old\n---\n\nold\n", [`${C}/shared.md`]: page("Shared"), [`${C}/solo.md`]: page("Solo"),
  "outside.md": "outside\n",
};
const GONE = ["solo", "shared", "old", "bad", "ghost", "link", "../evil"];

/** A draft over a fresh state (`gone.md` owns `gone`, `live.md` owns shared and kept) that records what it forgot. */
function fakeDraft(gone: string[] = GONE): OrphanDraft & { removed: string[] } {
  const source = (concepts: string[]) => ({ hash: "h", concepts, compiledAt: "t" });
  const state: WikiState = { version: 1, indexHash: "", sources: { "gone.md": source(gone), "live.md": source(["shared", "kept"]) } };
  const removed: string[] = [];
  return { removed, read: () => state, removeSource: (file) => { removed.push(file); delete state.sources[file]; } };
}

/** One orphan surface, root or bound, over one project. */
interface Side {
  mark(draft: OrphanDraft): Promise<void>;
  frozen(draft: OrphanDraft, slugs: Set<string>): Promise<void>;
  tree(): Promise<Record<string, string>>;
}

/** Mark the deleted source, then orphan the unowned frozen slugs; each settled once with statuses, forgotten sources and tree. */
async function runScenario(side: Side): Promise<string[]> {
  const statuses: string[] = [];
  const status = captureStatusLines(statuses);
  const draft = fakeDraft();
  const out: string[] = [];
  const settle = async (name: string, act: () => Promise<void>): Promise<void> => {
    const settled = await act().then(() => "ok", (error: Error) => `${error.name}: ${error.message}`);
    out.push(JSON.stringify({ name, settled, statuses: statuses.splice(0), removed: [...draft.removed], tree: await side.tree() }));
  };
  try {
    await settle("mark", () => side.mark(draft));
    await settle("frozen", () => side.frozen(draft, new Set(["frozen", "kept", "shared"])));
  } finally {
    status.mockRestore();
  }
  return out;
}

/** Seed the pages and one link escaping the concepts directory. */
async function seed(root: string): Promise<void> {
  await writeFiles(root, SEED);
  await symlink(path.join("..", "..", "outside.md"), path.join(root, C, "link.md"));
}

const tracker = tempRootTracker();
const minted = mintSingle<string[]>(tracker, () => mintCopiedBeforeAsk(tracker, PREFIX, seed, (root) => runScenario({
  mark: (draft) => markOrphaned(root, "gone.md", draft as unknown as CompileStateDraft),
  frozen: (draft, slugs) => orphanUnownedFrozenPages(root, draft as unknown as CompileStateDraft, slugs),
  tree: () => diskTree(root, regularFiles),
})));

/** The copy, after requiring LITERALLY that it holds exactly the seed's files and the one link. */
function seededCopy(): Held {
  const files = minted.copy.files;
  expectHoldsExactly(files, SEED);
  const links = [...minted.copy.listings].flatMap(([dir, entries]) => entries.filter((e) => e.kind === "link").map((e) => `${dir}/${e.name}`));
  expect(links).toEqual([`${C}/link.md`]);
  return { files: new Map(files), dirs: new Set(minted.copy.listings.keys()), links: new Set(links) };
}

/** The bound compile write and orphan steps over one memory map (the shared test-only composition), every journal and page call logged, with a memory write unless `writeOne` is given. */
function memorySteps(log: string[], held: Held, writeOne?: WriteOne): { write: CompilePageWriteSteps; orphan: OrphanPassSteps; ports: ApprovedMutationPorts } {
  const { write, ports } = memoryPorts(held, { log, writeOne });
  return { write, orphan: memoryOrphanSteps(held, memoryStores(held).reads, write), ports };
}

/** The bound side over the seeded copy; with `failSecond`, the batch's second write throws (a memory fault). */
function memorySide(log: string[], failSecond = false): Side & { held: Held; ports: ApprovedMutationPorts } {
  const held = seededCopy();
  let writes = 0;
  const failing: WriteOne = async (filePath, content) => {
    writes += 1;
    if (writes === 2) throw new Error("injected write failure");
    put(held, keyOf(filePath), content);
  };
  const { orphan, ports } = memorySteps(log, held, failSecond ? failing : undefined);
  return {
    held, ports,
    mark: (draft) => markOrphanedWith(orphan, MEM_ROOT, "gone.md", draft),
    frozen: (draft, slugs) => orphanUnownedFrozenPagesWith(orphan, MEM_ROOT, draft, slugs),
    tree: async () => sortedTree(Object.fromEntries(held.files)),
  };
}

const MARKED = { ...SEED, [`${C}/solo.md`]: orphaned("Solo") };
const DROPPED = "! Dropped wiki read (escapes-dir): wiki/concepts/link.md — its content does not resolve under the project root and was NOT read or re-emitted.";

describe("compile's orphan passes over one copied project, with the minting directory gone", () => {
  it("O1 runs after the minting directory was removed, on a copy holding exactly the seed and its one link", () => {
    expectMintingDirectoryRemoved(minted.dir, PREFIX);
    seededCopy();
  });

  it("O2 orphans only the exclusive page, keeps shared, skips the orphaned, unsafe and absent, warns on the escaping link, lets the floor refuse one write, then orphans the unowned frozen page, as the disk did", async () => {
    const outcomes = await runScenario(memorySide([]));
    expect(outcomes).toEqual(minted.onDisk);
    expect(outcomes.map((line) => JSON.parse(line))).toEqual([
      { name: "mark", settled: "ok", removed: ["gone.md"], tree: MARKED,
        statuses: ["⚠ Orphaned: solo.md (source deleted)", "i Kept: shared.md (shared with other sources)", "⚠ Orphaned: bad.md (source deleted)", DROPPED] },
      { name: "frozen", settled: "ok", removed: ["gone.md"], tree: { ...MARKED, [`${C}/frozen.md`]: orphaned("Frozen") },
        statuses: ["⚠ Orphaned: frozen.md (no remaining sources)"] },
    ]);
  });
});

describe("the compile page-write body and the orphan pass over the real planner and executor bodies (memory only)", () => {
  const item = (slug: string, body: string): CompilePageWrite => ({ namespace: "concepts", slug, body });

  it("O3 plans every item; with nothing allowed it neither reads the hook nor reaches the executor; otherwise it reads the hook twice, calls it on opts with the allowed items, and hands the SAME opts on", async () => {
    const log: string[] = [];
    const held = seededCopy();
    const { write } = memorySteps(log, held);
    const applied: boolean[] = [];
    const calls: unknown[] = [];
    let reads = 0;
    const hook: BeforeCompilePageWrites = async function (this: unknown, items) { calls.push([this === opts, items.map((i) => i.slug)]); };
    const opts: { readonly beforeApply: BeforeCompilePageWrites } = { get beforeApply() { reads += 1; return hook; } };
    const steps: CompilePageWriteSteps = { plan: write.plan, apply: (root, planned, o) => { applied.push(o === opts); return write.apply(root, planned, o); } };
    const bad = item("bad", BAD);
    expect(await applyCompilePageWritesWith(steps, MEM_ROOT, [bad], opts)).toEqual({ skipped: [{ item: bad, reason: "floor:deny" }] });
    expect([reads, calls, applied, log.filter((call) => call.includes(".llmwiki"))]).toEqual([0, [], [], []]);
    expect(await applyCompilePageWritesWith(steps, MEM_ROOT, [item("fresh", page("Fresh")), bad], opts)).toEqual({ skipped: [{ item: bad, reason: "floor:deny" }] });
    expect([reads, calls, applied, held.files.get(`${C}/fresh.md`)]).toEqual([2, [[true, ["fresh"]]], [true], page("Fresh")]);
  });

  it("O4 leaves the draft holding the deleted source when the batch's second write fails, and the next executor call restores the first page", async () => {
    const side = memorySide([], true);
    const draft = fakeDraft(["solo", "frozen"]);
    vi.spyOn(output, "status").mockImplementation(() => {});
    await expect(side.mark(draft)).rejects.toThrow("injected write failure");
    expect([draft.removed, Object.keys(draft.read().sources), side.held.files.get(`${C}/solo.md`)]).toEqual([[], ["gone.md", "live.md"], orphaned("Solo")]);
    expect(await applyApprovedMutationsLockedFrom(side.ports, MEM_ROOT, [])).toEqual([]);
    expect(await side.tree()).toEqual(sortedTree(SEED));
  });
});

describe("the bound orphan route reaches no disk binding and no root collaborator", () => {
  /** The root collaborators and the disk primitives beneath them. */
  const spyAll = () => [
    vi.spyOn(confinedWikiRead, "readConfinedWikiPage"), vi.spyOn(confinedWikiRead, "warnDroppedWikiReadIfPresent"),
    vi.spyOn(compileWrite, "applyCompilePageWritesLocked"), vi.spyOn(planner, "planPageMutation"), vi.spyOn(executor, "applyApprovedMutationsLocked"),
    vi.spyOn(diskLeaves, "leafPresent"), vi.spyOn(diskLeaves, "readConfinedLeafText"), vi.spyOn(diskLeaves, "replaceLeafAtomicWithin"),
    vi.spyOn(diskLeaves, "writeLeafAtomicUnconfined"), vi.spyOn(diskLeaves, "removeLeaf"), vi.spyOn(confine, "confineUnderRoot"),
  ];

  it("O5 makes no ambient call in the bound bodies, while the root passes reach every root collaborator and disk primitive", async () => {
    const spies = spyAll();
    const root = await expectBoundSilentThenFreshRoot(spies, () => runScenario(memorySide([])), { tracker, prefix: PREFIX, seed });
    vi.spyOn(output, "status").mockImplementation(() => {});
    await markOrphaned(root, "gone.md", fakeDraft() as unknown as CompileStateDraft);
    expect(spies.map((spy) => spy.mock.calls.length > 0)).toEqual(spies.map(() => true));
  });
});
