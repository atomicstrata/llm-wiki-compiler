/**
 * @file src/operation-bundles/manifest-graph.ts
 * @description Read-side validation for immutable supersession and recovery
 * edges. Missing predecessors are dangling; unavailable state remains a
 * distinct fail-closed condition and is never reclassified as absence.
 */

import type { BundleId } from "./ids.js";
import type {
  BundleGraphLookup,
  BundleGraphNode,
  OperationBundleManifest,
} from "./types.js";

type EdgeKind = "supersedes" | "recovers";
type BundleEdge = { kind: EdgeKind; target: BundleId };
const MAX_GRAPH_NODES = 100_000;

interface ManifestGraphIndex {
  byId: Map<BundleId, OperationBundleManifest>;
  dependencies: Map<BundleId, number>;
  dependents: Map<BundleId, BundleId[]>;
  successors: Map<string, BundleId>;
}

/** One graph leg could not be read or verified. */
export class BundleGraphUnavailableError extends Error {
  constructor() {
    super("operation bundle graph unavailable");
    this.name = "BundleGraphUnavailableError";
  }
}

/** Validate current edges, predecessor uniqueness, and the complete ancestor graph. */
export async function validateBundleGraph(
  manifest: OperationBundleManifest,
  lookup: BundleGraphLookup,
): Promise<void> {
  const edges = manifestEdges(manifest);
  assertDistinctEdgeRoles(edges);
  for (const edge of edges) {
    if (edge.target === manifest.bundleId) throw new Error("bundle graph self-reference");
    const predecessor = await requiredNode(edge.target, lookup);
    validateNode(predecessor, edge.target, manifest.workspaceId);
    validateSuccessor(edge, predecessor, manifest.bundleId);
    await validateAncestors(predecessor, manifest, lookup);
  }
}

/** Reject one target serving both immutable predecessor roles. */
function assertDistinctEdgeRoles(edges: readonly BundleEdge[]): void {
  if (edges.length === 2 && edges[0]?.target === edges[1]?.target) {
    throw new Error("bundle graph has contradictory edge roles");
  }
}

/** Add one role-specific successor and reject a fork immediately. */
function addSuccessor(
  successors: Map<string, BundleId>,
  edge: BundleEdge,
  current: BundleId,
): void {
  const key = `${edge.kind}\0${edge.target}`;
  const prior = successors.get(key);
  if (prior !== undefined && prior !== current) throw new Error(`bundle graph ${edge.kind} fork`);
  successors.set(key, current);
}

/** Build the unique bounded identity index for a complete retained set. */
function indexManifests(
  manifests: readonly OperationBundleManifest[],
): Map<BundleId, OperationBundleManifest> {
  if (manifests.length > MAX_GRAPH_NODES) throw new Error("bundle graph node bound exceeded");
  const result = new Map<BundleId, OperationBundleManifest>();
  for (const manifest of manifests) {
    if (result.has(manifest.bundleId)) throw new Error("bundle graph contains duplicate bundle identity");
    result.set(manifest.bundleId, manifest);
  }
  return result;
}

/** Require one direct predecessor identity and workspace binding. */
function indexedPredecessor(
  graph: ManifestGraphIndex,
  manifest: OperationBundleManifest,
  edge: BundleEdge,
): OperationBundleManifest {
  if (edge.target === manifest.bundleId) throw new Error("bundle graph self-reference");
  const predecessor = graph.byId.get(edge.target);
  if (predecessor === undefined) throw new Error("bundle graph has dangling predecessor");
  if (predecessor.workspaceId !== manifest.workspaceId) {
    throw new Error("bundle graph crosses workspace boundary");
  }
  return predecessor;
}

/** Index one already-validated direct dependency and reverse adjacency. */
function indexEdge(
  graph: ManifestGraphIndex,
  manifest: OperationBundleManifest,
  edge: BundleEdge,
): void {
  indexedPredecessor(graph, manifest, edge);
  addSuccessor(graph.successors, edge, manifest.bundleId);
  graph.dependencies.set(manifest.bundleId, graph.dependencies.get(manifest.bundleId)! + 1);
  graph.dependents.set(edge.target, [
    ...(graph.dependents.get(edge.target) ?? []), manifest.bundleId,
  ]);
}

/** Index all immutable predecessor roles for one manifest. */
function indexManifestEdges(graph: ManifestGraphIndex, manifest: OperationBundleManifest): void {
  const edges = manifestEdges(manifest);
  assertDistinctEdgeRoles(edges);
  for (const edge of edges) indexEdge(graph, manifest, edge);
}

/** Index and validate all direct edges in one bounded linear pass. */
function indexManifestGraph(manifests: readonly OperationBundleManifest[]): {
  dependencies: Map<BundleId, number>;
  dependents: Map<BundleId, BundleId[]>;
} {
  const byId = indexManifests(manifests);
  const graph: ManifestGraphIndex = {
    byId, dependencies: new Map([...byId.keys()].map((id) => [id, 0])),
    dependents: new Map(), successors: new Map(),
  };
  for (const manifest of manifests) indexManifestEdges(graph, manifest);
  return { dependencies: graph.dependencies, dependents: graph.dependents };
}

/** Validate the complete retained graph once with indexed, memoized traversal. */
export function validateBundleGraphSet(manifests: readonly OperationBundleManifest[]): void {
  const { dependencies, dependents } = indexManifestGraph(manifests);
  const ready = [...dependencies].filter(([, count]) => count === 0).map(([id]) => id);
  let visited = 0;
  while (ready.length > 0) {
    const current = ready.pop()!;
    visited += 1;
    for (const dependent of dependents.get(current) ?? []) {
      const remaining = dependencies.get(dependent)! - 1;
      dependencies.set(dependent, remaining);
      if (remaining === 0) ready.push(dependent);
    }
  }
  if (visited !== manifests.length) throw new Error("bundle graph contains a cycle");
}

/** Return only the optional edges actually declared by the current manifest. */
function manifestEdges(manifest: OperationBundleManifest): BundleEdge[] {
  const result: BundleEdge[] = [];
  if (manifest.supersedesBundleId !== undefined) result.push({ kind: "supersedes", target: manifest.supersedesBundleId });
  if (manifest.recoversBundleId !== undefined) result.push({ kind: "recovers", target: manifest.recoversBundleId });
  return result;
}

/** Require one readable predecessor, preserving unavailable versus absent. */
async function requiredNode(bundleId: BundleId, lookup: BundleGraphLookup): Promise<BundleGraphNode> {
  const result = await lookup(bundleId);
  if (result.status === "unavailable") throw new BundleGraphUnavailableError();
  if (result.status === "absent") throw new Error("bundle graph has dangling predecessor");
  if (result.node.bundleId !== bundleId) throw new Error("bundle graph lookup returned another bundle");
  return result.node;
}

/** Reject lookup swaps, cross-workspace nodes, and internally contradictory nodes. */
function validateNode(node: BundleGraphNode, expectedId: BundleId, workspaceId: string): void {
  if (node.bundleId !== expectedId) throw new Error("bundle graph lookup returned another bundle");
  if (node.workspaceId !== workspaceId) throw new Error("bundle graph crosses workspace boundary");
  if (node.supersedesBundleId !== undefined && node.supersedesBundleId === node.recoversBundleId) {
    throw new Error("bundle graph has contradictory edge roles");
  }
  if (node.supersededByBundleIds.length > 1 || node.recoveredByBundleIds.length > 1) {
    throw new Error("bundle graph contains a fork");
  }
}

/** Ensure the predecessor has no different successor in this edge role. */
function validateSuccessor(
  edge: BundleEdge,
  predecessor: BundleGraphNode,
  currentId: BundleId,
): void {
  const { successors, opposite } = successorRoles(predecessor, edge.kind);
  if (opposite.includes(currentId)) throw new Error("bundle graph successor has contradictory role");
  if (successors.some((bundleId) => bundleId !== currentId)) {
    throw new Error(`bundle graph ${edge.kind} fork`);
  }
}

/** Traverse both immutable predecessor roles and reject cycles or unreadable legs. */
async function validateAncestors(
  initial: BundleGraphNode,
  manifest: OperationBundleManifest,
  lookup: BundleGraphLookup,
): Promise<void> {
  const pending: Array<{ node: BundleGraphNode; exiting: boolean }> = [{ node: initial, exiting: false }];
  const active = new Set<BundleId>();
  const complete = new Set<BundleId>();
  while (pending.length > 0) {
    const current = pending.pop()!;
    const { node } = current;
    if (current.exiting) {
      active.delete(node.bundleId);
      complete.add(node.bundleId);
      continue;
    }
    if (complete.has(node.bundleId)) continue;
    if (active.has(node.bundleId)) throw new Error("bundle graph contains a cycle");
    active.add(node.bundleId);
    validateNode(node, node.bundleId, manifest.workspaceId);
    pending.push({ node, exiting: true });
    for (const edge of predecessorEdges(node)) {
      if (edge.target === manifest.bundleId) throw new Error("bundle graph contains a cycle");
      const predecessor = await requiredNode(edge.target, lookup);
      validateNode(predecessor, edge.target, manifest.workspaceId);
      validateHistoricalSuccessor(edge, predecessor, node.bundleId);
      pending.push({ node: predecessor, exiting: false });
    }
  }
}

/** Require a historical predecessor to index its already-written successor. */
function validateHistoricalSuccessor(edge: BundleEdge, predecessor: BundleGraphNode, currentId: BundleId): void {
  const { successors, opposite } = successorRoles(predecessor, edge.kind);
  if (opposite.includes(currentId)) throw new Error("bundle graph historical successor has contradictory role");
  if (successors.length !== 1 || successors[0] !== currentId) {
    throw new Error("bundle graph historical reverse index mismatch");
  }
}

/** Select the role-correct and opposite successor indexes for one edge. */
function successorRoles(node: BundleGraphNode, kind: EdgeKind): {
  successors: readonly BundleId[];
  opposite: readonly BundleId[];
} {
  return kind === "supersedes"
    ? { successors: node.supersededByBundleIds, opposite: node.recoveredByBundleIds }
    : { successors: node.recoveredByBundleIds, opposite: node.supersededByBundleIds };
}

/** Return the distinct immutable predecessor edges for one node. */
function predecessorEdges(node: BundleGraphNode): BundleEdge[] {
  const result: BundleEdge[] = [];
  if (node.supersedesBundleId !== undefined) result.push({ kind: "supersedes", target: node.supersedesBundleId });
  if (node.recoversBundleId !== undefined) result.push({ kind: "recovers", target: node.recoversBundleId });
  if (result.length === 2 && result[0]?.target === result[1]?.target) {
    throw new Error("bundle graph has contradictory edge roles");
  }
  return result;
}
