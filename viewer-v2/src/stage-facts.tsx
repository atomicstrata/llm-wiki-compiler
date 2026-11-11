/**
 * What a verified stage did: its summary, the targets it applied, the graph
 * edges it grounds on, the raw evidence digests, and any fact panel the
 * provider attached. Product-neutral: it renders the projection's own text
 * and nothing inferred from stage ids. A recorded-only stage renders nothing
 * here, so a recorded row can never carry trusted-looking facts.
 */
import type { ReactNode } from "react";
import type { FactRow, StageProjection, VerifiedStage } from "./api-workflows";
import { DefinitionRows } from "./components";

/** The closed set of fact tones, each with the text colour its value is drawn in. */
const FACT_TONE_TEXT: Record<string, string> = {
  neutral: "text-zinc-900 dark:text-zinc-100",
  success: "text-green-600 dark:text-green-400",
  warning: "text-amber-600 dark:text-amber-400",
  danger: "text-red-600 dark:text-red-400",
};

interface StageEdge {
  kind: string;
  label: string;
  value: string;
}

/** The edge rows: applied targets, evidence digests, then grounding references. */
function stageEdges(stage: VerifiedStage): StageEdge[] {
  return [
    ...stage.appliedTargets.map((value) => ({ kind: "target", label: "target", value })),
    ...stage.evidenceDigests.map((value) => ({ kind: "evidence", label: "evidence", value })),
    ...(stage.groundedRefs ?? []).map((value) => ({ kind: "grounding", label: "grounds on", value })),
  ];
}

/** A row is shown only with a label, a value and one of the closed tones. */
function isDisplayableRow(row: FactRow): boolean {
  return row.label.length > 0 && row.value.length > 0 && Object.hasOwn(FACT_TONE_TEXT, row.tone);
}

/** The provider's fact panel, or nothing when any row is not displayable. */
function FactPanel({ panel }: { panel: VerifiedStage["factPanel"] }): ReactNode {
  if (!panel || panel.title.length === 0 || panel.rows.length === 0 || !panel.rows.every(isDisplayableRow)) return null;
  return (
    <section className="mt-4 rounded-lg bg-zinc-50 p-3 dark:bg-white/5">
      <h4 className="mb-2 text-xs font-semibold tracking-wide text-zinc-500 uppercase dark:text-zinc-400">{panel.title}</h4>
      <DefinitionRows rows={panel.rows.map((row) => [row.label, <span className={FACT_TONE_TEXT[row.tone]}>{row.value}</span>])} />
    </section>
  );
}

/** The edges and the expandable digests behind them. */
function Provenance({ stage }: { stage: VerifiedStage }): ReactNode {
  const edges = stageEdges(stage);
  const digests = [...stage.evidenceDigests, ...(stage.groundedRefs ?? [])];
  return (
    <div className="mt-4 space-y-3 text-sm">
      <span className="block text-xs font-semibold tracking-wide text-zinc-500 uppercase dark:text-zinc-400">What happened</span>{" "}
      {stage.summary && <p className="text-zinc-700 dark:text-zinc-300">{stage.summary}</p>}
      {stage.appliedTargets.length > 0 && (
        <ul role="list" className="space-y-1 font-mono text-xs text-zinc-700 dark:text-zinc-300">{stage.appliedTargets.map((target) => <li key={target}>{target}</li>)}</ul>
      )}
      {edges.length > 0 && (
        <div>
          <h4 className="mb-1 font-medium text-zinc-900 dark:text-zinc-100">Graph edges</h4>
          <ul role="list" className="space-y-1 font-mono text-xs break-all text-zinc-500 dark:text-zinc-400">
            {edges.map((edge) => <li key={`${edge.kind}:${edge.value}`} data-edge-kind={edge.kind}>{stage.stageId} → {edge.label}: {edge.value}</li>)}
          </ul>
        </div>
      )}
      {digests.length > 0 && (
        <details className="text-xs">
          <summary className="cursor-pointer font-medium text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200">Evidence digests</summary>
          <ul role="list" className="mt-1 space-y-1 font-mono break-all text-zinc-500 dark:text-zinc-400">{digests.map((digest) => <li key={digest}>{digest}</li>)}</ul>
        </details>
      )}
    </div>
  );
}

/** Everything verified about one stage; nothing for a recorded-only stage. */
export function StageFacts({ stage }: { stage: StageProjection }): ReactNode {
  if (stage.verification !== "verified") return null;
  return (
    <>
      <Provenance stage={stage} />
      <FactPanel panel={stage.factPanel} />
    </>
  );
}
