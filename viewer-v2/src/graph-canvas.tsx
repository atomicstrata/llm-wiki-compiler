/**
 * The graph drawing both the explorer and the dashboard panel show. React
 * renders the SVG once from `/api/graph`: an arrowhead, one `<line>` per
 * edge, and one group per node holding a halo and the node circle. The
 * positions come from `graph-layout`, which writes them to those elements
 * directly, so React only re-renders for hover, which dims everything but
 * the hovered node and its edges. The canvas is label-free on purpose: at a
 * hundred nodes labels overlap into noise, so a node is identified by its
 * tooltip. `compact` picks the panel's smaller radii, size-derived forces,
 * and no drag.
 */
import { useEffect, useId, useMemo, useRef, useState, type MouseEvent, type ReactNode, type RefObject } from "react";
import { fetchGraph, type GraphData, type GraphEdge, type GraphNode, type PagesEnvelope } from "./api";
import { AsyncView } from "./async-view";
import { mountGraph, type GraphControls } from "./graph-layout";
import { EDGE_LEGEND, KIND_COLOR, maxDegree, NODE_LEGEND, nodeHref, nodeKind, nodeMeta, nodeRadius, nodeStrokeWidth, staleIds, type NodeKind } from "./graph-model";
import { useAsync } from "./use-async";

/** Hand back `fit` once the layout settled, and null when the drawing leaves. */
type OnSettled = (controls: GraphControls | null) => void;

interface SurfaceProps {
  data: GraphData;
  stale: Set<string>;
  compact: boolean;
  onSettled?: OnSettled;
}

/** Keep the tooltip this far from the pointer so the cursor never covers it. */
const TOOLTIP_OFFSET = { x: 14, y: -50 };
const TOOLTIP_EDGE_GAP = 8;

/** The legend: node colours, then in the explorer edge kinds and the size rule. */
export function GraphLegend({ compact }: { compact: boolean }): ReactNode {
  const nodeRows = NODE_LEGEND.map((row) => (
    <span key={row.kind}><span className={KIND_COLOR[row.kind]} aria-hidden="true">●</span>{" "}{row.label}{" "}</span>
  ));
  if (compact) return <div>{nodeRows}<span>size = degree</span></div>;
  return (
    <div>
      <div>Node kind</div>
      {nodeRows}
      <div>Edge kind</div>
      {EDGE_LEGEND.map((row) => (
        <span key={row.kind}>{row.kind === "relation" ? "╌ " : "─ "}{row.label} </span>
      ))}
      <div>Node size</div>
      <span>larger = more connections</span>
    </div>
  );
}

function EdgeLine({ edge, markerId }: { edge: GraphEdge; markerId: string }): ReactNode {
  const relation = edge.edgeKind === "relation";
  return (
    <line stroke="currentColor" strokeOpacity={0.3} strokeDasharray={relation ? "5 3" : undefined}
      markerEnd={edge.direction === "symmetric" ? undefined : `url(#${markerId})`}>
      {relation && edge.relationType && <title>{edge.relationType}</title>}
    </line>
  );
}

interface NodeProps {
  node: GraphNode;
  kind: NodeKind;
  radius: number;
  onHover: (node: GraphNode | null, event?: MouseEvent) => void;
  onMove: (event: MouseEvent) => void;
}

/** A halo behind the node, the node itself, and a link when the node has a page. */
function NodeGroup({ node, kind, radius, onHover, onMove }: NodeProps): ReactNode {
  const href = nodeHref(node);
  const circles = (
    <circle r={radius} fill="currentColor" stroke="currentColor"
      strokeWidth={nodeStrokeWidth(node.degree)} strokeDasharray={node.isDangling ? "3,2" : undefined} />
  );
  return (
    <g data-node="" className={KIND_COLOR[kind]} onMouseEnter={(event) => onHover(node, event)} onMouseMove={onMove} onMouseLeave={() => onHover(null)}>
      {href === null ? circles : <a href={href} aria-label={node.title}>{circles}</a>}
    </g>
  );
}

/** Place the tooltip beside the pointer, kept inside the SVG. */
function placeTooltip(tooltip: HTMLDivElement, svg: SVGSVGElement, event: MouseEvent): void {
  const bounds = svg.getBoundingClientRect();
  const width = tooltip.offsetWidth;
  const height = tooltip.offsetHeight;
  let left = event.clientX - bounds.left + TOOLTIP_OFFSET.x;
  let top = event.clientY - bounds.top + TOOLTIP_OFFSET.y;
  if (left + width > bounds.width) left = bounds.width - width - TOOLTIP_EDGE_GAP;
  if (top < 0) top = TOOLTIP_EDGE_GAP / 2;
  if (top + height > bounds.height) top = bounds.height - height - TOOLTIP_EDGE_GAP;
  tooltip.style.left = `${left}px`;
  tooltip.style.top = `${top}px`;
}

/** Run the layout for the drawn SVG; report `fit` once it settled. */
function useGraphLayout(data: GraphData, compact: boolean, onSettled: OnSettled | undefined) {
  const svgRef = useRef<SVGSVGElement>(null);
  const viewportRef = useRef<SVGGElement>(null);
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    const svg = svgRef.current;
    const viewport = viewportRef.current;
    if (svg === null || viewport === null) return;
    setSettled(false);
    const graph = mountGraph(svg, viewport, data, compact);
    void graph.settle().then((isSettled) => {
      if (!isSettled) return;
      graph.fit(false);
      setSettled(true);
      onSettled?.({ fit: () => graph.fit(true) });
    });
    return () => {
      graph.dispose();
      onSettled?.(null);
    };
  }, [data, compact, onSettled]);
  return { svgRef, viewportRef, settled };
}

/** The arrowhead every directed edge ends in; its fill comes from the stylesheet. */
function Arrowhead({ id }: { id: string }): ReactNode {
  return (
    <defs>
      <marker id={id} viewBox="0 -4 8 8" refX={8} refY={0} markerWidth={6} markerHeight={6} orient="auto">
        <path d="M0,-4L8,0L0,4" fill="currentColor" fillOpacity={0.3} />
      </marker>
    </defs>
  );
}

/** Title, kind and degree of the hovered node; the hint only when a click goes somewhere. */
function Tooltip({ node, tooltipRef }: { node: GraphNode | null; tooltipRef: RefObject<HTMLDivElement | null> }): ReactNode {
  return (
    <div ref={tooltipRef} hidden={node === null} className="pointer-events-none absolute border bg-white p-2 text-sm dark:bg-black">
      {node && (
        <>
          <div>{node.title}</div>
          <div>{nodeMeta(node)}</div>
          {!node.isDangling && <div>Click to open page</div>}
        </>
      )}
    </div>
  );
}

/** The SVG for a graph with at least one node. */
function Drawing({ data, stale, compact, onSettled }: SurfaceProps): ReactNode {
  const { svgRef, viewportRef, settled } = useGraphLayout(data, compact, onSettled);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const [hovered, setHovered] = useState<GraphNode | null>(null);
  const markerId = useId();
  const largest = maxDegree(data.nodes);
  const onMove = (event: MouseEvent): void => {
    if (tooltipRef.current && svgRef.current) placeTooltip(tooltipRef.current, svgRef.current, event);
  };
  const onHover = (node: GraphNode | null, event?: MouseEvent): void => {
    setHovered(node);
    if (event) onMove(event);
  };
  return (
    <div className="relative">
      {!settled && <p role="status">Arranging graph…</p>}
      <svg ref={svgRef} data-settled={settled} data-compact={compact} className={compact ? "h-72 w-full" : "h-[70vh] w-full"}>
        <Arrowhead id={markerId} />
        <g ref={viewportRef}>
          <g>{data.edges.map((edge, index) => <EdgeLine key={`${edge.source}|${edge.target}|${index}`} edge={edge} markerId={markerId} />)}</g>
          <g>
            {data.nodes.map((node) => (
              <NodeGroup key={node.id} node={node} kind={nodeKind(node, stale)} radius={nodeRadius(node.degree, largest, compact)}
                onHover={onHover} onMove={onMove} />
            ))}
          </g>
        </g>
      </svg>
      <Tooltip node={hovered} tooltipRef={tooltipRef} />
    </div>
  );
}

/** The drawing, or the empty state when the wiki has nothing to link yet. */
export function GraphSurface(props: SurfaceProps): ReactNode {
  if (props.data.nodes.length === 0) {
    return (
      <div>
        <strong>Nothing to graph yet</strong>
        <p>The graph draws links between compiled pages. Compile at least two pages that reference each other to see structure here.</p>
        <code>$ llmwiki compile</code>
      </div>
    );
  }
  return <Drawing {...props} />;
}

interface CanvasProps {
  wiki: PagesEnvelope;
  compact: boolean;
  onSettled?: OnSettled;
}

/** Load `/api/graph` and draw it; stale colouring comes from the envelope's page rows. */
export function GraphCanvas({ wiki, compact, onSettled }: CanvasProps): ReactNode {
  const state = useAsync(fetchGraph, wiki.updatedAt);
  const stale = useMemo(() => staleIds(wiki), [wiki]);
  return (
    <AsyncView state={state}>
      {(data) => <GraphSurface data={data} stale={stale} compact={compact} onSettled={onSettled} />}
    </AsyncView>
  );
}
