/**
 * The rules of the graph that need no DOM: which colour a node takes, how big
 * it is, where a click goes, what the tooltip and legend say, how strong the
 * forces are, and how to frame a settled layout. Pure functions, so the
 * explorer and the page rail's neighbourhood share one set of rules and the
 * tests pin them without a browser.
 */
import type { GraphNode, PagesEnvelope } from "./api";
import { pageHref } from "./route";
import { plural } from "./wiki-model";

/** The four node colours, in the order the legend lists them. */
export type NodeKind = "concept" | "entity" | "stale" | "dangling";

/** One default-palette colour per node kind; the node fills with `currentColor`, so this is all it takes. */
export const KIND_COLOR: Record<NodeKind, string> = {
  concept: "text-indigo-500",
  entity: "text-green-600",
  stale: "text-amber-500",
  dangling: "text-red-500",
};

/** Legend rows for node colours. */
export const NODE_LEGEND: readonly { kind: NodeKind; label: string }[] = [
  { kind: "concept", label: "concept" },
  { kind: "entity", label: "entity" },
  { kind: "stale", label: "stale" },
  { kind: "dangling", label: "dangling" },
];

/** Legend rows for edge kinds: a wikilink is solid, a typed relation dashed. */
export const EDGE_LEGEND: readonly { kind: "wikilink" | "relation"; label: string }[] = [
  { kind: "wikilink", label: "wikilink" },
  { kind: "relation", label: "relation" },
];

/** Page ids whose sources moved on since the last compile. */
export function staleIds(wiki: PagesEnvelope): Set<string> {
  return new Set(wiki.pages.filter((page) => page.freshness.freshnessStatus === "stale").map((page) => page.id));
}

/**
 * A ghost has no page at all, and a stale page outranks its kind because "the
 * source moved on" is the more urgent fact; only then does kind decide.
 */
export function nodeKind(node: GraphNode, stale: Set<string>): NodeKind {
  if (node.isDangling === true || node.kind === "dangling") return "dangling";
  if (stale.has(node.id)) return "stale";
  return node.nodeKind === "entity" ? "entity" : "concept";
}

/** Radius bounds per mode: the rail's small drawing uses a fraction of the explorer's size. */
const RADIUS_BOUNDS = { full: { min: 4, max: 10 }, compact: { min: 2.5, max: 6 } } as const;

/** Radius grows linearly with degree, so the most connected node is always the largest. */
export function nodeRadius(degree: number, maxDegree: number, compact: boolean): number {
  const { min, max } = compact ? RADIUS_BOUNDS.compact : RADIUS_BOUNDS.full;
  if (maxDegree === 0) return min;
  return min + (degree / maxDegree) * (max - min);
}

const HIGH_DEGREE = 5;

/** A thicker outline marks hubs; an isolated node gets the thinnest. */
export function nodeStrokeWidth(degree: number): number {
  if (degree > HIGH_DEGREE) return 2.5;
  return degree > 0 ? 2 : 1;
}

/** The largest degree in the graph, zero when it is empty. */
export function maxDegree(nodes: GraphNode[]): number {
  return nodes.reduce((largest, node) => Math.max(largest, node.degree), 0);
}

/**
 * Where a click goes. An entity node's `directory` is its on-disk folder, not
 * a route segment, so its link is built from the entity type; a ghost has no
 * page to open.
 */
export function nodeHref(node: GraphNode): string | null {
  if (node.isDangling === true) return null;
  if (node.nodeKind === "entity" && node.entityType !== undefined) return pageHref(node.entityType, node.slug);
  return pageHref(node.directory, node.slug);
}

/** The tooltip's second line: what the node is and how connected it is. */
export function nodeMeta(node: GraphNode): string {
  if (node.isDangling === true) return `missing page · ${plural(node.degree, "reference")}`;
  const kind = node.nodeKind === "entity" && node.entityType ? `entity · ${node.entityType}` : node.kind;
  return `${kind} · ${plural(node.degree, "connection")}`;
}

/** Link distance and charge of the simulation. */
export interface Forces {
  linkDistance: number;
  charge: number;
}

const FULL_FORCES: Forces = { linkDistance: 80, charge: -200 };

/**
 * Compact forces, used by the rail's neighbourhood, are derived from the
 * drawing's size and the node count. They were calibrated for a dashboard
 * panel this viewer no longer has, and still suit the rail. The
 * reference is the demo wiki's 8 nodes in a 443×296 panel, where each node
 * owns a square of side 128; the factors are calibrated there. The falloff
 * exponent shrinks the forces faster than the per-node budget for bigger
 * graphs, because a well-connected graph's footprint does not shrink
 * linearly with its spacing; 2.65 was the smallest value that kept an
 * 80-node graph inside the panel.
 */
const COMPACT_REFERENCE_SIDE = 128;
const COMPACT_FALLOFF_EXPONENT = 2.65;
const COMPACT_LINK_FACTOR = 1.39;
const COMPACT_CHARGE_FACTOR = 4.69;

/** The forces for one render; the explorer's are fixed, a compact drawing's follow its size. */
export function forcesFor(compact: boolean, width: number, height: number, nodeCount: number): Forces {
  if (!compact) return FULL_FORCES;
  const side = Math.sqrt((width * height) / Math.max(1, nodeCount));
  const scaled = side * (side / COMPACT_REFERENCE_SIDE) ** (COMPACT_FALLOFF_EXPONENT - 1);
  return { linkDistance: scaled * COMPACT_LINK_FACTOR, charge: -scaled * COMPACT_CHARGE_FACTOR };
}

/** Zoom bounds shared by the wheel and the Fit action. */
export const ZOOM_SCALE_EXTENT: readonly [number, number] = [0.1, 4];
const FIT_PADDING = 32;
/** A one-node graph has no extent; treat it as this wide so the scale stays finite. */
const FIT_MIN_EXTENT = 1;

/** A zoom transform: scale `k` after translating by `x`, `y`. */
export interface Frame {
  k: number;
  x: number;
  y: number;
}

/** A point of a settled layout. */
export interface Point {
  x: number;
  y: number;
}

/**
 * The transform that centres the points in a `width`×`height` viewport with
 * padding on every side, never magnifying past the zoom limit.
 */
export function frameFor(points: Point[], width: number, height: number): Frame {
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const spanX = Math.max(maxX - minX, FIT_MIN_EXTENT);
  const spanY = Math.max(maxY - minY, FIT_MIN_EXTENT);
  const k = Math.min((width - FIT_PADDING * 2) / spanX, (height - FIT_PADDING * 2) / spanY, ZOOM_SCALE_EXTENT[1]);
  return { k, x: width / 2 - k * ((minX + maxX) / 2), y: height / 2 - k * ((minY + maxY) / 2) };
}
