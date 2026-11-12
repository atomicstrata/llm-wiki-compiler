/**
 * @file test/storage/workflow-status-binding.test.ts
 * @description Workflow status and the `workflow-run-health` lint rule as WHOLE
 * consumers with no project directory: `workflowStatusFrom`,
 * `checkWorkflowRunHealthFrom`, the workflow-scoped `workflowStatusForWorkflowFrom`
 * and, under them, `readRunFrom`. They exist only
 * after the run store was given reads of its own, so this file has NO
 * before-edit run.
 *
 * HOW IT IS BUILT. One project is minted on real disk, once: the fixture
 * workflow profile is installed and the real `startWorkflow` writes one signed
 * run. The run's raw text, the runs listing and the profile text are read back.
 * The disk `workflowStatus` and `checkWorkflowRunHealth` then answer for that
 * run, for three texts planted in its place one at a time, and for the run
 * with its key file removed; `workflowStatusForWorkflow` answers for the run's
 * own workflow, another one, and the corrupt text. The directory is removed
 * before any case runs.
 *
 * THE KEY. No case reads the key file and no key text is held here. The
 * integrity computation is taken ONCE from the disk binding's `loadIntegrity`
 * while the project exists; the key stays inside that function.
 *
 * WHAT RUNS FOR REAL IN MEMORY. The profile load, the run parse, the schema,
 * shape and version-chain gates, canonicalization, the HMAC, the constant-time
 * comparison, the process-authority check, classification and the lint
 * mapping. Inputs are raw TEXT; no parsed run, no verdict and no profile is
 * handed to a body.
 *
 * WHAT IS NOT SHOWN. A legacy-unsigned or migrated record, a product-mode
 * binding, an oversize or linked leaf, and whether the per-run reads overlap in
 * time: one run is listed in most cases. The doubles are a few strings and a
 * call log. They are not a store, not an access-control layer and not
 * `ProjectStore`, and they show nothing about confinement on disk.
 */

import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import { checkWorkflowRunHealth, checkWorkflowRunHealthFrom } from "../../src/linter/workflow-run-rule.js";
import type { LintResult } from "../../src/linter/types.js";
import type { RunIntegrityComputation } from "../../src/workflow-history/integrity.js";
import { workflowStatus, workflowStatusForWorkflow, type RunStatus } from "../../src/workflow-history/status.js";
import { workflowStatusForWorkflowFrom, workflowStatusFrom, type WorkflowStatusSources } from "../../src/workflow-history/status-read.js";
import { diskWorkflowRunReads, readRunFrom, type WorkflowRunReads } from "../../src/workflow-history/store.js";
import { startWorkflow } from "../../src/workflows/start.js";
import { LLMWIKI_DIR, MAX_WORKFLOW_RUN_BYTES, PROFILE_FILE } from "../../src/utils/constants.js";
import { installWorkflowProfile } from "../fixtures/workflow-profile.js";
import { tempRootTracker } from "../temp-roots.js";
import { countOf, effectiveProfileOf, mintOnceThenRemove, type Copy } from "./copied-project.js";
import { expectMintingDirectoryRemoved } from "./minted-directory.js";

const PREFIX = "wf-status-";
const RUNS_REL = `${LLMWIKI_DIR}/workflows/runs`;
const BLOCKED = "blocked-by-config";

/** The three texts planted in the run's place, from its raw text. */
function plantedTexts(raw: string): Record<string, string> {
  const parsed = JSON.parse(raw) as { integrity: string };
  const flipped = (parsed.integrity.startsWith("0") ? "1" : "0") + parsed.integrity.slice(1);
  return {
    respaced: JSON.stringify(parsed, null, 4),
    "mac-flipped": JSON.stringify({ ...parsed, integrity: flipped }),
    corrupt: "{",
  };
}

/** What the minted project left behind. */
interface Held {
  dir: string;
  runId: string;
  raw: string;
  names: string[];
  profileText: string;
  integrity: RunIntegrityComputation | null;
  texts: Record<string, string>;
  all: RunStatus[];
  one: RunStatus[];
  lint: LintResult[];
  planted: Record<string, RunStatus[]>;
  plantedLint: Record<string, LintResult[]>;
  keyless: RunStatus[];
  /** The disk's workflow-scoped answers: the run's own workflow, another one, and the corrupt text under its own. */
  scoped: { own: RunStatus[]; other: RunStatus[]; corrupt: RunStatus[] };
}

const tracker = tempRootTracker();
let held: Held;

/** Mint the project, take every disk answer, and keep only texts and the computation. */
async function mint(): Promise<Held> {
  const dir = await tracker.create(PREFIX, { real: true });
  await installWorkflowProfile(dir);
  const { runId } = await startWorkflow(dir, "build", {});
  const leaf = path.join(dir, RUNS_REL, `${runId}.json`);
  const raw = await readFile(leaf, "utf8");
  const first = { all: await workflowStatus(dir), one: await workflowStatus(dir, runId), lint: await checkWorkflowRunHealth(dir) };
  const scoped = { own: await workflowStatusForWorkflow(dir, "build"), other: await workflowStatusForWorkflow(dir, "other"), corrupt: [] as RunStatus[] };
  const integrity = await diskWorkflowRunReads(dir).loadIntegrity();
  const texts = plantedTexts(raw);
  const planted: Record<string, RunStatus[]> = {};
  const plantedLint: Record<string, LintResult[]> = {};
  for (const [name, text] of Object.entries(texts)) {
    await writeFile(leaf, text, "utf8");
    planted[name] = await workflowStatus(dir);
    plantedLint[name] = await checkWorkflowRunHealth(dir);
    if (name === "corrupt") scoped.corrupt = await workflowStatusForWorkflow(dir, "build");
  }
  await writeFile(leaf, raw, "utf8");
  const names = await readdir(path.join(dir, RUNS_REL));
  const profileText = await readFile(path.join(dir, PROFILE_FILE), "utf8");
  await rm(path.join(dir, LLMWIKI_DIR, "workflows", ".runkey"));
  const keyless = await workflowStatus(dir);
  return { dir, runId, raw, names, profileText, integrity, texts, ...first, planted, plantedLint, keyless, scoped };
}

mintOnceThenRemove(tracker, async () => { held = await mint(); });

/** The run reads over held text: one run leaf (or none), the held listing, the held computation. Every call is logged first. */
function runsOf(text: string | undefined, log: string[], over: Partial<WorkflowRunReads> = {}): WorkflowRunReads {
  const note = (call: string): void => { log.push(call); };
  return {
    resolvePrivateDir: async () => { note("runs.private"); return "mem:private"; },
    resolveRunsDir: async (privateDir) => { note(`runs.dir ${privateDir}`); return { kind: "ok", dir: "mem:runs" }; },
    listRunNames: async (runsDir) => { note(`runs.list ${runsDir}`); return held.names; },
    readRunLeaf: async (runsDir, name, maxBytes) => {
      note(`runs.leaf ${runsDir}/${name} max=${maxBytes}`);
      return name === `${held.runId}.json` && text !== undefined ? { kind: "ok", body: text } : { kind: "absent" };
    },
    loadIntegrity: async () => { note("runs.integrity"); return held.integrity; },
    ...over,
  };
}

/** The status sources over held text: the real profile loader's sources over the profile text, and {@link runsOf}. */
function sourcesOf(text: string | undefined, log: string[], over: Partial<WorkflowRunReads> = {}): WorkflowStatusSources {
  const copy: Copy = { files: new Map([[PROFILE_FILE, held.profileText]]), listings: new Map() };
  return { profile: effectiveProfileOf(copy, (call) => { log.push(call); }), runs: runsOf(text, log, over) };
}

const runCalls = (log: string[]): string[] => log.filter((call) => call.startsWith("runs."));
const bindingLooks = (log: string[]): number => log.filter((call) => call.startsWith("binding.readBindingLeaf")).length;
const leafCall = (id: string): string => `runs.leaf mem:runs/${id}.json max=${MAX_WORKFLOW_RUN_BYTES}`;
const readOne = (id: string): string[] => ["runs.private", "runs.dir mem:private", leafCall(id)];
const LISTED = ["runs.private", "runs.dir mem:private", "runs.list mem:runs"];
const problemRow = (runId: string, problem: string): RunStatus => ({ runId, classification: BLOCKED, problem });
const storeRow = (detail: string): RunStatus =>
  ({ runId: "(store)", classification: BLOCKED, problem: `run store unavailable: ${detail}`, storeLevel: true });
/** One store-fault row: a title, the reads replaced for the case, and the store detail expected. */
type StoreFault = readonly [title: string, over: Partial<WorkflowRunReads>, detail: string];
/** One no-runs row: a title and the reads replaced for the case. */
type NoRuns = readonly [title: string, over: Partial<WorkflowRunReads>];
const STORE_FAULTS: readonly StoreFault[] = [
  ["a private directory that rejects", { resolvePrivateDir: async () => { throw new Error("outside"); } }, "escape"],
  ["a runs directory that escapes", { resolveRunsDir: async () => ({ kind: "escape" }) }, "escape"],
  ["a listing that rejects", { listRunNames: async () => { throw new Error("EACCES"); } }, "readdir-failed"],
];
const NO_RUNS: readonly NoRuns[] = [
  ["no private directory", { resolvePrivateDir: async () => null }],
  ["no runs directory", { resolveRunsDir: async () => ({ kind: "absent" }) }],
];

describe("workflow status over sources, with no project directory", () => {
  it("was minted once, is gone, and holds a computation and no key text", () => {
    expectMintingDirectoryRemoved(held.dir, PREFIX);
    expect(held.names).toEqual([`${held.runId}.json`]);
    expect(held.integrity?.("x")).toMatch(/^[0-9a-f]{64}$/);
    expect(held.all).toHaveLength(1);
    expect(held.all[0]).toMatchObject({ runId: held.runId, classification: "current" });
    expect(held.all[0]).not.toHaveProperty("problem");
  });

  it("answers as the disk did for every run, loading the profile once and first", async () => {
    const log: string[] = [];
    expect(await workflowStatusFrom(sourcesOf(held.raw, log), undefined)).toEqual(held.all);
    expect(runCalls(log)).toEqual([...LISTED, ...readOne(held.runId), "runs.integrity"]);
    expect(countOf(log, "leaf profile.json")).toBe(1);
    expect(log.indexOf("leaf profile.json")).toBeLessThan(log.indexOf("runs.private"));
    // One look at the binding for the profile, and one for the readable run's authority, after its integrity load.
    expect(bindingLooks(log)).toBe(2);
    expect(log.at(-1)?.startsWith("binding.readBindingLeaf")).toBe(true);
    expect(log.lastIndexOf("runs.integrity")).toBe(log.length - 2);
  });

  it("answers as the disk did for one run by id", async () => {
    const log: string[] = [];
    expect(await workflowStatusFrom(sourcesOf(held.raw, log), held.runId)).toEqual(held.one);
    expect(held.one).toEqual(held.all);
    expect(runCalls(log)).toEqual([...LISTED, ...readOne(held.runId), "runs.integrity"]);
  });

  it.each([
    ["respaced", undefined, 2],
    ["mac-flipped", "integrity", 1],
    ["corrupt", "corrupt", 1],
  ] as const)("reads planted text %s as the disk did", async (name, problem, looks) => {
    const log: string[] = [];
    const rows = await workflowStatusFrom(sourcesOf(held.texts[name], log));
    expect(rows).toEqual(held.planted[name]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.problem).toBe(problem);
    expect(rows[0]!.classification).toBe(problem === undefined ? "current" : BLOCKED);
    expect(rows[0]!.run === undefined).toBe(problem !== undefined);
    // The computation is loaded for a leaf that will not parse too; authority is asked only for a readable run.
    expect(countOf(log, "runs.integrity")).toBe(1);
    expect(bindingLooks(log)).toBe(looks);
  });

  it("fails every record closed when the store has no computation, as the disk did without its key", async () => {
    const log: string[] = [];
    const none = { loadIntegrity: async () => { log.push("runs.integrity"); return null; } };
    const rows = await workflowStatusFrom(sourcesOf(held.raw, log, none));
    expect(rows).toEqual(held.keyless);
    expect(rows).toEqual([problemRow(held.runId, "integrity")]);
  });

  it.each([
    ["absent", { kind: "absent" }, "run file absent"],
    ["unavailable", { kind: "unavailable" }, "leaf"],
  ] as const)("reports a listed run whose leaf is %s without loading the computation", async (_name, read, problem) => {
    const log: string[] = [];
    const over = { readRunLeaf: async (_dir: string, name: string) => { log.push(`leaf ${name}`); return read; } };
    expect(await workflowStatusFrom(sourcesOf(held.raw, log, over))).toEqual([problemRow(held.runId, problem)]);
    expect(countOf(log, "runs.integrity")).toBe(0);
    expect(bindingLooks(log)).toBe(1);
  });

  it.each(STORE_FAULTS)("surfaces %s as one store-level row", async (_name, over, detail) => {
    const log: string[] = [];
    expect(await workflowStatusFrom(sourcesOf(held.raw, log, over))).toEqual([storeRow(detail)]);
    expect(await workflowStatusFrom(sourcesOf(held.raw, log, over), held.runId)).toEqual([storeRow(detail)]);
    expect(log.filter((call) => call.startsWith("runs.leaf"))).toEqual([]);
  });

  it.each(NO_RUNS)("reads %s as no runs, and an id there as unknown", async (_name, over) => {
    const log: string[] = [];
    expect(await workflowStatusFrom(sourcesOf(held.raw, log, over))).toEqual([]);
    expect(await workflowStatusFrom(sourcesOf(held.raw, log, over), held.runId))
      .toEqual([problemRow(held.runId, "unknown or invalid run id")]);
    expect(await readRunFrom(runsOf(held.raw, log, over), held.runId)).toEqual({ status: "absent" });
    expect(countOf(log, "runs.integrity")).toBe(0);
  });

  it("asks the run store nothing for an invalid id", async () => {
    const log: string[] = [];
    expect(await workflowStatusFrom(sourcesOf(held.raw, log), "../escape"))
      .toEqual([problemRow("../escape", "unknown or invalid run id")]);
    expect(await readRunFrom(runsOf(held.raw, log), "../escape")).toEqual({ status: "unavailable", detail: "bad-id" });
    expect(runCalls(log)).toEqual([]);
    expect(countOf(log, "leaf profile.json")).toBe(1);
  });

  it("keeps the listing's own order and drops names that are not slug-safe run files", async () => {
    const log: string[] = [];
    const names = ["zeta.json", ".runkey", `${held.runId}.json`, "notes.txt", "Bad Name.json", "alpha.json"];
    const rows = await workflowStatusFrom(sourcesOf(held.raw, log, { listRunNames: async () => names }));
    expect(rows.map((row) => row.runId)).toEqual(["zeta", held.runId, "alpha"]);
    expect(rows[0]).toEqual(problemRow("zeta", "run file absent"));
    expect(rows[1]).toEqual(held.all[0]);
    expect(rows[2]).toEqual(problemRow("alpha", "run file absent"));
    expect(log.filter((call) => call.startsWith("runs.leaf"))).toEqual(["zeta", held.runId, "alpha"].map(leafCall));
    expect(bindingLooks(log)).toBe(2);
  });

  it("turns a rejected authority resolution into a problem row that carries the run", async () => {
    const log: string[] = [];
    const sources = sourcesOf(held.raw, log);
    const binding = sources.profile.activeProduct.binding;
    const read = binding.readBindingLeaf.bind(binding);
    let looks = 0;
    binding.readBindingLeaf = async (maxBytes) => {
      looks += 1;
      if (looks > 1) throw new Error("binding gone");
      return read(maxBytes);
    };
    const rows = await workflowStatusFrom(sources);
    expect(rows).toEqual([{ runId: held.runId, classification: BLOCKED, run: held.all[0]!.run, problem: "binding gone" }]);
    expect(looks).toBe(2);
  });

  it("rejects, and reads no run, when the profile load rejects", async () => {
    const log: string[] = [];
    const sources = sourcesOf(held.raw, log);
    sources.profile.readPrivateLeafText = async () => { throw new Error("profile read failed"); };
    await expect(workflowStatusFrom(sources)).rejects.toThrow("profile read failed");
    expect(runCalls(log)).toEqual([]);
  });
});

describe("the workflow-run lint rule over sources", () => {
  it("finds nothing for the healthy run, as the disk rule did", async () => {
    expect(await checkWorkflowRunHealthFrom(sourcesOf(held.raw, []))).toEqual(held.lint);
    expect(held.lint).toEqual([]);
  });

  it.each(["mac-flipped", "corrupt"] as const)("reports planted text %s as the disk rule did", async (name) => {
    const found = await checkWorkflowRunHealthFrom(sourcesOf(held.texts[name], []));
    expect(found).toEqual(held.plantedLint[name]);
    const problem = name === "corrupt" ? "corrupt" : "integrity";
    expect(found).toEqual([{
      rule: "workflow-run-health", severity: "warning", file: RUNS_REL, message: `run-problem: ${held.runId}: ${problem}`,
    }]);
  });

  it("reports an unavailable store once", async () => {
    const over: Partial<WorkflowRunReads> = { resolveRunsDir: async () => ({ kind: "escape" }) };
    expect(await checkWorkflowRunHealthFrom(sourcesOf(held.raw, [], over))).toEqual([{
      rule: "workflow-run-health", severity: "warning", file: RUNS_REL,
      message: "run-problem: (store): run store unavailable: escape",
    }]);
  });
});

describe("workflow status scoped to one workflow, over sources", () => {
  it("keeps the readable run under its own workflow and drops it under another, as the disk did", async () => {
    expect(await workflowStatusForWorkflowFrom(sourcesOf(held.raw, []), "build")).toEqual(held.scoped.own);
    expect(await workflowStatusForWorkflowFrom(sourcesOf(held.raw, []), "other")).toEqual(held.scoped.other);
    expect([held.scoped.own, held.scoped.other]).toEqual([held.all, []]);
  });

  it("stands one id-free row in for an unreadable run, as the disk did, and keeps a store-level row", async () => {
    const rows = await workflowStatusForWorkflowFrom(sourcesOf(held.texts.corrupt, []), "build");
    expect(rows).toEqual(held.scoped.corrupt);
    expect(rows).toEqual([{ runId: "(unreadable)", classification: BLOCKED, problem: expect.stringMatching(/^one or more run records/), storeLevel: true }]);
    expect(JSON.stringify(rows)).not.toContain(held.runId);
    const [, escape, detail] = STORE_FAULTS[0];
    expect(await workflowStatusForWorkflowFrom(sourcesOf(held.raw, [], escape), "other")).toEqual([storeRow(detail)]);
  });
});
