/**
 * The graph drawing the explorer and a page rail's neighbourhood show. React
 * renders the SVG once from `/api/graph`: an arrowhead, one `<line>` per
 * edge, and one group per node holding its circle, a centre ring, and its
 * label. The
 * positions come from `graph-layout`, which writes them to those elements
 * directly, so React only re-renders for hover, which dims everything outside
 * the hovered node's neighbourhood and labels that neighbourhood. A
 * `highlightId` holds the same emphasis without a pointer: the page a local
 * graph is centred on, or the node the explorer's find box chose. A
 * `centreId` instead rings and labels one node without dimming the rest,
 * which is how a page's rail marks the page itself. Other
 * labels appear only once the reader zooms in, because at a hundred nodes
 * they overlap into noise; they keep one on-screen size at every zoom.
 * Keyboard focus on a node gives the same emphasis and tooltip as hovering.
 * Nodes colour by kind, or by link community in the explorer. `compact` picks
 * the rail's smaller radii, size-derived forces, and no drag.
 */
import { useEffect, useEffectEvent, useId, useLayoutEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode, type RefObject } from "react";
import { fetchGraph, type GraphData, type GraphEdge, type GraphNode, type PagesEnvelope } from "./api";
import { AsyncView } from "./async-view";
import { mountGraph, type GraphControls } from "./graph-layout";
import { EDGE_LEGEND, KIND_COLOR, maxDegree, NODE_LEGEND, nodeHref, nodeKind, nodeMeta, nodeRadius, nodeStrokeWidth, staleIds } from "./graph-model";
import { EmptyState } from "./components";
import { adjacency, communities, communityColor } from "./graph-neighbourhood";
import { useAsync } from "./use-async";

/** Hand back `fit` once the layout settled, and null when the drawing leaves. */
type OnSettled = (controls: GraphControls | null) => void;

/** What decides a node's colour. */
export type ColorBy = "kind" | "community";

interface SurfaceProps {
  data: GraphData;
  stale: Set<string>;
  compact: boolean;
  onSettled?: OnSettled;
  colorBy?: ColorBy;
  highlightId?: string | null;
  centreId?: string;
}

/** Labels stop here; the tooltip carries the full title. */
const LABEL_CHARS = { full: 40, compact: 26 } as const;

/** A title short enough to label a node, cut at a word where it can be. */
export function shortLabel(title: string, max: number): string {
  if (title.length <= max) return title;
  const cut = title.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${space > max / 2 ? cut.slice(0, space) : cut}…`;
}

/** How an edge reads against the current emphasis. */
type Emphasis = "normal" | "strong" | "dim";
const EDGE_OPACITY: Record<Emphasis, number> = { normal: 0.3, strong: 0.7, dim: 0.06 };

/** Keep the tooltip this far from the pointer so the cursor never covers it. */
const TOOLTIP_OFFSET = { x: 14, y: -50 };
const TOOLTIP_EDGE_GAP = 8;

/** The explorer's legend: node colours, edge kinds, and the size rule. */
export function GraphLegend({ colorBy = "kind" }: { colorBy?: ColorBy }): ReactNode {
  const nodeRows = colorBy === "community"
    ? [<span key="community" className="block max-w-44">Each colour marks a cluster of pages that link to each other; colours repeat for distant clusters. Grey pages stand alone.</span>]
    : NODE_LEGEND.map((row) => (
      <span key={row.kind} className="inline-flex items-center gap-1"><span className={KIND_COLOR[row.kind]} aria-hidden="true">●</span>{row.label}</span>
    ));
  return (
    <div className="absolute top-3 right-3 space-y-1 rounded-lg bg-white/90 p-3 text-xs text-zinc-600 shadow-sm ring-1 ring-zinc-950/5 backdrop-blur dark:bg-zinc-900/90 dark:text-zinc-400 dark:ring-white/10">
      <div className="font-medium text-zinc-900 dark:text-zinc-100">{colorBy === "community" ? "Colour" : "Node kind"}</div>
      <div className="flex flex-col gap-0.5">{nodeRows}</div>
      <div className="pt-1 font-medium text-zinc-900 dark:text-zinc-100">Edge kind</div>
      {EDGE_LEGEND.map((row) => (
        <span key={row.kind} className="block">{row.kind === "relation" ? "╌ " : "─ "}{row.label} </span>
      ))}
      <div className="pt-1 font-medium text-zinc-900 dark:text-zinc-100">Node size</div>
      <span className="block">larger = more connections</span>
    </div>
  );
}

function EdgeLine({ edge, markerId, emphasis }: { edge: GraphEdge; markerId: string; emphasis: Emphasis }): ReactNode {
  const relation = edge.edgeKind === "relation";
  return (
    <line stroke="currentColor" opacity={EDGE_OPACITY[emphasis]} strokeDasharray={relation ? "5 3" : undefined}
      markerEnd={edge.direction === "symmetric" ? undefined : `url(#${markerId})`}>
      {relation && edge.relationType && <title>{edge.relationType}</title>}
    </line>
  );
}

interface NodeProps {
  node: GraphNode;
  colorClass: string;
  radius: number;
  dimmed: boolean;
  labelled: boolean;
  label: string;
  ringed: boolean;
  onHover: (node: GraphNode | null, point?: ViewportPoint) => void;
  onMove: (event: MouseEvent) => void;
}

/** Label type that keeps one on-screen size: the zoom scale divides it back out. */
const LABEL_CLASS =
  "pointer-events-none fill-zinc-700 stroke-white text-[length:calc(11px/var(--graph-k,1))] [stroke-width:calc(3px/var(--graph-k,1))] [paint-order:stroke] select-none dark:fill-zinc-200 dark:stroke-zinc-900";

/** A label shows when its node is emphasised; otherwise only when zoomed in, and never while dimmed. */
function labelClass(labelled: boolean, dimmed: boolean): string {
  if (labelled) return "";
  return dimmed ? "hidden" : "hidden group-data-[zoomed=true]/graph:inline";
}

/** The node, a link when it has a page, a ring on the centre node, and its label, shown when emphasised or zoomed in. */
function NodeGroup({ node, colorClass, radius, dimmed, labelled, label, ringed, onHover, onMove }: NodeProps): ReactNode {
  const href = nodeHref(node);
  const circles = (
    <circle r={radius} fill="currentColor" stroke="currentColor"
      strokeWidth={nodeStrokeWidth(node.degree)} strokeDasharray={node.isDangling ? "3,2" : undefined} />
  );
  return (
    <g data-node="" className={dimmed ? `${colorClass} transition-opacity opacity-15` : `${colorClass} transition-opacity`}
      onMouseEnter={(event) => onHover(node, event)} onMouseMove={onMove} onMouseLeave={() => onHover(null)}
      onFocus={(event) => onHover(node, rightOf(event.currentTarget))} onBlur={() => onHover(null)}>
      {ringed && <circle r={radius + 3.5} fill="none" stroke="currentColor" strokeWidth={1.5} />}
      {href === null ? circles : <a href={href} aria-label={node.title}>{circles}</a>}
      <text y={radius + 2} dy="1em" textAnchor="middle" className={`${LABEL_CLASS} ${labelClass(labelled, dimmed)}`}>{label}</text>
    </g>
  );
}

/** The emphasis around one node: it and its neighbours, or nothing when no node is active. The neighbour map is built once per graph. */
function useEmphasis(data: GraphData, activeId: string | null): Set<string> | null {
  const neighbours = useMemo(() => adjacency(data), [data]);
  return useMemo(() => (activeId === null ? null : new Set([activeId, ...(neighbours.get(activeId) ?? [])])), [neighbours, activeId]);
}

/** Every node's colour class for the current colour mode. */
function useNodeColors(data: GraphData, stale: Set<string>, colorBy: ColorBy): Map<string, string> {
  return useMemo(() => {
    const rank = colorBy === "community" ? communities(data) : null;
    return new Map(data.nodes.map((node) => [node.id, rank ? communityColor(rank.get(node.id)) : KIND_COLOR[nodeKind(node, stale)]]));
  }, [data, stale, colorBy]);
}

/** How an edge reads: strong inside the emphasis, dim outside it, normal with nothing active. */
function edgeEmphasis(edge: GraphEdge, activeId: string | null): Emphasis {
  if (activeId === null) return "normal";
  return edge.source === activeId || edge.target === activeId ? "strong" : "dim";
}

/** Where a focused node's tooltip anchors: just right of the node, as a pointer would be. */
function rightOf(element: Element): ViewportPoint {
  const box = element.getBoundingClientRect();
  return { clientX: box.right, clientY: box.top + box.height / 2 - TOOLTIP_OFFSET.y };
}

/** Place the tooltip beside a point in the viewport, kept inside the SVG. */
function placeTooltip(tooltip: HTMLDivElement, svg: SVGSVGElement, point: ViewportPoint): void {
  const bounds = svg.getBoundingClientRect();
  const width = tooltip.offsetWidth;
  const height = tooltip.offsetHeight;
  let left = point.clientX - bounds.left + TOOLTIP_OFFSET.x;
  let top = point.clientY - bounds.top + TOOLTIP_OFFSET.y;
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
  // An effect event, so a caller passing a fresh callback each render does not restart the layout.
  const report = useEffectEvent((controls: GraphControls | null) => onSettled?.(controls));
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
      report({ fit: () => graph.fit(true), focus: (id) => graph.focus(id) });
    });
    return () => {
      graph.dispose();
      report(null);
    };
  }, [data, compact]);
  return { svgRef, viewportRef, settled };
}

/** The arrowhead every directed edge ends in; it takes its line's colour and opacity. */
function Arrowhead({ id }: { id: string }): ReactNode {
  return (
    <defs>
      <marker id={id} viewBox="0 -4 8 8" refX={8} refY={0} markerWidth={6} markerHeight={6} orient="auto">
        <path d="M0,-4L8,0L0,4" fill="currentColor" />
      </marker>
    </defs>
  );
}

/** Title, kind and degree of the hovered node; the hint only when a click goes somewhere. */
function Tooltip({ node, tooltipRef }: { node: GraphNode | null; tooltipRef: RefObject<HTMLDivElement | null> }): ReactNode {
  return (
    <div ref={tooltipRef} hidden={node === null} className="pointer-events-none absolute z-10 max-w-64 rounded-lg bg-white px-3 py-2 text-xs shadow-lg ring-1 ring-zinc-950/10 dark:bg-zinc-800 dark:ring-white/10">
      {node && (
        <>
          <div className="font-medium text-zinc-900 dark:text-white">{node.title}</div>
          <div className="text-zinc-500 dark:text-zinc-400">{nodeMeta(node)}</div>
          {!node.isDangling && <div className="mt-1 text-indigo-600 dark:text-indigo-400">Click to open page</div>}
        </>
      )}
    </div>
  );
}

/** A point in the viewport. */
type ViewportPoint = { clientX: number; clientY: number };

/**
 * The hovered (or focused) node and its tooltip. The tooltip follows the
 * pointer, and is placed after it renders, when it has a size to keep inside
 * the SVG.
 */
function useHoverTooltip(svgRef: RefObject<SVGSVGElement | null>) {
  const tooltipRef = useRef<HTMLDivElement>(null);
  const [hovered, setHovered] = useState<GraphNode | null>(null);
  const pointer = useRef<ViewportPoint>({ clientX: 0, clientY: 0 });
  const place = (): void => {
    if (tooltipRef.current && svgRef.current) placeTooltip(tooltipRef.current, svgRef.current, pointer.current);
  };
  const onMove = (event: MouseEvent): void => {
    pointer.current = { clientX: event.clientX, clientY: event.clientY };
    if (hovered) place();
  };
  const onHover = (node: GraphNode | null, point?: ViewportPoint): void => {
    if (point) pointer.current = { clientX: point.clientX, clientY: point.clientY };
    setHovered(node);
  };
  useLayoutEffect(() => {
    if (hovered) place();
    // `place` reads refs only; the hovered node is what calls for a new placement.
  }, [hovered]);
  return { tooltipRef, hovered, onMove, onHover };
}

/** The SVG for a graph with at least one node. */
function Drawing({ data, stale, compact, onSettled, colorBy = "kind", highlightId = null, centreId }: SurfaceProps): ReactNode {
  const { svgRef, viewportRef, settled } = useGraphLayout(data, compact, onSettled);
  const { tooltipRef, hovered, onMove, onHover } = useHoverTooltip(svgRef);
  const markerId = useId();
  const largest = maxDegree(data.nodes);
  const activeId = hovered?.id ?? highlightId;
  const emphasis = useEmphasis(data, activeId);
  const colors = useNodeColors(data, stale, colorBy);
  return (
    <div className="relative">
      {!settled && <p role="status" className="absolute inset-0 grid place-items-center text-sm text-zinc-500">Arranging graph…</p>}
      <svg ref={svgRef} data-settled={settled} data-compact={compact} className={`group/graph w-full text-zinc-400 ${compact ? "h-72" : "h-[70vh]"}`}>
        <Arrowhead id={markerId} />
        <g ref={viewportRef}>
          <g>{data.edges.map((edge, index) => <EdgeLine key={`${edge.source}|${edge.target}|${index}`} edge={edge} markerId={markerId} emphasis={edgeEmphasis(edge, activeId)} />)}</g>
          <g>
            {data.nodes.map((node) => (
              <NodeGroup key={node.id} node={node} colorClass={colors.get(node.id) ?? ""} radius={nodeRadius(node.degree, largest, compact)}
                dimmed={emphasis !== null && !emphasis.has(node.id)} ringed={node.id === centreId}
                labelled={node.id === centreId || (emphasis?.has(node.id) === true && (!compact || node.id === activeId))}
                label={shortLabel(node.title, compact ? LABEL_CHARS.compact : LABEL_CHARS.full)}
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
  if (props.data.nodes.length > 0) return <Drawing {...props} />;
  return (
    <EmptyState title="Nothing to graph yet" command="$ llmwiki compile"
      body="The graph draws links between compiled pages. Compile at least two pages that reference each other to see structure here." />
  );
}

interface CanvasProps {
  wiki: PagesEnvelope;
  onSettled?: OnSettled;
  colorBy?: ColorBy;
  highlightId?: string | null;
}

/** Load `/api/graph` and draw the explorer's full-size graph; stale colouring comes from the envelope's page rows. */
export function GraphCanvas({ wiki, onSettled, colorBy, highlightId }: CanvasProps): ReactNode {
  const state = useAsync(fetchGraph, wiki.updatedAt);
  const stale = useMemo(() => staleIds(wiki), [wiki]);
  return (
    <AsyncView state={state}>
      {(data) => <GraphSurface data={data} stale={stale} compact={false} onSettled={onSettled} colorBy={colorBy} highlightId={highlightId} />}
    </AsyncView>
  );
}
