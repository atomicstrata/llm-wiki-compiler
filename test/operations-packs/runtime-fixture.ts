/**
 * @file test/operations-packs/runtime-fixture.ts
 * @description Shared harness for the WOP V3 slice 3C runtime suites: stage a
 * compiled pack action (see `compiled-actions-fixture.ts`) durably on a fresh
 * temp root, and build the host context the production runner-input assembler
 * consumes.
 *
 * IT STAGES THROUGH THE SUBSTRATE TRANSACTION THE SERVICE PUBLISHES THROUGH.
 * `service.stage` reads two operator documents, runs the project preflight, takes
 * the mutation lock and then calls `stagePreparationLocked` with a request built
 * FIELD BY FIELD from the plan's own `initialInputSet` metadata. This fixture
 * builds that same request the same way and calls the same function, so the
 * durable manifest, evidence, and genesis run are exactly what an operator's
 * `stage` would have produced; only the document parsing and the project
 * preflight — neither of which touches what gets staged — are skipped, because a
 * pack action's plan and seed are host artifacts rather than operator files.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runPreparation } from "../../src/preparations/runner.js";
import { createOperationRuntime } from "../../src/operation-bundles/runtime-factory.js";
import type { CompiledPackActionV1 } from "../../src/operations-packs/compiler-types.js";
import { assembleRunnerInput, type PackRunnerContextV1 } from "../../src/operations-packs/runtime/runner-input.js";
import type { RunPreparationResultV1 } from "../../src/preparations/runner.js";
import { readPreparationKey } from "../../src/preparations/key-epoch.js";
import { bindingFor } from "../../src/preparations/references.js";
import { stagePreparationLocked } from "../../src/preparations/stage.js";
import type { StructuredValueSourceV1 } from "../../src/preparations/inputs.js";
import type { PreparationRunBinding } from "../../src/preparations/run-types.js";
import { compileSingleIntentAction } from "./compiled-actions-fixture.js";
import { readPreparationEvidenceBytes } from "../../src/preparations/evidence-store.js";
import { readPreparationRun } from "../../src/preparations/run-store.js";

const ACTOR = { id: "operator", surface: "cli" } as const;

/** The control-transition budget an operator's `stage` defaults a run to. */
const ALLOWANCE = 16;

/**
 * Read one phase's published output evidence back out of the durable run and
 * parse it. Shared by every drive suite that asserts what a MIDDLE phase
 * published (the union selection, the reconcile findings): the summary's digest
 * is the authority, and the bytes come from the evidence CAS, so the assertion
 * is over what the run durably recorded rather than anything held in memory.
 */
export async function readPhaseOutput(
  staged: Pick<StagedPackRunV1, "root" | "binding">, logicalPhaseId: string,
): Promise<unknown> {
  const read = await readPreparationRun(staged.root, staged.binding);
  if (read.status !== "ok") throw new Error(`run ${read.status}`);
  const summary = read.run.phaseSummaries.find((entry) => entry.logicalPhaseId === logicalPhaseId);
  const digest = summary?.outputEvidenceDigest;
  if (digest === undefined) throw new Error(`phase ${logicalPhaseId} published no output`);
  const bytes = await readPreparationEvidenceBytes(staged.root,
    { workspaceId: staged.binding.workspaceId, preparationId: staged.binding.preparationId },
    digest.replace(/^sha256:/, ""), 65536);
  if (bytes.status !== "ok") throw new Error(`${logicalPhaseId} evidence ${bytes.status}`);
  return JSON.parse(bytes.bytes.toString("utf8"));
}

/** The settled state of every phase of one staged run, keyed by logical phase id. */
export async function phaseStates(staged: StagedPackRunV1): Promise<Map<string, string>> {
  const read = await readPreparationRun(staged.root, staged.binding);
  if (read.status !== "ok") throw new Error(`run ${read.status}`);
  return new Map(read.run.phaseSummaries.map((entry) => [entry.logicalPhaseId, entry.state]));
}

/** One compiled action staged durably, plus the binding its run is addressed by. */
export interface StagedPackRunV1 {
  readonly root: string;
  readonly action: CompiledPackActionV1;
  readonly binding: PreparationRunBinding;
  cleanup(): Promise<void>;
}

/** The declared structured initial input, derived from the plan's own input set. */
function seedInputFor(action: CompiledPackActionV1): StructuredValueSourceV1 {
  const declared = action.plan.initialInputSet;
  return {
    value: action.initialInput.value, sourceIdentity: `${ACTOR.surface}-seed`,
    provenanceLabel: declared.provenanceLabel, mediaType: declared.mediaType,
    sensitivity: declared.sensitivity, retention: declared.retention,
    evidenceKind: declared.kind,
  } as StructuredValueSourceV1;
}

/** Stage one compiled action's plan and sealed input on a fresh temp root. */
export async function stageCompiledAction(action: CompiledPackActionV1): Promise<StagedPackRunV1> {
  const root = await mkdtemp(path.join(tmpdir(), "pack-runtime-"));
  const staged = await stageActionIn(root, action);
  return { ...staged, cleanup: () => rm(root, { recursive: true, force: true }) };
}

/**
 * Stage one compiled action in an EXISTING root — the second invocation of a
 * re-drive case runs in the store the first invocation wrote. Cleanup is a
 * no-op: the root's owner (the first staged run) removes the directory.
 */
export async function stageActionIn(root: string, action: CompiledPackActionV1): Promise<StagedPackRunV1> {
  const staged = await stagePreparationLocked(root, {
    plan: action.plan, createdBy: ACTOR, actor: ACTOR,
    initialInputs: [{ kind: "structured", source: seedInputFor(action) }],
    controlTransitionAllowance: ALLOWANCE,
  });
  if (staged.status !== "staged") throw new Error(`staging refused: ${staged.reason}`);
  const key = await readPreparationKey(root);
  if (key.status !== "ok") throw new Error("staged key unavailable");
  return {
    root, action, binding: bindingFor(staged.manifest, key.keyEpochId),
    cleanup: async () => {},
  };
}

/**
 * A suite-scoped tracker that compiles, stages, and later reclaims temp roots.
 *
 * ONE HOME because both slice-3C suites need exactly this: each stages several
 * runs per case and must remove every root afterwards. Two copies of the array,
 * the stage call and the cleanup loop is the shape that drifts into one suite
 * leaking roots while the other does not.
 */
export interface StagedRunTrackerV1 {
  /** Compile and stage one action, registering its root for cleanup. */
  stage(topic?: string): Promise<StagedPackRunV1>;
  /** Register an externally staged run for cleanup, returning it unchanged. */
  add(run: StagedPackRunV1): StagedPackRunV1;
  /** Reclaim every root staged since the last call. */
  cleanupAll(): Promise<void>;
}

/** Build a tracker for one suite; call {@link StagedRunTrackerV1.cleanupAll} after each case. */
export function stagedRunTracker(): StagedRunTrackerV1 {
  const runs: StagedPackRunV1[] = [];
  return {
    stage: async (topic?: string) => {
      const run = await stageCompiledAction(await compileSingleIntentAction(topic));
      runs.push(run);
      return run;
    },
    add: (run: StagedPackRunV1) => {
      runs.push(run);
      return run;
    },
    cleanupAll: async () => {
      await Promise.all(runs.splice(0).map((run) => run.cleanup()));
    },
  };
}

/** The host context: the project, the run, the real adapters, and a fixed clock. */
export function runnerContext(staged: StagedPackRunV1): PackRunnerContextV1 {
  let tick = 0;
  return {
    root: staged.root, binding: staged.binding,
    adapters: createOperationRuntime().adapters,
    clock: { now: () => new Date(Date.UTC(2026, 7, 14, 0, 0, tick++)).toISOString() },
  };
}

/** Drive one staged pack run to its terminal runner outcome through the production input. */
export function driveStagedRun(staged: StagedPackRunV1): Promise<RunPreparationResultV1> {
  return runPreparation(assembleRunnerInput(staged.action, runnerContext(staged)));
}

/** The reason a non-terminal result carries, so a failure names its own cause. */
export function resultReason(result: RunPreparationResultV1): string {
  return "reason" in result ? result.reason : result.status;
}
