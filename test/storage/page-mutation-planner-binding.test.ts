/**
 * @file test/storage/page-mutation-planner-binding.test.ts
 * @description The page-mutation PLANNER, WHOLE, with its mandatory floor, over
 * target probes held in memory: `planPageMutationFrom` runs the identity floor
 * and the four mandatory checks (`runMandatoryPageChecksFrom`), composes the
 * decision, and only on a live-write decision asks whether the target exists to
 * choose create, update or delete. It exists only after the planner was given a
 * body of its own, so this file has NO before-edit run. The executor, page
 * apply, journal and locks are not run here.
 *
 * HOW IT IS BUILT. One project is minted on real disk, once, and copied BEFORE
 * its disk ask (`mintCopiedBeforeAsk`). The disk ask runs every step through the
 * real root form `planPageMutation` and settles each exactly once (the whole
 * plan result as JSON, or the error). The minting directory is removed before
 * any case runs, and the copy is checked LITERALLY against the seed before every
 * memory replay. The memory side runs the same steps through the bound body over
 * two probe doubles on the copy: a lexical confinement and a presence lookup.
 * Expected decisions, operations and messages are written out from the source
 * rules, never taken from either side's output.
 *
 * WHAT IS MEMORY ONLY. The probe order, the injected probe faults, and the proof
 * that the bound body makes no ambient disk call. Real confinement (links,
 * escaping ancestors) stays with the incumbent `trust-checks` suite.
 */

import path from "node:path";
import { describe, expect, it, vi } from "bun:test";
import * as diskLeaves from "../../src/storage/disk-guarded-leaves.js";
import { mandatoryPageChecks, mandatoryPageChecksFrom, type PageTargetProbes } from "../../src/trust/checks.js";
import { planPageMutation, planPageMutationFrom, type PlanPageInput } from "../../src/trust/planner.js";
import { MAX_SOURCE_CHARS } from "../../src/utils/constants.js";
import * as confine from "../../src/utils/path-confine.js";
import { tempRootTracker } from "../temp-roots.js";
import { type Copy } from "./copied-project.js";
import { expectMintingDirectoryRemoved } from "./minted-directory.js";
import { expectHoldsExactly, mintSeededBeforeAsk } from "./project-tree.js";

const PREFIX = "page-mutation-planner-binding-";
const MEM_ROOT = path.resolve("/memory/project");
const GOOD = "---\ntitle: Ok\n---\n\nbody\n";
const BAD_FRONTMATTER = "---\ntitle: : : bad\n  nope\n---\n\nbody\n";
const BIG = GOOD + "x".repeat(MAX_SOURCE_CHARS);
const SEED = { "wiki/concepts/existing.md": GOOD, "wiki/papers/known.md": GOOD };
const native = (...parts: string[]): string => parts.join(path.sep);

type Step = Omit<PlanPageInput, "root">;
const raw = (slug: string, extra: Partial<Step> = {}): Step =>
  ({ target: { kind: "raw", directory: "concepts", slug }, body: GOOD, origin: "agent", reviewRouted: false, ...extra });
const entity = (slug: string, extra: Partial<Step> = {}): Step =>
  ({ target: { kind: "entity", entityType: "papers", slug }, body: GOOD, origin: "agent", reviewRouted: false, ...extra });
const STEPS: Step[] = [
  raw("fresh"), raw("existing"), raw("existing", { reviewRouted: true }), raw("existing", { allowOverwrite: true }),
  raw("existing", { allowOverwrite: true, deleting: true }), entity("known", { allowOverwrite: true }), entity("novel"), entity("../../../escape"),
  raw("café-society"), raw("big", { body: BIG, origin: "compile" }), raw("big", { body: BIG }), raw("bad", { body: BAD_FRONTMATTER }),
];
type Plan = (step: Step) => Promise<unknown>;
interface Outcome { planned: { operation: string; target: Record<string, string> }[]; decision: string; checks: { code: string; verdict: string; message: string }[] }

/** Run steps in order, settling each exactly once. */
async function runSteps(plan: Plan): Promise<string[]> {
  const outcomes: string[] = [];
  for (const step of STEPS) outcomes.push(await plan(step).then((value) => JSON.stringify(value), (error: Error) => `${error.name}: ${error.message}`));
  return outcomes;
}

const tracker = tempRootTracker();
const minted = mintSeededBeforeAsk(tracker, PREFIX, SEED, (root) => runSteps((step) => planPageMutation({ ...step, root })));

/** The copy, after requiring LITERALLY that it holds exactly the seed. */
function seededCopy(): Copy {
  expectHoldsExactly(minted.copy.files, SEED);
  return minted.copy;
}

/** Probe faults with no disk twin: a confinement or a presence probe that rejects. */
interface Faults { confine?: Error; present?: Error }

/** Lexical confinement and copy presence over native paths under `MEM_ROOT`; every probe logged. */
function memoryProbesOf(copy: Copy, log: string[], faults: Faults = {}): PageTargetProbes {
  return {
    confineTarget: async (targetPath, root) => {
      log.push(`confine ${targetPath}`);
      if (faults.confine) throw faults.confine;
      const relative = path.relative(root, path.resolve(root, targetPath));
      if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error(`escapes: ${targetPath}`);
      return path.resolve(root, targetPath);
    },
    leafPresent: async (dir, name) => {
      const rel = path.relative(MEM_ROOT, path.join(dir, name)).split(path.sep).join("/");
      log.push(`present ${rel}`);
      if (faults.present) throw faults.present;
      return copy.files.has(rel);
    },
  };
}

/** The bound planner over the copy; `MEM_ROOT` is the root it is handed as data. */
const memoryPlan = (probes: PageTargetProbes): Plan => (step) => planPageMutationFrom(probes, { ...step, root: MEM_ROOT });

/** Replay every step in memory from the seeded copy and require the disk's outcomes. */
async function expectDiskParity(): Promise<Outcome[]> {
  const outcomes = await runSteps(memoryPlan(memoryProbesOf(seededCopy(), [])));
  expect(outcomes).toEqual(minted.onDisk);
  return outcomes.map((outcome) => JSON.parse(outcome) as Outcome);
}
/** The codes of the checks that blocked. */
function blocked(outcome: Outcome): string[] {
  return outcome.checks.filter((check) => check.verdict === "block").map((check) => check.code);
}

/** The decision and the planned operations. */
function shape(outcome: Outcome): [string, string[]] {
  return [outcome.decision, outcome.planned.map((one) => one.operation)];
}

describe("the page-mutation planner over a copied project, with the minting directory gone", () => {
  it("P1 runs after the minting directory was removed, on a copy holding exactly the seed", () => {
    expectMintingDirectoryRemoved(minted.dir, PREFIX);
    seededCopy();
  });

  it("P2 creates a free page, blocks or stages a collision, and updates or deletes on intent, as the disk did", async () => {
    const [free, collide, staged, update, remove] = await expectDiskParity();
    expect([shape(free!), shape(collide!), shape(staged!), shape(update!), shape(remove!)])
      .toEqual([["allow", ["create"]], ["deny", []], ["stage-for-review", []], ["allow", ["update"]], ["allow", ["delete"]]]);
    expect(collide!.checks.find((check) => check.code === "target-exists")!.message).toBe("target already exists (create-only): existing.md");
    expect(update!.checks.find((check) => check.code === "target-exists")!.message).toBe("target exists; intended overwrite (update): existing.md");
  });

  // `../../../escape` resolves outside the root (`wiki/papers/../../../escape.md`), so the path checks block too.
  it("P3 plans typed pages by slug-safe identity and refuses a traversal identity by decision, as the disk did", async () => {
    const [, , , , , known, novel, escape] = await expectDiskParity();
    expect([shape(known!), known!.planned[0]!.target.id, shape(novel!), shape(escape!)])
      .toEqual([["allow", ["update"]], "papers/known", ["allow", ["create"]], ["deny", []]]);
    expect(blocked(escape!).sort()).toEqual(["invalid-identity", "path-escape", "target-exists"]);
  });

  it("P4 keeps a Unicode default slug, caps a body by its origin, and refuses malformed frontmatter, as the disk did", async () => {
    const [, , , , , , , , unicode, compiled, agent, bad] = await expectDiskParity();
    expect([shape(unicode!), shape(compiled!), shape(agent!), blocked(agent!), shape(bad!), blocked(bad!)])
      .toEqual([["allow", ["create"]], ["allow", ["create"]], ["deny", []], ["resource-limit"], ["deny", []], ["frontmatter-invalid"]]);
    expect(agent!.checks.find((check) => check.code === "resource-limit")!.message).toBe(`body ${BIG.length} chars exceeds cap of ${MAX_SOURCE_CHARS}`);
  });

  it("P5 issues both confinement probes before the collision presence probe, and probes presence for the create choice only on a live write (memory only)", async () => {
    const [free, collide] = [[], []] as string[][];
    await memoryPlan(memoryProbesOf(seededCopy(), free))(STEPS[0]!);
    await memoryPlan(memoryProbesOf(seededCopy(), collide))(STEPS[1]!);
    const at = (slug: string) => [`confine ${native("wiki", "concepts", `${slug}.md`)}`, `present wiki/concepts/${slug}.md`];
    expect(free).toEqual([at("fresh")[0], at("fresh")[0], at("fresh")[1], ...at("fresh")]);
    expect(collide).toEqual([at("existing")[0], at("existing")[0], at("existing")[1]]);
  });

  it("P6 blocks on a confinement fault and reads a presence fault as free, without short-circuiting the floor (memory only)", async () => {
    const fault = Object.assign(new Error("EACCES: probe refused"), { code: "EACCES" });
    const unconfined = await memoryPlan(memoryProbesOf(seededCopy(), [], { confine: fault }))(STEPS[3]!) as Outcome;
    const unknown = await memoryPlan(memoryProbesOf(seededCopy(), [], { present: fault }))(STEPS[1]!) as Outcome;
    expect([shape(unconfined), blocked(unconfined).sort(), unconfined.checks.length]).toEqual([["deny", []], ["path-escape", "target-exists"], 5]);
    expect([shape(unknown), unknown.checks.find((check) => check.code === "target-exists")!.message]).toEqual([["allow", ["create"]], "target path is free"]);
  });

  it("P7 makes no ambient disk call in the bound body, while the root form still reaches the disk primitives", async () => {
    const confined = vi.spyOn(confine, "confineUnderRoot");
    const present = vi.spyOn(diskLeaves, "leafPresent");
    await runSteps(memoryPlan(memoryProbesOf(seededCopy(), [])));
    expect([confined.mock.calls.length, present.mock.calls.length, mandatoryPageChecksFrom(memoryProbesOf(seededCopy(), [])).length]).toEqual([0, 0, mandatoryPageChecks.length]);
    await planPageMutation({ ...STEPS[0]!, root: await tracker.create(PREFIX) });
    expect([confined.mock.calls.length > 0, present.mock.calls.length > 0]).toEqual([true, true]);
  });
});
