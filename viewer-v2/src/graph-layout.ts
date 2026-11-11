/**
 * The moving parts of a rendered graph: the force simulation, zoom and pan,
 * node drag, and the Fit action. React draws the SVG once; this module then
 * owns the positions, writing each tick straight to the `<line>` and `<g>`
 * elements by index so a layout of hundreds of nodes never re-renders React.
 * The layout settles off screen in short batches before the first frame, so
 * the initial Fit frames the final shape rather than the seed positions, and
 * a slow layout never blocks navigation. Every zoom also publishes its scale
 * to the SVG as `--graph-k` and `data-zoomed`, so labels can keep a constant
 * on-screen size and appear only once the reader has zoomed in.
 */
// Named imports from `d3` tree-shake to the force, selection, zoom, drag and
// transition modules; the vendored IIFE the original client loads is not used.
import {
  drag, forceCenter, forceLink, forceManyBody, forceSimulation, forceX, forceY, select, zoom, zoomIdentity, zoomTransform,
  type Simulation, type SimulationLinkDatum, type SimulationNodeDatum, type ZoomBehavior, type ZoomTransform,
} from "d3";
import type { GraphData, GraphNode } from "./api";
import { forcesFor, frameFor, maxDegree, nodeRadius, nodeStrokeWidth, ZOOM_SCALE_EXTENT } from "./graph-model";
import { prefersReducedMotion } from "./media";

type SimNode = GraphNode & SimulationNodeDatum;
type SimLink = SimulationLinkDatum<SimNode>;

/** What a settled graph lets its screen do. */
export interface GraphControls {
  /** Re-frame the current positions in the viewport. */
  fit: () => void;
  /** Centre one node and zoom in far enough to read its neighbours. */
  focus: (id: string) => void;
}

/** A graph bound to its SVG; `dispose` stops everything when the SVG leaves. */
export interface MountedGraph {
  /** Resolves true once the layout settled, false if the graph was disposed first. */
  settle: () => Promise<boolean>;
  fit: (animate: boolean) => void;
  focus: (id: string) => void;
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
  /** Each node's drawn radius plus half its outline: where an edge stops so its arrowhead shows. */
  rims: Map<string, number>;
}

const DEFAULT_WIDTH = 800;
const DEFAULT_HEIGHT = 600;
/** Layout work per batch; yielding between batches keeps the page responsive. */
const LAYOUT_BATCH_MS = 8;
const FIT_TRANSITION_MS = 750;
/** Alpha a drag keeps the simulation at, so neighbours follow the dragged node. */
const DRAG_ALPHA_TARGET = 0.3;
/** Labels show from this scale; below it they would overlap into noise. */
const LABEL_SCALE = 1.4;
/** Focusing a node zooms to at least this scale. */
const FOCUS_SCALE = 2;
/**
 * Pull toward the centre. Without it, repulsion pushes every unlinked node
 * or small component outward until Fit shrinks the drawing below legibility:
 * a few hundred nodes in the explorer, or the rail's loosely joined
 * neighbourhood. The rail's size-derived forces are weaker, so its pull is
 * too.
 */
const GRAVITY = { full: 0.3, compact: 0.15 } as const;

/** Each node's rim distance from its centre, matching how the canvas draws it. */
function nodeRims(data: GraphData, compact: boolean): Map<string, number> {
  const largest = maxDegree(data.nodes);
  return new Map(data.nodes.map((node) => [node.id, nodeRadius(node.degree, largest, compact) + nodeStrokeWidth(node.degree) / 2]));
}

/** Measure the SVG and collect its elements; the viewBox matches the measured size. */
function readCanvas(svg: SVGSVGElement, viewport: SVGGElement, rims: Map<string, number>): Canvas {
  const width = svg.clientWidth || DEFAULT_WIDTH;
  const height = svg.clientHeight || DEFAULT_HEIGHT;
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  return {
    svg, viewport, width, height, rims,
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
    const [x1, y1, x2, y2] = [source.x ?? 0, source.y ?? 0, target.x ?? 0, target.y ?? 0];
    // Stop at the target's rim, not its centre, or the node is drawn over the arrowhead.
    const length = Math.hypot(x2 - x1, y2 - y1);
    const back = length > 0 ? Math.min(1, (canvas.rims.get(target.id) ?? 0) / length) : 0;
    line.setAttribute("x1", String(x1));
    line.setAttribute("y1", String(y1));
    line.setAttribute("x2", String(x2 - (x2 - x1) * back));
    line.setAttribute("y2", String(y2 - (y2 - y1) * back));
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
  const gravity = compact ? GRAVITY.compact : GRAVITY.full;
  simulation
    .force("x", forceX<SimNode>(canvas.width / 2).strength(gravity))
    .force("y", forceY<SimNode>(canvas.height / 2).strength(gravity));
  return { simulation, nodes, links };
}

/**
 * In a small drawing inside a scrolling panel, a plain wheel or one-finger
 * swipe is the reader scrolling the panel, not zooming the graph; it zooms
 * with Ctrl or ⌘ held, or a pinch. The explorer takes every gesture.
 */
export function zoomsOnGesture(compact: boolean, event: { type: string; ctrlKey?: boolean; metaKey?: boolean; touches?: { length: number } }): boolean {
  if (!compact) return true;
  if (event.type === "wheel") return event.ctrlKey === true || event.metaKey === true;
  return event.touches === undefined || event.touches.length > 1;
}

/** Wheel zoom and pan on the SVG, applied to the inner group. */
function attachZoom(canvas: Canvas, compact: boolean): ZoomBehavior<SVGSVGElement, unknown> {
  const behaviour = zoom<SVGSVGElement, unknown>()
    .scaleExtent([...ZOOM_SCALE_EXTENT])
    // d3's own filter (no Ctrl-drag, primary button only), then the panel's scroll rule.
    .filter((event: MouseEvent & { touches?: TouchList }) => (!event.ctrlKey || event.type === "wheel") && !event.button && zoomsOnGesture(compact, event))
    .on("zoom", (event) => {
      canvas.viewport.setAttribute("transform", String(event.transform));
      canvas.svg.style.setProperty("--graph-k", String(event.transform.k));
      canvas.svg.dataset.zoomed = String(event.transform.k >= LABEL_SCALE);
    });
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
  moveTo(canvas, behaviour, transform, animate);
}

/** Apply a view transform through the zoom behaviour, gliding unless asked not to or the reader prefers less motion. */
function moveTo(canvas: Canvas, behaviour: ZoomBehavior<SVGSVGElement, unknown>, transform: ZoomTransform, animate: boolean): void {
  const svg = select(canvas.svg);
  if (animate && !prefersReducedMotion()) svg.transition().duration(FIT_TRANSITION_MS).call(behaviour.transform, transform);
  else svg.call(behaviour.transform, transform);
}

/** Glide to centre `id` at a readable scale; a node that is not drawn leaves the view alone. */
function focusNode(canvas: Canvas, behaviour: ZoomBehavior<SVGSVGElement, unknown>, nodes: SimNode[], id: string): void {
  const node = nodes.find((candidate) => candidate.id === id);
  if (node?.x === undefined || node.y === undefined) return;
  const k = Math.max(FOCUS_SCALE, zoomTransform(canvas.svg).k);
  moveTo(canvas, behaviour, zoomIdentity.translate(canvas.width / 2 - k * node.x, canvas.height / 2 - k * node.y).scale(k), true);
}

/** Bind the simulation, zoom, and (in the explorer) drag to an SVG React has drawn. */
export function mountGraph(svg: SVGSVGElement, viewport: SVGGElement, data: GraphData, compact: boolean): MountedGraph {
  const canvas = readCanvas(svg, viewport, nodeRims(data, compact));
  const { simulation, nodes, links } = createSimulation(data, canvas, compact);
  const behaviour = attachZoom(canvas, compact);
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
    focus: (id) => focusNode(canvas, behaviour, nodes, id),
    dispose: () => {
      live = false;
      simulation.stop();
      // A Fit glide still running would keep writing to an SVG the next drawing reuses.
      select(svg).interrupt().on(".zoom", null);
    },
  };
}
