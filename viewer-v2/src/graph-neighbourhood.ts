/**
 * Graph structure the drawings derive from `/api/graph`: a node's neighbours,
 * the small graph around one page that its rail draws, and link communities
 * for colouring the explorer. Pure functions over the payload, so they are
 * tested without a browser.
 *
 * Communities come from label propagation: every node starts in its own
 * community and repeatedly joins the one its neighbours vote for, until
 * nothing changes. Each neighbour's vote weighs one over its degree, so a
 * hub's label cannot flood across the bridges it sits on; with equal votes,
 * one label would spread through every link and swallow the whole graph. It
 * is a few lines and needs no dependency. Nodes are visited in id order and
 * ties go to the smaller label, so the same graph always gets the same
 * colours.
 */
import type { GraphData } from "./api";

/** The rail's graph stays legible in a narrow panel at about this many nodes. */
const LOCAL_NODE_LIMIT = 24;
/** Propagation settles in a handful of rounds; this bounds a graph that oscillates. */
const MAX_ROUNDS = 12;
/**
 * Colours for communities. A wiki of a few hundred pages has a hundred small
 * clusters, more than any palette, so colours repeat from the largest down;
 * a cluster's members sit together in the layout, so a repeat far away does
 * not read as the same cluster. Pages that link to nothing share a quiet grey.
 */
export const COMMUNITY_COLORS = [
  "text-indigo-500", "text-emerald-500", "text-amber-500", "text-rose-500", "text-sky-500",
  "text-violet-500", "text-lime-600", "text-orange-500", "text-cyan-600", "text-fuchsia-500",
] as const;
export const UNCLUSTERED_COLOR = "text-zinc-400";

/** Each node's neighbours, ignoring direction and self-loops; build it once per graph and look nodes up. */
export function adjacency(data: GraphData): Map<string, Set<string>> {
  const neighbours = new Map(data.nodes.map((node) => [node.id, new Set<string>()]));
  for (const { source, target } of data.edges) {
    if (source === target) continue;
    neighbours.get(source)?.add(target);
    neighbours.get(target)?.add(source);
  }
  return neighbours;
}

/** Which nodes the local graph keeps: the centre, its neighbours, then second-hop nodes by degree, up to the limit. */
function localIds(data: GraphData, centre: string, limit: number): Set<string> {
  const neighbours = adjacency(data);
  const degree = new Map(data.nodes.map((node) => [node.id, node.degree]));
  const byDegree = (ids: Iterable<string>): string[] => [...ids].sort((a, b) => (degree.get(b) ?? 0) - (degree.get(a) ?? 0) || a.localeCompare(b));
  const first = byDegree(neighbours.get(centre) ?? []);
  const kept = new Set([centre, ...first.slice(0, limit - 1)]);
  const second = new Set(first.flatMap((id) => [...(neighbours.get(id) ?? [])]).filter((id) => !kept.has(id)));
  for (const id of byDegree(second)) {
    if (kept.size >= limit) break;
    kept.add(id);
  }
  return kept;
}

/** The graph around `centre`, with degrees counted inside it so node sizes suit the small drawing. */
export function localGraph(data: GraphData, centre: string, limit = LOCAL_NODE_LIMIT): GraphData {
  if (!data.nodes.some((node) => node.id === centre)) return { nodes: [], edges: [] };
  const kept = localIds(data, centre, limit);
  const edges = data.edges.filter((edge) => kept.has(edge.source) && kept.has(edge.target));
  const degree = new Map<string, number>();
  for (const { source, target } of edges) {
    degree.set(source, (degree.get(source) ?? 0) + 1);
    degree.set(target, (degree.get(target) ?? 0) + 1);
  }
  const nodes = data.nodes.filter((node) => kept.has(node.id)).map((node) => ({ ...node, degree: degree.get(node.id) ?? 0 }));
  return { nodes, edges };
}

/** The label a node's neighbours vote for, each vote weighing one over the voter's degree; ties go to the smallest, and a loner keeps its own. */
function majorityLabel(own: number, neighbours: Iterable<string>, labels: Map<string, number>, degree: Map<string, number>): number {
  const counts = new Map<number, number>();
  for (const id of neighbours) {
    const label = labels.get(id) ?? own;
    counts.set(label, (counts.get(label) ?? 0) + 1 / Math.max(1, degree.get(id) ?? 1));
  }
  let best = own;
  let bestCount = 0;
  for (const [label, count] of counts) {
    if (count > bestCount || (count === bestCount && label < best)) [best, bestCount] = [label, count];
  }
  return best;
}

/** Run label propagation to a fixed point; returns each node's raw label. */
function propagate(data: GraphData): Map<string, number> {
  const neighbours = adjacency(data);
  const degree = new Map([...neighbours].map(([id, set]) => [id, set.size]));
  const ids = data.nodes.map((node) => node.id).sort();
  const labels = new Map(ids.map((id, index) => [id, index]));
  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    let changed = false;
    for (const id of ids) {
      const next = majorityLabel(labels.get(id)!, neighbours.get(id) ?? [], labels, degree);
      if (next !== labels.get(id)) { labels.set(id, next); changed = true; }
    }
    if (!changed) break;
  }
  return labels;
}

/** Each node's community rank: 0 for the largest community, 1 for the next; -1 for a node alone. */
export function communities(data: GraphData): Map<string, number> {
  const labels = propagate(data);
  const sizes = new Map<number, number>();
  for (const label of labels.values()) sizes.set(label, (sizes.get(label) ?? 0) + 1);
  const ranked = [...sizes.entries()].filter(([, size]) => size > 1).sort((a, b) => b[1] - a[1] || a[0] - b[0]).map(([label]) => label);
  const rank = new Map(ranked.map((label, index) => [label, index]));
  return new Map([...labels].map(([id, label]) => [id, rank.get(label) ?? -1]));
}

/** The colour class for a community rank. */
export function communityColor(rank: number | undefined): string {
  return rank !== undefined && rank >= 0 ? COMMUNITY_COLORS[rank % COMMUNITY_COLORS.length] : UNCLUSTERED_COLOR;
}
