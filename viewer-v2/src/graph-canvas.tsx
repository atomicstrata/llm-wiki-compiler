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
import { EDGE_LEGEND, HALO_MARGIN, maxDegree, NODE_LEGEND, nodeHref, nodeKind, nodeMeta, nodeRadius, nodeStrokeWidth, staleIds } from "./graph-model";
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
    <span key={row.kind} className="graph-legend-item"><i className={`graph-legend-dot graph-legend-dot--${row.kind}`} />{row.label}</span>
  ));
  if (compact) return <div className="graph-legend graph-legend-compact">{nodeRows}<span className="graph-legend-note">size = degree</span></div>;
  return (
    <div className="graph-legend">
      <div className="graph-legend-heading">Node kind</div>
      {nodeRows}
      <div className="graph-legend-heading">Edge kind</div>
      {EDGE_LEGEND.map((row) => (
        <span key={row.kind} className="graph-legend-item"><i className={`graph-legend-edge graph-legend-edge--${row.kind}`} />{row.label}</span>
      ))}
      <div className="graph-legend-heading">Node size</div>
      <span className="graph-legend-item">larger = more connections</span>
    </div>
  );
}

/** Whether an edge touches the hovered node. */
function touches(edge: GraphEdge, hoveredId: string | null): boolean {
  return edge.source === hoveredId || edge.target === hoveredId;
}

/** `is-hot` on what the hover singles out, `is-dimmed` on the rest, nothing at rest. */
function hoverClass(isHot: boolean, hoveredId: string | null): string {
  if (hoveredId === null) return "";
  return isHot ? " is-hot" : " is-dimmed";
}

function EdgeLine({ edge, hoveredId, markerId }: { edge: GraphEdge; hoveredId: string | null; markerId: string }): ReactNode {
  const relation = edge.edgeKind === "relation";
  const className = `graph-edge${relation ? " graph-edge--relation" : ""}${hoverClass(touches(edge, hoveredId), hoveredId)}`;
  return (
    <line className={className} markerEnd={edge.direction === "symmetric" ? undefined : `url(#${markerId})`}>
      {relation && edge.relationType && <title>{edge.relationType}</title>}
    </line>
  );
}

interface NodeProps {
  node: GraphNode;
  kind: string;
  radius: number;
  hoveredId: string | null;
  onHover: (node: GraphNode | null, event?: MouseEvent) => void;
  onMove: (event: MouseEvent) => void;
}

/** A halo behind the node, the node itself, and a link when the node has a page. */
function NodeGroup({ node, kind, radius, hoveredId, onHover, onMove }: NodeProps): ReactNode {
  const href = nodeHref(node);
  const isHot = hoveredId === node.id;
  const circles = (
    <>
      <circle className={`graph-halo${isHot ? " is-hot" : ""}`} r={radius + HALO_MARGIN} />
      <circle className={`graph-node graph-node--${kind}${hoverClass(isHot, hoveredId)}`} r={radius}
        strokeWidth={nodeStrokeWidth(node.degree)} strokeDasharray={node.isDangling ? "3,2" : undefined} />
    </>
  );
  return (
    <g data-node="" onMouseEnter={(event) => onHover(node, event)} onMouseMove={onMove} onMouseLeave={() => onHover(null)}>
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
        <path className="graph-arrowhead" d="M0,-4L8,0L0,4" />
      </marker>
    </defs>
  );
}

/** Title, kind and degree of the hovered node; the hint only when a click goes somewhere. */
function Tooltip({ node, tooltipRef }: { node: GraphNode | null; tooltipRef: RefObject<HTMLDivElement | null> }): ReactNode {
  return (
    <div ref={tooltipRef} className="graph-tooltip" hidden={node === null}>
      {node && (
        <>
          <div className="tip-title">{node.title}</div>
          <div className="tip-meta">{nodeMeta(node)}</div>
          {!node.isDangling && <div className="tip-hint">Click to open page</div>}
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
  const hoveredId = hovered?.id ?? null;
  return (
    <>
      {!settled && <p className="status" role="status">Arranging graph…</p>}
      <svg ref={svgRef} className="graph-svg" data-settled={settled} data-compact={compact}>
        <Arrowhead id={markerId} />
        <g ref={viewportRef}>
          <g>{data.edges.map((edge, index) => <EdgeLine key={`${edge.source}|${edge.target}|${index}`} edge={edge} hoveredId={hoveredId} markerId={markerId} />)}</g>
          <g>
            {data.nodes.map((node) => (
              <NodeGroup key={node.id} node={node} kind={nodeKind(node, stale)} radius={nodeRadius(node.degree, largest, compact)}
                hoveredId={hoveredId} onHover={onHover} onMove={onMove} />
            ))}
          </g>
        </g>
      </svg>
      <Tooltip node={hovered} tooltipRef={tooltipRef} />
    </>
  );
}

/** The drawing, or the empty state when the wiki has nothing to link yet. */
export function GraphSurface(props: SurfaceProps): ReactNode {
  if (props.data.nodes.length === 0) {
    return (
      <div className="empty-state">
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
