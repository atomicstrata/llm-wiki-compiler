/**
 * The workflows screen: every recorded run, fetched on each visit because
 * runs live outside the frozen snapshot. The screen exists for the parked
 * runs: one waiting on a gate approval or a stage output is work blocked on
 * a person, so its row says so and names the CLI command that moves it. A
 * command is as far as it goes; the viewer has no write path, and a button
 * would promise one. A broken run store arrives as a problem row and is
 * shown as one, never as an empty list.
 */
import type { ReactNode } from "react";
import { fetchWorkflowRuns, type WorkflowRunRow, type WorkflowRunsEnvelope } from "./api-workflows";
import { AsyncView } from "./async-view";
import { Badge, Card, Code, EmptyState, RowList, Screen, type Tone } from "./components";
import { journeyHref } from "./route";
import { useAsync } from "./use-async";

/** How each run classification reads; the journey screen uses the same words. */
export const RUN_CLASSIFICATION_LABELS: Record<WorkflowRunRow["classification"], string> = {
  current: "Current",
  historical: "History",
  "needs-adaptation": "Project setup has changed",
  "blocked-by-config": "Project configuration needs attention",
};

/** A classification chip reads louder the less the run can be acted on. */
const CLASSIFICATION_TONES: Partial<Record<WorkflowRunRow["classification"], Tone>> = {
  "needs-adaptation": "amber",
  "blocked-by-config": "red",
};

const NO_STAGE = "no active step";
const ENTITY_TYPE_PLACEHOLDER = "<entity-type>";
const SUBMIT_TAIL = "--slug <slug> --body-file <path>";

/** A trust gate is cleared by a successful write, not by `gate approve`. */
const TRUST_GATE_NOTE =
  "Write permission is required; approving a review step does not grant it. " +
  "Set LLMWIKI_TRUSTED_WRITE to grant this profile's writes, then re-submit.";

/** Whether the run is blocked on a person: a gate approval or a stage output. */
function isParked(run: WorkflowRunRow): boolean {
  return run.awaitingGate !== undefined || run.awaitingOutput === true;
}

/** The parked states in the order they must be cleared: output before the gate guarding it. */
function parkLabels(run: WorkflowRunRow): string[] {
  const labels: string[] = [];
  if (run.awaitingOutput === true) labels.push("Waiting for results");
  if (run.awaitingGate !== undefined) {
    labels.push(`${run.awaitingTrustGate === true ? "Write permission required" : "Waiting for approval"} · ${run.awaitingGate}`);
  }
  return labels;
}

/**
 * The `workflow submit` for a write-park. A stage declaring an artifact write
 * and no entity write submits `--kind artifact`; every other submits a page.
 * Mirrors the CLI's own hint so the two surfaces never print different commands.
 */
function submitCommand(run: WorkflowRunRow): string {
  const base = `llmwiki workflow submit ${run.runId}`;
  if (run.nextSubmitEntityType === undefined && run.nextSubmitArtifactType !== undefined) {
    return `${base} --kind artifact --artifact-type ${run.nextSubmitArtifactType} ${SUBMIT_TAIL}`;
  }
  return `${base} --kind page --entity-type ${run.nextSubmitEntityType ?? ENTITY_TYPE_PLACEHOLDER} ${SUBMIT_TAIL}`;
}

/**
 * The unpark commands, in the same order as the labels. A trust gate gets a
 * submit line and no `gate approve`: that approval throws, and the re-submit
 * is what clears the gate.
 */
export function nextCommands(run: WorkflowRunRow): string[] {
  const commands: string[] = [];
  if (run.awaitingOutput === true || run.awaitingTrustGate === true) commands.push(`$ ${submitCommand(run)}`);
  if (run.awaitingGate !== undefined && run.awaitingTrustGate !== true) {
    commands.push(`$ llmwiki workflow gate approve ${run.runId} ${run.awaitingGate}`);
  }
  return commands;
}

/** The chips a run earns: what it is parked on, then its classification when worth stating. */
function RunFlags({ run }: { run: WorkflowRunRow }): ReactNode {
  // `current` is the unremarkable default; a chip on every healthy row would bury the two that mean a run cannot be acted on.
  const classification = run.classification === "current" ? undefined : RUN_CLASSIFICATION_LABELS[run.classification];
  const parked = parkLabels(run);
  if (parked.length === 0 && classification === undefined) return null;
  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {parked.map((label) => <Badge key={label} tone="amber">{label}</Badge>)}
      {classification && <Badge tone={CLASSIFICATION_TONES[run.classification] ?? "neutral"}>{classification}</Badge>}
    </div>
  );
}

/** One readable run: its workflow linking to the journey, status, stage, flags and commands. */
function RunRow({ run }: { run: WorkflowRunRow }): ReactNode {
  const workflow = run.workflow?.trim() ?? "";
  const stage = run.currentStage?.trim() ?? "";
  return (
    <li className="px-4 py-3 text-sm">
      <div className="flex flex-wrap items-baseline gap-x-2">
        {workflow
          ? <a href={journeyHref(workflow, run.runId)} className="font-medium text-zinc-900 hover:text-indigo-600 dark:text-zinc-100 dark:hover:text-indigo-400">{workflow}</a>
          : <span className="font-medium text-zinc-500 dark:text-zinc-400">Unknown workflow</span>}
        <span className="font-mono text-xs text-zinc-500 dark:text-zinc-400">{run.runId}</span>
      </div>
      <p className="mt-0.5 text-zinc-500 dark:text-zinc-400">{run.status || "unknown"} · {stage || NO_STAGE}</p>
      <RunFlags run={run} />
      {run.awaitingTrustGate === true && <p className="mt-2 text-xs text-amber-700 dark:text-amber-400">{TRUST_GATE_NOTE}</p>}
      {nextCommands(run).map((command) => <p key={command} className="mt-2"><Code>{command}</Code></p>)}
    </li>
  );
}

/** An unreadable run or store: what the trouble is attributed to, and why. */
function ProblemRow({ run }: { run: WorkflowRunRow }): ReactNode {
  return (
    <li className="px-4 py-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-xs text-zinc-500 dark:text-zinc-400">{run.runId || "Unknown run"}</span>
        <Badge tone="red">Problem</Badge>
      </div>
      <p className="mt-1 text-red-700 dark:text-red-400">{run.problem}</p>
    </li>
  );
}

/** The run list for a loaded envelope. */
export function WorkflowRuns({ payload }: { payload: WorkflowRunsEnvelope }): ReactNode {
  return (
    <Screen title="Workflows">
      {payload.runs.length === 0 ? (
        <EmptyState
          title="No workflow runs"
          body="Workflows organize a task into steps. No runs are recorded here yet. Use the command below to see which workflows this project supports. Runs can wait for approval or for results to be submitted; this viewer only shows their status."
          command="$ llmwiki workflow list"
        />
      ) : (
        <Card flush>
          <RowList>
            {payload.runs.map((run) => (run.problem ? <ProblemRow key={run.runId} run={run} /> : <RunRow key={run.runId} run={run} />))}
          </RowList>
        </Card>
      )}
    </Screen>
  );
}

/** Fetch the runs on every visit and list them. */
export function WorkflowsView(): ReactNode {
  const state = useAsync(fetchWorkflowRuns, "workflow-runs");
  return <AsyncView state={state}>{(payload) => <WorkflowRuns payload={payload} />}</AsyncView>;
}
