/**
 * One workflow run's journey: its stages in roster order, each with its gate,
 * whether it was verified or only recorded, its facts, its output and pinned
 * artifacts, and the final PDF when a verified stage carries one. A stage is
 * "Verified" only when the projection says exactly that; everything else is
 * "Recorded · not verified", so the two are never confused.
 */
import type { ReactNode } from "react";
import {
  fetchWorkflowRun, runPdfUrl, stageOutputUrl,
  type LiveOutcome, type RunClassification, type StageGate, type StageProjection, type WorkflowRunProjection, type WorkflowRunResponse,
} from "./api-workflows";
import { ArtifactRef } from "./artifact-ref";
import { AsyncView } from "./async-view";
import { Badge, Card, Screen, type Tone } from "./components";
import { StageFacts } from "./stage-facts";
import { useAsync } from "./use-async";

const CLASSIFICATION_LABELS: Record<RunClassification, string> = {
  current: "Current",
  "needs-adaptation": "Needs adaptation",
  "blocked-by-config": "Blocked by config",
  historical: "Historical",
};

const GATE_STATE_TEXT: Record<StageGate["state"], string> = {
  "not-reached": "not reached",
  awaiting: "awaiting approval",
  approved: "approved",
};

/** An awaiting gate is the one that needs a person; an approved one has cleared. */
const GATE_STATE_TONES: Record<StageGate["state"], Tone> = {
  "not-reached": "neutral",
  awaiting: "amber",
  approved: "green",
};

const VERIFICATION_REASON_LABELS: Record<string, string> = {
  "stale-or-invalid": "Stale or invalid",
  unavailable: "Unavailable",
  "timed-out": "Timed out",
};

const SHA256_DIGEST = /^[0-9a-f]{64}$/;
const DIGEST_PREVIEW_LENGTH = 19;

/** The ids a run's links are built from. */
interface RunIds {
  workflowId: string;
  runId: string;
}

/** Why a verified journey shows the recorded run instead; nothing when the provider applied. */
function liveNotice(live: LiveOutcome | undefined): string | null {
  if (live === undefined || live.outcome === "applied") return null;
  if (live.outcome === "timed-out") {
    const seconds = live.timeoutMs >= 0 ? `${Math.round(live.timeoutMs / 1000)} s` : "its budget";
    return `Live verification timed out after ${seconds}; showing the recorded run. Ask the viewer host to increase its configured projection timeout.`;
  }
  if (live.outcome === "degraded") return "Live verification was unavailable (the provider failed or returned an unusable result); showing the recorded run.";
  return "The run changed while it was being verified; showing the recorded run. Reload to verify again.";
}

/** The approval byline, only from what the projection recorded; never an invented approver. */
function gateByline(gate: StageGate): string {
  const parts: string[] = [];
  if (gate.actor) parts.push(`by ${gate.actor}`);
  if (gate.actorKind) parts.push(`(${gate.actorKind})`);
  if (gate.at) parts.push(`at ${gate.at}`);
  if (gate.decision) parts.push(`— ${gate.decision}`);
  if (gate.subjectDigest) {
    const digest = gate.subjectDigest;
    parts.push(`subject ${digest.length > DIGEST_PREVIEW_LENGTH ? `${digest.slice(0, DIGEST_PREVIEW_LENGTH)}…` : digest}`);
  }
  return parts.join(" ");
}

/** The gate guarding a stage; a human gate is named distinctly from agent and trust gates. */
function GateCallout({ gate }: { gate: StageGate }): ReactNode {
  const kind = gate.gateKind === "human" ? "Human approval" : `${gate.gateKind.charAt(0).toUpperCase()}${gate.gateKind.slice(1)} gate`;
  const byline = gateByline(gate);
  return (
    <div className="mb-2 flex flex-wrap items-center gap-2">
      <Badge tone={GATE_STATE_TONES[gate.state] ?? "neutral"}>{kind} — {GATE_STATE_TEXT[gate.state] ?? gate.state}</Badge>{" "}
      {byline && <span className="text-xs text-zinc-500 dark:text-zinc-400">{byline}</span>}
    </div>
  );
}

/** The verification badge, and the stable reason when a stage is only recorded. */
function Verification({ stage }: { stage: StageProjection }): ReactNode {
  if (stage.verification === "verified") return <Badge tone="green">Verified</Badge>;
  const reason = stage.verificationReason;
  const label = reason && VERIFICATION_REASON_LABELS[reason.category];
  return (
    <>
      <Badge>Recorded · not verified</Badge>{" "}
      {label && <span className="text-xs text-zinc-500 dark:text-zinc-400">{label} · {reason.code}</span>}
    </>
  );
}

/** The final PDF of a verified stage with a well-formed pin: a link, and the file inline. */
function PdfPanel({ stage, ids }: { stage: StageProjection; ids: RunIds }): ReactNode {
  if (stage.verification !== "verified" || !stage.pdfRef || !SHA256_DIGEST.test(stage.pdfRef.sha256)) return null;
  const url = runPdfUrl(ids.workflowId, ids.runId);
  return (
    <section className="mt-4 border-t border-zinc-950/5 pt-4 dark:border-white/10">
      <h4 className="text-sm font-semibold text-zinc-950 dark:text-white">Final PDF — pinned by {stage.stageId}, verified</h4>
      <a href={url} target="_blank" rel="noopener" className="mt-1 inline-block text-sm font-medium text-indigo-600 hover:text-indigo-500 dark:text-indigo-400 dark:hover:text-indigo-300">Open final PDF ({stage.pdfRef.member})</a>
      <iframe src={url} title="Final PDF" className="mt-3 h-96 w-full rounded-lg bg-white ring-1 ring-zinc-950/5 dark:bg-zinc-950 dark:ring-white/10" />
    </section>
  );
}

/** One stage: gate first, then the header, badge, facts, output, pins and PDF. */
function StageItem({ stage, ids }: { stage: StageProjection; ids: RunIds }): ReactNode {
  const pins = [stage.outputRef, stage.verification === "verified" ? stage.pdfRef : undefined];
  return (
    <li data-stage-id={stage.stageId} className="relative pl-6">
      <span aria-hidden="true" className="absolute top-1.5 -left-1.5 size-3 rounded-full bg-white ring-2 ring-indigo-600 dark:bg-zinc-900 dark:ring-indigo-400" />
      {stage.gate && <GateCallout gate={stage.gate} />}
      <Card>
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-sm font-semibold text-zinc-950 dark:text-white">{stage.stageId || "(unnamed stage)"}</span>{" "}
          <span className="text-sm text-zinc-500 dark:text-zinc-400">{stage.status || "unknown"}</span>
          <Verification stage={stage} />
        </div>
        <StageFacts stage={stage} />
        {stage.outputRef && (
          <p className="mt-4">
            <a href={stageOutputUrl(ids.workflowId, ids.runId, stage.stageId)} download="" className="text-sm font-medium text-indigo-600 hover:text-indigo-500 dark:text-indigo-400 dark:hover:text-indigo-300">Download {stage.outputRef.artifactType || "artifact"}</a>
          </p>
        )}
        {pins.map((pin) => pin && <ArtifactRef key={`${pin.artifactType}/${pin.slug}`} pin={pin} />)}
        <PdfPanel stage={stage} ids={ids} />
      </Card>
    </li>
  );
}

/** The run's classification, live notice and stage timeline. */
function Projection({ projection, ids }: { projection: WorkflowRunProjection; ids: RunIds }): ReactNode {
  const notice = liveNotice(projection.live);
  return (
    <Screen wide title={`Run ${projection.runId || ids.runId}`}
      description={`Run status: ${CLASSIFICATION_LABELS[projection.classification] ?? projection.classification}`}>
      {notice && <p className="mb-6 rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-800 ring-1 ring-amber-600/20 dark:bg-amber-500/10 dark:text-amber-300 dark:ring-amber-500/20">{notice}</p>}
      <ol className="ml-1.5 space-y-6 border-l border-zinc-200 dark:border-zinc-800">
        {projection.stages.map((stage, index) => <StageItem key={`${stage.stageId}#${index}`} stage={stage} ids={ids} />)}
      </ol>
    </Screen>
  );
}

/** A run's journey, or the server's problem with projecting it. */
export function Journey({ body, ids }: { body: WorkflowRunResponse; ids: RunIds }): ReactNode {
  if (!("problem" in body)) return <Projection projection={body} ids={ids} />;
  return (
    <Screen wide title={`Run ${ids.runId}`}>
      <p role="alert" className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700 ring-1 ring-red-600/20 dark:bg-red-500/10 dark:text-red-400 dark:ring-red-500/20">This run could not be projected: {body.problem}</p>
    </Screen>
  );
}

/** Fetch the run on every visit and show its journey. */
export function JourneyView({ workflowId, runId }: RunIds): ReactNode {
  const state = useAsync(() => fetchWorkflowRun(workflowId, runId), `${workflowId}\n${runId}`);
  if (state.status === "loading") return <p role="status" className="py-12 text-center text-sm text-zinc-500 dark:text-zinc-400">Verifying retained workflow records…</p>;
  return <AsyncView state={state}>{(body) => <Journey body={body} ids={{ workflowId, runId }} />}</AsyncView>;
}
