/**
 * The graph explorer at `#/graph`: the full-size drawing with drag, the
 * legend overlay, and a Fit control that re-frames wherever the layout and
 * any dragging have left the nodes. The counts come from the envelope the
 * shell already holds, so the heading reads correctly before the graph loads.
 */
import { useState, type ReactNode } from "react";
import type { PagesEnvelope } from "./api";
import { GraphCanvas, GraphLegend } from "./graph-canvas";
import type { GraphControls } from "./graph-layout";
import { plural } from "./wiki-model";

/** The explorer screen. */
export function GraphView({ wiki }: { wiki: PagesEnvelope }): ReactNode {
  const [controls, setControls] = useState<GraphControls | null>(null);
  const { nodeCount, edgeCount, danglingCount } = wiki.graph;
  return (
    <section>
      <div>
        <div>
          <h1>Graph explorer</h1>
          <p>
            {plural(nodeCount, "node")} · {plural(edgeCount, "edge")} · <span>{plural(danglingCount, "dangling target")}</span>
          </p>
        </div>
        <button type="button" disabled={controls === null} onClick={() => controls?.fit()}>Fit</button>
      </div>
      <div>
        <GraphCanvas wiki={wiki} compact={false} onSettled={setControls} />
        <GraphLegend compact={false} />
      </div>
    </section>
  );
}
