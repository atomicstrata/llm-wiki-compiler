/**
 * What a verified stage did: its summary, the targets it applied, the graph
 * edges it grounds on, the raw evidence digests, and any fact panel the
 * provider attached. Product-neutral: it renders the projection's own text
 * and nothing inferred from stage ids. A recorded-only stage renders nothing
 * here, so a recorded row can never carry trusted-looking facts.
 */
import type { ReactNode } from "react";
import type { FactRow, StageProjection, VerifiedStage } from "./api-workflows";

const FACT_TONES = new Set<string>(["neutral", "success", "warning", "danger"]);

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
  return row.label.length > 0 && row.value.length > 0 && FACT_TONES.has(row.tone);
}

/** The provider's fact panel, or nothing when any row is not displayable. */
function FactPanel({ panel }: { panel: VerifiedStage["factPanel"] }): ReactNode {
  if (!panel || panel.title.length === 0 || panel.rows.length === 0 || !panel.rows.every(isDisplayableRow)) return null;
  return (
    <section>
      <h4>{panel.title}</h4>
      <dl>
        {panel.rows.map((row) => (
          <div key={row.label}>
            <dt>{row.label}</dt>
            <dd>{row.value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

/** The edges and the expandable digests behind them. */
function Provenance({ stage }: { stage: VerifiedStage }): ReactNode {
  const edges = stageEdges(stage);
  const digests = [...stage.evidenceDigests, ...(stage.groundedRefs ?? [])];
  return (
    <div>
      <span>What happened</span>{" "}
      {stage.summary && <p>{stage.summary}</p>}
      {stage.appliedTargets.length > 0 && (
        <ul>{stage.appliedTargets.map((target) => <li key={target}>{target}</li>)}</ul>
      )}
      {edges.length > 0 && (
        <div>
          <h4>Graph edges</h4>
          <ul>
            {edges.map((edge) => <li key={`${edge.kind}:${edge.value}`} data-edge-kind={edge.kind}>{stage.stageId} → {edge.label}: {edge.value}</li>)}
          </ul>
        </div>
      )}
      {digests.length > 0 && (
        <details>
          <summary>Evidence digests</summary>
          <ul>{digests.map((digest) => <li key={digest}>{digest}</li>)}</ul>
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
