/**
 * The graph explorer at `#/graph`: the full-size drawing with drag, the
 * legend overlay, and a Fit control that re-frames wherever the layout and
 * any dragging have left the nodes. The counts come from the envelope the
 * shell already holds, so the heading reads correctly before the graph loads.
 */
import { useState, type ReactNode } from "react";
import type { PagesEnvelope } from "./api";
import { Button, Screen } from "./components";
import { GraphCanvas, GraphLegend } from "./graph-canvas";
import type { GraphControls } from "./graph-layout";
import { plural } from "./wiki-model";

/** The explorer screen. */
export function GraphView({ wiki }: { wiki: PagesEnvelope }): ReactNode {
  const [controls, setControls] = useState<GraphControls | null>(null);
  const { nodeCount, edgeCount, danglingCount } = wiki.graph;
  return (
    <Screen wide title="Graph explorer"
      description={<>{plural(nodeCount, "node")} · {plural(edgeCount, "edge")} · <span>{plural(danglingCount, "dangling target")}</span></>}
      actions={<Button disabled={controls === null} onClick={() => controls?.fit()}>Fit</Button>}>
      <div className="relative overflow-hidden rounded-xl bg-white shadow-sm ring-1 ring-zinc-950/5 dark:bg-zinc-900 dark:ring-white/10">
        <GraphCanvas wiki={wiki} compact={false} onSettled={setControls} />
        <GraphLegend compact={false} />
      </div>
    </Screen>
  );
}
