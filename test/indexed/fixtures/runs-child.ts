/**
 * @file test/indexed/fixtures/runs-child.ts
 * @description A child process for batch run retirement tests, so every
 * process that opens a fixture's stores (a preview reads under a reader lease,
 * an apply must be a fresh collector, a held reader must be visible to the
 * census) is a REAL separate process. Vitest-free.
 *
 * Modes (arguments after the script):
 * - `build <root>`: a small corpus and `state.json`, prepared `local-indexed`
 *   WITH `segmented-compile-state-1` (the real set-and-prepare bodies).
 * - `run <root> <done|superseded|active> <none|pi|pi-raw|ih>`: one scratch run
 *   store, left in that phase; `pi`/`ih` checkpoint one publication intent or
 *   inherited row; `pi-raw` records an intent its attempt never checkpointed
 *   (a later attempt supersedes the run), raw evidence only. Prints its id.
 * - `last-run <root> <runId|null>`: FIXTURE SHORTCUT standing in for a
 *   committing compile: rewrite only the compile state's `lastRun` binding.
 * - `inherit <root>`: what a new restart would inherit now: a new run's
 *   `inheritPublished`, its sorted `ih:` keys (the run is left active).
 * - `preview <root> [keep]`; `apply <root> <planFile> [fail <step> | pause <readyFile> <goFile> | read <runId>]`
 *   (`read`: an independent read of a run's report in the SAME process while
 *   the apply holds the collection, its outcome code returned beside the result).
 * - `preview-apply <root>`: preview, then apply that plan in the same process.
 * - `cli <root> [args...]`: `llmwiki catalog runs --json` with `args`, run in
 *   `root`; returns the exit code and the envelope. `sdk-preview <root> <keep>`:
 *   the SDK facade's `runs.preview`.
 * - `hold <root> <runId> <readyFile> <goFile>`: read a run's report, announce,
 *   wait for the go file, read it again through the same snapshot.
 * - `report <root> <runId>`, `run-ids <root>`, `pin <root> <label>`, `backup <root> <dir>`.
 * - `barrier <root> [readyFile goFile]`: publish a retirement barrier as this
 *   process; with the files, announce and keep it live until the go file.
 * Each mode prints one JSON line: the outcome, or the error code.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { inheritPublished } from "../../../src/compiler/batch/inherit.js";
import { readReport } from "../../../src/compiler/batch/report.js";
import { BatchRun, runIds } from "../../../src/compiler/batch/run-store.js";
import { openCompileState } from "../../../src/cstate/store.js";
import { catalogRunsCommand } from "../../../src/commands/catalog-maintenance.js";
import { catalogBackup, catalogPin } from "../../../src/indexed/maintenance.js";
import { buildCatalogFacade } from "../../../src/sdk/catalog-facade.js";
import { applyRunRetirement, previewRunRetirement, type RunRetireApplyOptions } from "../../../src/indexed/run-retire.js";
import { publishRetireBarrier } from "../../../src/segments/retire-barrier.js";
import { runChildModes } from "./child-main.js";
import { prepareCompileStateProject } from "./compile-state-project.js";

/** The placeholder identity a scratch run records (no real compile binds it). */
const SCRATCH_IDENTITY = { policy: "p", sources: null, cstate: "c" };

/** Wait until `file` exists. */
async function waitFor(file: string): Promise<void> {
  while (!existsSync(file)) await sleep(10);
}

/** Prepare `root` indexed with the segmented compile state imported from a sample `state.json`. */
async function build(root: string): Promise<unknown> {
  const readiness = await prepareCompileStateProject(root);
  if (readiness !== "ready") throw new Error(`the fixture did not prepare: ${readiness}`);
  return { readiness };
}

/** Checkpoint one publication intent (`pi`) or inherited row (`ih`); distinct slugs, so a restart inheriting both holds two keys. */
async function checkpointedEvidence(run: BatchRun, evidence: "pi" | "ih"): Promise<void> {
  await run.put(evidence === "pi" ? `pi:intent-page\0${"a".repeat(64)}` : `ih:inherited-page\0${"c".repeat(64)}`, 1);
  await run.checkpoint();
}

/** Record an intent this attempt never checkpoints, then continue the run as a new attempt: raw evidence only. */
async function rawIntent(root: string, run: BatchRun): Promise<BatchRun> {
  await run.put(`pi:raw-page\0${"b".repeat(64)}`, 1);
  await run.persist();
  return BatchRun.resume(root, run.runId);
}

/** `run` with the requested publication evidence recorded (possibly as a later attempt). */
async function withEvidence(root: string, run: BatchRun, evidence: string): Promise<BatchRun> {
  if (evidence === "pi" || evidence === "ih") { await checkpointedEvidence(run, evidence); return run; }
  return evidence === "pi-raw" ? rawIntent(root, run) : run;
}

/** Create one scratch run left in `phase`, with the requested publication evidence. */
async function scratchRun(root: string, phase: string, evidence: string): Promise<unknown> {
  const run = await withEvidence(root, await BatchRun.create(root, { batchSize: 10, embeddings: false, identity: SCRATCH_IDENTITY }), evidence);
  if (phase !== "active") await run.advance(phase as "done" | "superseded");
  return { runId: run.runId };
}

/** Rewrite only the compile state's `lastRun` (a fixture shortcut for a committing compile). */
async function setLastRun(root: string, runId: string): Promise<unknown> {
  const store = await openCompileState(root);
  await store.commit({ meta: { ...store.meta, lastRun: runId === "null" ? null : runId } });
  return { lastRun: runId };
}

/** The keys a new restart would inherit now. */
async function inheritedKeys(root: string): Promise<unknown> {
  const run = await BatchRun.create(root, { batchSize: 10, embeddings: false, identity: SCRATCH_IDENTITY });
  await inheritPublished(run);
  const keys: string[] = [];
  for await (const row of run.scan("ih:")) keys.push(row.k);
  return { keys: keys.sort() };
}

/** The error code of `work`, or `ok`. */
async function codeOf(work: () => Promise<unknown>): Promise<string> {
  try { await work(); return "ok"; } catch (error) { return String((error as { code?: unknown }).code ?? error); }
}

/** The seam an apply runs with, and its two arguments: `fail <step>`, `pause <readyFile> <goFile>` or `read <runId>`. */
interface SeamRequest { readonly seam?: string; readonly first?: string; readonly second?: string }

/** The apply's test seams for `request`; an in-process read records its outcome code in `read`. */
function seamOptions(root: string, { seam, first, second }: SeamRequest, read: { code?: string }): Partial<RunRetireApplyOptions> {
  if (seam === "fail") return { stepForTest: async (step: string) => { if (step === first) throw new Error(`injected failure at ${step}`); } };
  if (seam === "pause") return { afterCensusForTest: async () => { writeFileSync(first!, "censused"); await waitFor(second!); } };
  return seam === "read" ? { afterCensusForTest: async () => { read.code = await codeOf(() => readReport(root, first!)); } } : {};
}

/** Apply a saved plan, optionally failing at one store step, pausing after the census, or reading in-process meanwhile. */
async function apply([root, planFile, seam, first, second]: string[]): Promise<unknown> {
  const read: { code?: string } = {};
  const result = await applyRunRetirement(root!, JSON.parse(readFileSync(planFile!, "utf8")), { readersOffline: true, ...seamOptions(root!, { seam, first, second }, read) });
  return read.code === undefined ? result : { ...result, concurrentRead: read.code };
}

/** Preview, then apply that plan from the SAME process (which has read the stores). */
async function previewThenApply([root]: string[]): Promise<unknown> {
  const preview = await previewRunRetirement(root!, { keepFinished: 0 });
  return applyRunRetirement(root!, preview.plan, { readersOffline: true });
}

/** `llmwiki catalog runs --json` with `args` in `root`: the exit code and the captured envelope. */
async function cli([root, ...args]: string[]): Promise<unknown> {
  process.chdir(root!);
  const flag = (name: string) => { const at = args.indexOf(name); return at < 0 ? undefined : args[at + 1]; };
  let envelope = "";
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string) => { envelope += chunk; return true; }) as typeof process.stdout.write;
  let exit: number;
  try {
    exit = await catalogRunsCommand({ json: true, keep: flag("--keep"), out: flag("--out"), retire: flag("--retire"), readersOffline: args.includes("--readers-offline") });
  } finally {
    process.stdout.write = write;
  }
  return { exit, envelope: JSON.parse(envelope) as unknown };
}

/** Read a run's report; for `hold`, announce, wait, and read again through the same snapshot. */
async function holdReport([root, runId, readyFile, goFile]: string[]): Promise<unknown> {
  const run = await BatchRun.open(root!, runId!);
  const first = run.meta.phase;
  writeFileSync(readyFile!, "ready");
  await waitFor(goFile!);
  const lines: unknown[] = [];
  for await (const row of run.scan("r:")) lines.push(row.v);
  return { first, lines: lines.length };
}

/** Publish a barrier as this process; with the files, keep it live until told to exit. */
async function barrier([root, readyFile, goFile]: string[]): Promise<unknown> {
  const token = await publishRetireBarrier(root!, "c".repeat(64));
  if (readyFile !== undefined) { writeFileSync(readyFile, "ready"); await waitFor(goFile!); }
  return { token };
}

/** The modes, by name. */
const MODES: Record<string, (args: string[]) => Promise<unknown>> = {
  build: ([root]) => build(root!),
  run: ([root, phase, evidence]) => scratchRun(root!, phase!, evidence ?? "none"),
  "last-run": ([root, runId]) => setLastRun(root!, runId!),
  inherit: ([root]) => inheritedKeys(root!),
  preview: ([root, keep]) => previewRunRetirement(root!, keep === undefined ? {} : { keepFinished: Number(keep) }),
  apply,
  "preview-apply": previewThenApply,
  cli,
  "sdk-preview": ([root, keep]) => buildCatalogFacade(root!, (fn) => fn()).runs.preview({ keepFinished: Number(keep) }),
  hold: holdReport,
  report: async ([root, runId]) => ({ lines: (await readReport(root!, runId!)).lines.length }),
  "run-ids": async ([root]) => ({ ids: await runIds(root!) }),
  pin: ([root, label]) => catalogPin(root!, label!),
  backup: ([root, dir]) => catalogBackup(root!, dir!),
  barrier,
};

await runChildModes(MODES);
