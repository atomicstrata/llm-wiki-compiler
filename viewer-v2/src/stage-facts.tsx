/**
 * What a verified stage did: its summary, the targets it applied, the graph
 * edges it grounds on, the raw evidence digests, and any fact panel the
 * provider attached. Product-neutral: it renders the projection's own text
 * and nothing inferred from stage ids. A recorded-only stage renders nothing
 * here, so a recorded row can never carry trusted-looking facts.
 */
import type { ReactNode } from "react";
import type { FactRow, StageProjection, VerifiedStage } from "./api-workflows";
import { Badge, DefinitionRows, Disclosure, TONE_TEXT, type Tone } from "./components";

/** The closed set of fact tones the provider may use, mapped onto the viewer's tones. */
const FACT_TONE: Record<string, Tone> = { neutral: "neutral", success: "green", warning: "amber", danger: "red" };

const EYEBROW = "text-xs font-semibold tracking-wide text-zinc-500 uppercase dark:text-zinc-400";

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
  return row.label.length > 0 && row.value.length > 0 && Object.hasOwn(FACT_TONE, row.tone);
}

/** The provider's fact panel, or nothing when any row is not displayable. */
function FactPanel({ panel }: { panel: VerifiedStage["factPanel"] }): ReactNode {
  if (!panel || panel.title.length === 0 || panel.rows.length === 0 || !panel.rows.every(isDisplayableRow)) return null;
  return (
    <section className="mt-4 rounded-lg bg-zinc-50 p-3 dark:bg-white/5">
      <h3 className={`mb-2 ${EYEBROW}`}>{panel.title}</h3>
      <DefinitionRows rows={panel.rows.map((row) => [row.label, <span className={TONE_TEXT[FACT_TONE[row.tone]]}>{row.value}</span>])} />
    </section>
  );
}

/** The edges and the expandable digests behind them. */
function Provenance({ stage }: { stage: VerifiedStage }): ReactNode {
  const edges = stageEdges(stage);
  const digests = [...stage.evidenceDigests, ...(stage.groundedRefs ?? [])];
  return (
    <div className="mt-4 space-y-3 text-sm">
      <h3 className={EYEBROW}>What happened</h3>
      {stage.summary && <p className="text-zinc-700 dark:text-zinc-300">{stage.summary}</p>}
      {stage.appliedTargets.length > 0 && (
        <ul role="list" aria-label="Applied targets" className="flex flex-wrap gap-1.5">{stage.appliedTargets.map((target) => <li key={target}><Badge>{target}</Badge></li>)}</ul>
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
        <Disclosure quiet summary="Evidence digests">
          <ul role="list" className="space-y-1 font-mono break-all">{digests.map((digest) => <li key={digest}>{digest}</li>)}</ul>
        </Disclosure>
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
