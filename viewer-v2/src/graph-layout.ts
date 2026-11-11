/**
 * The moving parts of a rendered graph: the force simulation, zoom and pan,
 * node drag, and the Fit action. React draws the SVG once; this module then
 * owns the positions, writing each tick straight to the `<line>` and `<g>`
 * elements by index so a layout of hundreds of nodes never re-renders React.
 * The layout settles off screen in short batches before the first frame, so
 * the initial Fit frames the final shape rather than the seed positions, and
 * a slow layout never blocks navigation.
 */
// Named imports from `d3` tree-shake to the force, selection, zoom, drag and
// transition modules; the vendored IIFE the original client loads is not used.
import {
  drag, forceCenter, forceLink, forceManyBody, forceSimulation, select, zoom, zoomIdentity,
  type Simulation, type SimulationLinkDatum, type SimulationNodeDatum, type ZoomBehavior,
} from "d3";
import type { GraphData, GraphNode } from "./api";
import { forcesFor, frameFor, ZOOM_SCALE_EXTENT } from "./graph-model";

type SimNode = GraphNode & SimulationNodeDatum;
type SimLink = SimulationLinkDatum<SimNode>;

/** What a settled graph lets its screen do. */
export interface GraphControls {
  /** Re-frame the current positions in the viewport. */
  fit: () => void;
}

/** A graph bound to its SVG; `dispose` stops everything when the SVG leaves. */
export interface MountedGraph {
  /** Resolves true once the layout settled, false if the graph was disposed first. */
  settle: () => Promise<boolean>;
  fit: (animate: boolean) => void;
  dispose: () => void;
}

/** The elements positions are written to, in the order React rendered them. */
interface Canvas {
  svg: SVGSVGElement;
  viewport: SVGGElement;
  width: number;
  height: number;
  nodeElements: SVGGElement[];
  lineElements: SVGLineElement[];
}

const DEFAULT_WIDTH = 800;
const DEFAULT_HEIGHT = 600;
/** Layout work per batch; yielding between batches keeps the page responsive. */
const LAYOUT_BATCH_MS = 8;
const FIT_TRANSITION_MS = 750;
/** Alpha a drag keeps the simulation at, so neighbours follow the dragged node. */
const DRAG_ALPHA_TARGET = 0.3;

/** Measure the SVG and collect its elements; the viewBox matches the measured size. */
function readCanvas(svg: SVGSVGElement, viewport: SVGGElement): Canvas {
  const width = svg.clientWidth || DEFAULT_WIDTH;
  const height = svg.clientHeight || DEFAULT_HEIGHT;
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  return {
    svg, viewport, width, height,
    nodeElements: Array.from(viewport.querySelectorAll<SVGGElement>("[data-node]")),
    lineElements: Array.from(viewport.querySelectorAll<SVGLineElement>("line")),
  };
}

/** A link's endpoint once the simulation has resolved ids to nodes. */
function endpoint(end: SimLink["source"]): SimNode {
  return end as SimNode;
}

/** Write every current position to the SVG. */
function writePositions(canvas: Canvas, nodes: SimNode[], links: SimLink[]): void {
  nodes.forEach((node, index) => {
    canvas.nodeElements[index]?.setAttribute("transform", `translate(${node.x ?? 0},${node.y ?? 0})`);
  });
  links.forEach((link, index) => {
    const line = canvas.lineElements[index];
    if (line === undefined) return;
    const source = endpoint(link.source);
    const target = endpoint(link.target);
    line.setAttribute("x1", String(source.x ?? 0));
    line.setAttribute("y1", String(source.y ?? 0));
    line.setAttribute("x2", String(target.x ?? 0));
    line.setAttribute("y2", String(target.y ?? 0));
  });
}

/** The simulation over copies of the data, so the payload React renders stays plain. */
function createSimulation(data: GraphData, canvas: Canvas, compact: boolean): { simulation: Simulation<SimNode, SimLink>; nodes: SimNode[]; links: SimLink[] } {
  const nodes: SimNode[] = data.nodes.map((node) => ({ ...node }));
  const links: SimLink[] = data.edges.map((edge) => ({ source: edge.source, target: edge.target }));
  const forces = forcesFor(compact, canvas.width, canvas.height, nodes.length);
  const simulation = forceSimulation(nodes)
    .force("link", forceLink<SimNode, SimLink>(links).id((node) => node.id).distance(forces.linkDistance))
    .force("charge", forceManyBody().strength(forces.charge))
    .force("center", forceCenter(canvas.width / 2, canvas.height / 2))
    .stop();
  return { simulation, nodes, links };
}

/** Wheel zoom and pan on the SVG, applied to the inner group. */
function attachZoom(canvas: Canvas): ZoomBehavior<SVGSVGElement, unknown> {
  const behaviour = zoom<SVGSVGElement, unknown>()
    .scaleExtent([...ZOOM_SCALE_EXTENT])
    .on("zoom", (event) => canvas.viewport.setAttribute("transform", String(event.transform)));
  select(canvas.svg).call(behaviour);
  return behaviour;
}

/** Let the explorer reposition nodes; the simulation warms up while one is held. */
function attachDrag(canvas: Canvas, nodes: SimNode[], simulation: Simulation<SimNode, SimLink>): void {
  const behaviour = drag<SVGGElement, SimNode>()
    .on("start", (event, node) => {
      if (!event.active) simulation.alphaTarget(DRAG_ALPHA_TARGET).restart();
      node.fx = node.x;
      node.fy = node.y;
    })
    .on("drag", (event, node) => {
      node.fx = event.x;
      node.fy = event.y;
    })
    .on("end", (event, node) => {
      if (!event.active) simulation.alphaTarget(0);
      node.fx = null;
      node.fy = null;
    });
  select(canvas.viewport).selectAll<SVGGElement, SimNode>("[data-node]").data(nodes).call(behaviour);
}

/** Run ticks in short batches until the simulation cools, yielding between batches. */
async function settleLayout(simulation: Simulation<SimNode, SimLink>, isLive: () => boolean): Promise<boolean> {
  while (simulation.alpha() > simulation.alphaMin()) {
    if (!isLive()) return false;
    const start = performance.now();
    do simulation.tick();
    while (simulation.alpha() > simulation.alphaMin() && performance.now() - start < LAYOUT_BATCH_MS);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return isLive();
}

/** True when the system asks for reduced motion; Fit then jumps instead of gliding. */
function prefersReducedMotion(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Frame the live positions. The transform goes through the zoom behaviour,
 * the same path wheel and drag gestures take, so the next pan continues from
 * the fitted view rather than jumping back to where the behaviour last was.
 */
function fitView(canvas: Canvas, behaviour: ZoomBehavior<SVGSVGElement, unknown>, nodes: SimNode[], animate: boolean): void {
  const points = nodes.map((node) => ({ x: node.x ?? 0, y: node.y ?? 0 }));
  const frame = frameFor(points, canvas.width, canvas.height);
  const transform = zoomIdentity.translate(frame.x, frame.y).scale(frame.k);
  behaviour.scaleExtent([Math.min(ZOOM_SCALE_EXTENT[0], frame.k), ZOOM_SCALE_EXTENT[1]]);
  const svg = select(canvas.svg);
  if (animate && !prefersReducedMotion()) svg.transition().duration(FIT_TRANSITION_MS).call(behaviour.transform, transform);
  else svg.call(behaviour.transform, transform);
}

/** Bind the simulation, zoom, and (in the explorer) drag to an SVG React has drawn. */
export function mountGraph(svg: SVGSVGElement, viewport: SVGGElement, data: GraphData, compact: boolean): MountedGraph {
  const canvas = readCanvas(svg, viewport);
  const { simulation, nodes, links } = createSimulation(data, canvas, compact);
  const behaviour = attachZoom(canvas);
  if (!compact) attachDrag(canvas, nodes, simulation);
  let live = true;
  simulation.on("tick", () => writePositions(canvas, nodes, links));
  return {
    settle: async () => {
      const settled = await settleLayout(simulation, () => live);
      if (settled) writePositions(canvas, nodes, links);
      return settled;
    },
    fit: (animate) => fitView(canvas, behaviour, nodes, animate),
    dispose: () => {
      live = false;
      simulation.stop();
      select(svg).on(".zoom", null);
    },
  };
}
