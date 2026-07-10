/**
 * @file src/workflows/status.ts
 * @description The read-only `status` operation: classify run(s) against the
 * active profile config.
 *
 * `status` reports how each persisted run relates to the CURRENT profile, so a
 * config change between start and resume is surfaced rather than silently
 * mis-resumed. It is strictly read-only: it takes NO lock, creates nothing, and
 * NEVER repairs a malformed run — an unavailable/corrupt record is SURFACED as a
 * `problem`, not auto-fixed, and an unknown run id is a fail-closed `problem`
 * too (never a throw). The active profile is loaded ONCE and threaded through the
 * per-run classification.
 *
 * ## Classification
 *  - `current`: the run's def digest still matches AND every known stage (and the
 *    current stage) still exists in the active def.
 *  - `needs-adaptation`: the def changed (digest differs) but the run's current
 *    stage still maps into the active def.
 *  - `blocked-by-config`: the run sits on a stage the active def no longer
 *    declares — it cannot be acted on under the current config. Also used for an
 *    absent/unavailable run record and an unknown run id (with a `problem`).
 *  - `historical`: the run is terminal, OR its workflow was removed from the
 *    profile — readable history only, not actionable.
 */

import { loadProfile } from "../profile/load.js";
import { workflowDefDigest } from "../profile/workflow-digest.js";
import { parseGate, isTrustGate } from "./gates.js";
import { readRun, listRuns, resolveRunId } from "./store.js";
import { lookupWorkflowDef } from "./start.js";
import { mapStageId } from "./adapt.js";
import type { WorkflowRun, WorkflowRunStatus } from "./types.js";
import type { ProfilePack, WorkflowDef } from "../profile/types.js";

/** How a run relates to the current profile config. */
export type RunClassification = "current" | "historical" | "needs-adaptation" | "blocked-by-config";

/** A run plus its classification (and any problem detail for an unavailable/malformed run). */
export interface RunStatus {
  /** The run id this status reports on. */
  runId: string;
  /** How the run relates to the current profile config. */
  classification: RunClassification;
  /** The validated run record; present only when the run is readable. */
  run?: WorkflowRun;
  /** Why the run is unavailable/malformed/unknown; present only when there is a problem. */
  problem?: string;
  /**
   * True ONLY for a STORE-LEVEL health row — one not attributable to any single
   * run (the synthetic `(store)` "run store unavailable" row, or the redacted
   * `(unreadable)` aggregate). Such rows are GLOBAL health: a workflow-scoped view
   * preserves them unconditionally rather than object-scope-filtering them. A
   * per-run problem row (an individual unreadable/corrupt run with its real runId)
   * leaves this unset/false — it is attributable to SOME run and is NOT global.
   */
  storeLevel?: boolean;
  /**
   * The gate id the run's CURRENT stage is parked on; present only for a
   * `current` run whose current stage's log entry is `awaiting-gate`. This is
   * the `<id>` part of that stage's `gate` def — exactly what `gate approve`
   * takes — so a blocked run is observable without re-reading the profile.
   */
  awaitingGate?: string;
  /**
   * True when the `awaitingGate` above is a `trust:` gate — one that CANNOT be
   * cleared by `gate approve` (the Trust Guard clears it on a successful write).
   * Lets a renderer hint the trusted-write grant + re-submit instead of a
   * `gate approve` that would fail. Present only alongside `awaitingGate`.
   */
  awaitingTrustGate?: boolean;
  /**
   * True when the run's CURRENT stage is parked needing a `submit` rather than a
   * `gate approve`: a `current` run whose current stage's log entry is
   * `awaiting-gate`, whose stage declares writes OR artifactWrites (i.e. it is not
   * write-less), and for which no applied output has yet been recorded under
   * `outputs[currentStage]`. So a stage awaiting a stage-output submission is
   * observable without re-reading the profile. Does NOT affect classification.
   */
  awaitingOutput?: boolean;
  /**
   * A DECLARED write entity type of the current stage, for the `awaiting-output`
   * `next:` submit hint (`--entity-type <this>`). The FIRST entry of the stage's
   * `writes` — a concrete, valid `--entity-type` value an operator/agent can submit
   * against — set only alongside {@link awaitingOutput}. (One-output-per-stage: a
   * stage records a single output ref and advances on the first; see
   * `stage-output.ts`.)
   */
  nextSubmitEntityType?: string;
  /**
   * A DECLARED artifact type of the current stage, for the `awaiting-output`
   * `next:` submit hint (`--artifact-type <this>`). The FIRST entry of the stage's
   * `artifactWrites` — a concrete, valid `--artifact-type` value an operator/agent
   * can submit against — set only alongside {@link awaitingOutput}. Independent of
   * {@link nextSubmitEntityType}: a combined write+artifact stage sets both; an
   * artifact-only stage sets only this one.
   */
  nextSubmitArtifactType?: string;
}

/** Terminal run statuses — a run in any of these is readable history only. */
const TERMINAL_STATUSES: readonly WorkflowRunStatus[] = ["completed", "cancelled", "failed"];

/** True when the run has reached a terminal lifecycle status. */
function isTerminal(run: WorkflowRun): boolean {
  return TERMINAL_STATUSES.includes(run.status);
}

/**
 * True when every stage the run knew about (and its current stage, if any) still
 * exists in the active def — i.e. no stage the run depends on was removed.
 */
function stagesPreserved(run: WorkflowRun, def: WorkflowDef): boolean {
  const activeIds = new Set(def.stages.map((stage) => stage.id));
  const currentPreserved = run.currentStage === null || activeIds.has(run.currentStage);
  return currentPreserved && run.knownStageIds.every((id) => activeIds.has(id));
}

/**
 * The gate id the run's CURRENT stage is parked on, or `undefined` when the
 * current stage is not `awaiting-gate` (or declares no parseable `<kind>:<id>`
 * gate). Derived from the active def so the returned id matches what
 * `gate approve` takes. Does NOT affect classification.
 */
function currentAwaitingGate(run: WorkflowRun, def: WorkflowDef): { id: string; trust: boolean } | undefined {
  if (run.currentStage === null) return undefined;
  const entry = run.stageLog.find((e) => e.stageId === run.currentStage);
  if (entry?.status !== "awaiting-gate") return undefined;
  const gate = def.stages.find((stage) => stage.id === run.currentStage)?.gate;
  if (gate === undefined) return undefined;
  const id = parseGate(gate)?.id;
  return id === undefined ? undefined : { id, trust: isTrustGate(gate) };
}

/**
 * True when the run's current stage is parked needing a stage-output `submit`:
 * its log entry is `awaiting-gate` (the shared park marker), its stage declares
 * writes OR artifactWrites (i.e. is not write-less), and no applied output is
 * recorded under `outputs[currentStage]` yet. Derived from the active def so a
 * write-declaring stage parked for output is distinguishable from one parked on a
 * human/agent gate. Mirrors `advance.ts`'s `outputRecorded` write-less test so the
 * two surfaces never disagree on whether a stage is write-less.
 */
function awaitingOutputOf(run: WorkflowRun, def: WorkflowDef): boolean {
  if (run.currentStage === null) return false;
  const entry = run.stageLog.find((e) => e.stageId === run.currentStage);
  if (entry?.status !== "awaiting-gate") return false;
  const stage = def.stages.find((s) => s.id === run.currentStage);
  if (stage === undefined || (stage.writes.length === 0 && (stage.artifactWrites ?? []).length === 0)) return false;
  return run.outputs[run.currentStage] === undefined;
}

/**
 * The FIRST declared write entity type of the run's current stage, or `undefined`
 * when the current stage is null/absent or declares no writes. Used to name a
 * concrete `--entity-type` in the `awaiting-output` submit hint.
 */
function currentStageFirstWrite(run: WorkflowRun, def: WorkflowDef): string | undefined {
  if (run.currentStage === null) return undefined;
  const stage = def.stages.find((s) => s.id === run.currentStage);
  return stage?.writes[0];
}

/**
 * The FIRST declared artifact type of the run's current stage, or `undefined`
 * when the current stage is null/absent or declares no `artifactWrites`. Used to
 * name a concrete `--artifact-type` in the `awaiting-output` submit hint.
 */
function currentStageFirstArtifactWrite(run: WorkflowRun, def: WorkflowDef): string | undefined {
  if (run.currentStage === null) return undefined;
  const stage = def.stages.find((s) => s.id === run.currentStage);
  return stage?.artifactWrites?.[0];
}

/**
 * Classify a readable run against the active profile. Terminal or
 * workflow-removed runs are `historical`; an exact def match with all stages
 * preserved is `current`; a current stage that maps into the active def (still a
 * stage, OR a renamed id via `previousIds`) is `needs-adaptation`; only an
 * UNMAPPABLE current stage (removed, not renamed) is `blocked-by-config`.
 */
function classifyRun(run: WorkflowRun, profile: ProfilePack): RunClassification {
  if (isTerminal(run)) return "historical";
  const def = lookupWorkflowDef(profile.workflows, run.workflowId);
  if (def === undefined) return "historical";
  // belt-and-suspenders: a digest match already implies identical stages; this
  // guards against a future digest that ever narrows its coverage.
  if (workflowDefDigest(def) === run.workflowDigest && stagesPreserved(run, def)) return "current";
  if (run.currentStage !== null && mapStageId(run.currentStage, def) === null) return "blocked-by-config";
  return "needs-adaptation";
}

/**
 * Populate the park-related hint fields (`awaitingGate`/`awaitingTrustGate`/
 * `awaitingOutput`/`nextSubmitEntityType`/`nextSubmitArtifactType`) on `status` for
 * a `current` run's current stage. Mutates `status` in place. Split out of
 * {@link statusForRun} to keep that function's branching within budget — the
 * gate-park and output-park checks are independent concerns.
 */
function applyParkHints(status: RunStatus, run: WorkflowRun, def: WorkflowDef): void {
  const gate = currentAwaitingGate(run, def);
  if (gate !== undefined) {
    status.awaitingGate = gate.id;
    if (gate.trust) status.awaitingTrustGate = true;
  }
  if (!awaitingOutputOf(run, def)) return;
  status.awaitingOutput = true;
  const writeType = currentStageFirstWrite(run, def);
  if (writeType !== undefined) status.nextSubmitEntityType = writeType;
  const artifactType = currentStageFirstArtifactWrite(run, def);
  if (artifactType !== undefined) status.nextSubmitArtifactType = artifactType;
}

/** Read one run and turn it into a {@link RunStatus}, failing closed on absent/unavailable. */
async function statusForRun(root: string, runId: string, profile: ProfilePack): Promise<RunStatus> {
  const read = await readRun(root, runId);
  if (read.status === "absent") return { runId, classification: "blocked-by-config", problem: "run file absent" };
  if (read.status === "unavailable") return { runId, classification: "blocked-by-config", problem: read.detail };
  const classification = classifyRun(read.run, profile);
  const status: RunStatus = { runId, classification, run: read.run };
  const def = lookupWorkflowDef(profile.workflows, read.run.workflowId);
  if (classification === "current" && def !== undefined) applyParkHints(status, read.run, def);
  return status;
}

/**
 * A synthetic STORE-LEVEL problem row standing in for the run STORE itself when it
 * is unavailable. Marked `storeLevel` so a workflow-scoped view preserves it as
 * global health (it is not attributable to any single run).
 */
function storeUnavailable(detail: string): RunStatus {
  return {
    runId: "(store)",
    classification: "blocked-by-config",
    problem: `run store unavailable: ${detail}`,
    storeLevel: true,
  };
}

/**
 * Status of ONE run by id, resolving it against the store first. An unavailable
 * store is surfaced as a problem (not a silent miss); an absent/invalid id is a
 * fail-closed `problem` — the caller named a specific id, so an empty result
 * would hide the reason.
 */
async function statusForOneRun(root: string, runId: string, profile: ProfilePack): Promise<RunStatus[]> {
  const resolved = await resolveRunId(root, runId);
  if (resolved.status === "unavailable") return [storeUnavailable(resolved.detail)];
  if (resolved.status === "not-found") {
    return [{ runId, classification: "blocked-by-config", problem: "unknown or invalid run id" }];
  }
  return [await statusForRun(root, resolved.runId, profile)];
}

/**
 * Status of one run (by id) or of all runs in the project.
 *
 * Read-only: takes no lock and creates nothing. With a `runId`, an
 * unresolvable/invalid id is a fail-closed `problem` (`blocked-by-config`) — the
 * caller asked about a specific id, so an empty result would hide the reason.
 * Without a `runId`, every run under the project is classified — and an
 * UNAVAILABLE run store (escape / read failure) is surfaced as a `problem` row
 * rather than reported as "no runs", so a broken store never reads as clean. A
 * malformed run record is surfaced as a `problem`, never repaired and never thrown.
 *
 * @param root - Absolute project root.
 * @param runId - When given, report on just this run; otherwise report on all.
 * @returns One {@link RunStatus} per run (a single entry in the single-id case).
 */
export async function workflowStatus(root: string, runId?: string): Promise<RunStatus[]> {
  const { profile } = await loadProfile(root);
  if (runId !== undefined) return statusForOneRun(root, runId, profile);
  const list = await listRuns(root);
  if (list.status === "unavailable") return [storeUnavailable(list.detail)];
  return Promise.all(list.runIds.map((id) => statusForRun(root, id, profile)));
}

/**
 * The CONSTANT, COUNT-FREE message for the redacted unreadable-runs aggregate.
 * The NUMBER of unreadable runs is metadata that must not leak across a remote
 * surface (e.g. MCP), so the row reports only THAT one-or-more runs are
 * unreadable — never how many. Local diagnostics still expose the full per-run
 * detail via the unscoped `llmwiki workflow status`.
 */
const REDACTED_UNREADABLE_MESSAGE =
  "one or more run records could not be read " +
  "(ids hidden; run `llmwiki workflow status` for diagnostics)";

/**
 * ONE redacted, id-free aggregate health row standing in for the per-run problem
 * rows that cannot be attributed to the scoped workflow. Marked `storeLevel` so it
 * is treated as global health (preserved + counted as a problem for exit-code
 * purposes) WITHOUT exposing any individual run's id/detail — and now WITHOUT the
 * COUNT of unreadable runs, which is itself metadata not to leak remotely.
 */
function redactedUnreadableRow(): RunStatus {
  return {
    runId: "(unreadable)",
    classification: "blocked-by-config",
    problem: REDACTED_UNREADABLE_MESSAGE,
    storeLevel: true,
  };
}

/**
 * Status of all runs, OBJECT-SCOPE-FILTERED to `workflowId`. Three row kinds are
 * handled distinctly so a workflow-scoped view stays fail-visible WITHOUT leaking
 * another workflow's run identity:
 *  - STORE-LEVEL health (`storeLevel === true`) → ALWAYS kept (global health, not
 *    workflow-specific).
 *  - a READABLE run → kept IFF `run.workflowId === workflowId` (object scope).
 *  - a PER-RUN problem (`run === undefined && !storeLevel`: an unreadable/corrupt
 *    individual run carrying its REAL runId) → its id is UNSCOPABLE to this
 *    workflow, so it is NEVER exposed; if ANY are seen they are replaced by ONE
 *    redacted {@link redactedUnreadableRow} aggregate (fail-visible, id-free,
 *    count-free).
 *
 * @param root - Absolute project root.
 * @param workflowId - The workflow to scope readable runs to.
 * @returns Store-level health + readable `workflowId` runs + (if any) one aggregate.
 */
export async function workflowStatusForWorkflow(root: string, workflowId: string): Promise<RunStatus[]> {
  const all = await workflowStatus(root);
  const kept: RunStatus[] = [];
  let hasUnreadable = false;
  for (const row of all) {
    if (row.storeLevel === true) kept.push(row);
    else if (row.run !== undefined) {
      if (row.run.workflowId === workflowId) kept.push(row);
    } else hasUnreadable = true;
  }
  if (hasUnreadable) kept.push(redactedUnreadableRow());
  return kept;
}
