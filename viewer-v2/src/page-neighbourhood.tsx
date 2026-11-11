/**
 * The page's neighbourhood in its rail: the pages it links to and from, then
 * their best-connected neighbours, drawn as a small graph with the page itself
 * ringed and labelled. It reuses the graph the page view already loads for
 * backlinks, so it costs no request. A page with no links says so instead of
 * drawing a lone dot.
 */
import { useMemo, type ReactNode } from "react";
import type { GraphData, PagesEnvelope } from "./api";
import { AsyncView } from "./async-view";
import { GraphSurface } from "./graph-canvas";
import { staleIds } from "./graph-model";
import { localGraph } from "./graph-neighbourhood";
import { RailSection } from "./page-rail";
import type { AsyncState } from "./use-async";

/** The drawing for a loaded graph. */
function LocalDrawing({ graph, pageId, wiki }: { graph: GraphData; pageId: string; wiki: PagesEnvelope }): ReactNode {
  const local = useMemo(() => localGraph(graph, pageId), [graph, pageId]);
  const stale = useMemo(() => staleIds(wiki), [wiki]);
  if (local.edges.length === 0) return <p className="text-zinc-500">No links to or from this page yet.</p>;
  return (
    <div className="-mx-4 -mb-4">
      <GraphSurface data={local} stale={stale} compact centreId={pageId} />
    </div>
  );
}

/** The rail section. */
export function NeighbourhoodSection({ pageId, wiki, graph }: { pageId: string; wiki: PagesEnvelope; graph: AsyncState<GraphData> }): ReactNode {
  return (
    <RailSection title="Neighbourhood">
      <AsyncView state={graph}>{(data) => <LocalDrawing graph={data} pageId={pageId} wiki={wiki} />}</AsyncView>
    </RailSection>
  );
}
