/**
 * @file test/operation-bundles/manifest-graph.test.ts
 * @description Verifies immutable bundle graph validation distinguishes absent
 * from unavailable and rejects cross-workspace, cyclic, forked, or conflicting edges.
 */

import { describe, expect, it } from "vitest";
import {
  BundleGraphUnavailableError,
  validateBundleGraph,
  validateBundleGraphSet,
} from "../../src/operation-bundles/manifest-graph.js";
import type {
  BundleGraphLookup,
  BundleGraphNode,
  OperationBundleManifest,
} from "../../src/operation-bundles/types.js";
import { mintBundleId, type BundleId } from "../../src/operation-bundles/ids.js";

const CURRENT = "bnd_01J00000000000000000000000" as BundleId;
const FIRST = "bnd_01J00000000000000000000001" as BundleId;
const SECOND = "bnd_01J00000000000000000000002" as BundleId;
const THIRD = "bnd_01J00000000000000000000003" as BundleId;
const FOURTH = "bnd_01J00000000000000000000004" as BundleId;

/** Make the graph-only manifest fields; parsing behavior is tested separately. */
function manifest(edges: Partial<OperationBundleManifest> = {}): OperationBundleManifest {
  return {
    schemaVersion: 1, bundleId: CURRENT, runId: "opr_01J00000000000000000000000",
    workspaceId: "research", createdAt: "2026-07-17T00:00:00.000Z", createdBy: "operator",
    knowledgeAuthority: { id: "knowledge", digest: `sha256:${"a".repeat(64)}` },
    operationsAuthority: {
      packId: "ops", packDigest: `sha256:${"a".repeat(64)}`,
      actionId: "compile", actionDescriptorDigest: `sha256:${"a".repeat(64)}`,
    },
    grantDigest: `sha256:${"a".repeat(64)}`, safetyFloorDigest: `sha256:${"a".repeat(64)}`,
    inputs: [], preparationEvidence: [], bounds: [],
    completeness: {
      attempted: 0, completed: 0, skipped: 0, failed: 0,
      requiredMissing: 0, optionalMissing: 0, rationaleDigest: `sha256:${"a".repeat(64)}`,
    },
    reconciliations: [], mutations: [], planningWarnings: [], ...edges,
  };
}

/** Build an in-memory lookup whose nodes include read-side successor indexes. */
function lookup(nodes: BundleGraphNode[], unavailable: BundleId[] = []): BundleGraphLookup {
  const byId = new Map(nodes.map((node) => [node.bundleId, node]));
  return async (bundleId) => {
    if (unavailable.includes(bundleId)) return { status: "unavailable", problem: "unreadable" };
    const node = byId.get(bundleId);
    return node ? { status: "ok", node } : { status: "absent" };
  };
}

/** Create one healthy graph node with optional immutable predecessor edges. */
function node(bundleId: BundleId, edges: Partial<BundleGraphNode> = {}): BundleGraphNode {
  return {
    bundleId, workspaceId: "research", supersededByBundleIds: [],
    recoveredByBundleIds: [], ...edges,
  };
}

describe("operation bundle graph validation", () => {
  it("accepts a single same-workspace supersession edge", async () => {
    const predecessor = node(FIRST, { supersededByBundleIds: [CURRENT] });

    await expect(validateBundleGraph(manifest({ supersedesBundleId: FIRST }), lookup([predecessor])))
      .resolves.toBeUndefined();
  });

  it("allows an empty direct reverse index before the proposed write", async () => {
    await expect(validateBundleGraph(manifest({ supersedesBundleId: FIRST }), lookup([node(FIRST)])))
      .resolves.toBeUndefined();
  });

  it("rejects a direct successor indexed under the opposite role", async () => {
    const predecessor = node(FIRST, { recoveredByBundleIds: [CURRENT] });

    await expect(validateBundleGraph(manifest({ supersedesBundleId: FIRST }), lookup([predecessor])))
      .rejects.toThrow(/role/);
  });

  it("rejects a self-reference and contradictory edge roles", async () => {
    await expect(validateBundleGraph(manifest({ supersedesBundleId: CURRENT }), lookup([])))
      .rejects.toThrow(/self/);
    await expect(validateBundleGraph(manifest({ supersedesBundleId: FIRST, recoversBundleId: FIRST }), lookup([])))
      .rejects.toThrow(/contradictory/);
  });

  it("distinguishes a dangling predecessor from unavailable state", async () => {
    await expect(validateBundleGraph(manifest({ supersedesBundleId: FIRST }), lookup([])))
      .rejects.toThrow(/dangling/);
    await expect(validateBundleGraph(manifest({ supersedesBundleId: FIRST }), lookup([], [FIRST])))
      .rejects.toBeInstanceOf(BundleGraphUnavailableError);
  });

  it("rejects a predecessor in another workspace", async () => {
    const foreign = node(FIRST, { workspaceId: "newsroom", supersededByBundleIds: [CURRENT] });

    await expect(validateBundleGraph(manifest({ supersedesBundleId: FIRST }), lookup([foreign])))
      .rejects.toThrow(/workspace/);
  });

  it("rejects a supersession fork", async () => {
    const predecessor = node(FIRST, { supersededByBundleIds: [SECOND] });

    await expect(validateBundleGraph(manifest({ supersedesBundleId: FIRST }), lookup([predecessor])))
      .rejects.toThrow(/fork/);
  });

  it("rejects direct and transitive cycles across immutable edges", async () => {
    const direct = node(FIRST, { supersedesBundleId: CURRENT, supersededByBundleIds: [CURRENT] });
    const transitive = node(FIRST, { supersedesBundleId: SECOND, supersededByBundleIds: [CURRENT] });
    const cycle = node(SECOND, { recoversBundleId: CURRENT, supersededByBundleIds: [FIRST] });

    await expect(validateBundleGraph(manifest({ supersedesBundleId: FIRST }), lookup([direct])))
      .rejects.toThrow(/cycle/);
    await expect(validateBundleGraph(manifest({ supersedesBundleId: FIRST }), lookup([transitive, cycle])))
      .rejects.toThrow(/cycle/);
  });

  it("propagates unavailable state discovered during transitive validation", async () => {
    const predecessor = node(FIRST, { supersedesBundleId: SECOND, supersededByBundleIds: [CURRENT] });

    await expect(validateBundleGraph(manifest({ supersedesBundleId: FIRST }), lookup([predecessor], [SECOND])))
      .rejects.toBeInstanceOf(BundleGraphUnavailableError);
  });

  it("rejects inconsistent and missing historical reverse indexes", async () => {
    const first = node(FIRST, { supersedesBundleId: SECOND, supersededByBundleIds: [CURRENT] });
    const wrong = node(SECOND, { supersededByBundleIds: [THIRD] });

    await expect(validateBundleGraph(manifest({ supersedesBundleId: FIRST }), lookup([first, wrong])))
      .rejects.toThrow(/historical|fork/);
    await expect(validateBundleGraph(manifest({ supersedesBundleId: FIRST }), lookup([first, node(SECOND)])))
      .rejects.toThrow(/historical|index/);
  });

  it("rejects a lookup result substituted for the requested ancestor", async () => {
    const first = node(FIRST, { supersedesBundleId: SECOND, supersededByBundleIds: [CURRENT] });
    const substituted: BundleGraphLookup = async (id) => id === FIRST
      ? { status: "ok", node: first } : { status: "ok", node: node(THIRD) };

    await expect(validateBundleGraph(manifest({ supersedesBundleId: FIRST }), substituted))
      .rejects.toThrow(/another bundle/);
  });

  it("accepts convergent acyclic predecessor branches", async () => {
    const first = node(FIRST, { supersedesBundleId: SECOND, recoversBundleId: THIRD, supersededByBundleIds: [CURRENT] });
    const second = node(SECOND, { supersedesBundleId: FOURTH, supersededByBundleIds: [FIRST] });
    const third = node(THIRD, { recoversBundleId: FOURTH, recoveredByBundleIds: [FIRST] });
    const shared = node(FOURTH, { supersededByBundleIds: [SECOND], recoveredByBundleIds: [THIRD] });

    await expect(validateBundleGraph(
      manifest({ supersedesBundleId: FIRST }),
      lookup([first, second, third, shared]),
    )).resolves.toBeUndefined();
  });

  it("rejects a recovery fork using the same read-side rule", async () => {
    const predecessor = node(FIRST, { recoveredByBundleIds: [THIRD] });

    await expect(validateBundleGraph(manifest({ recoversBundleId: FIRST }), lookup([predecessor])))
      .rejects.toThrow(/fork/);
  });

  it("validates a long retained chain once while preserving fork and cycle refusals", () => {
    const chain: OperationBundleManifest[] = [];
    for (let index = 0; index < 2_000; index++) {
      const predecessor = chain.at(-1)?.bundleId;
      chain.push(manifest({
        bundleId: mintBundleId(),
        ...(predecessor === undefined ? {} : { supersedesBundleId: predecessor }),
      }));
    }
    expect(() => validateBundleGraphSet(chain)).not.toThrow();
    const fork = manifest({ bundleId: mintBundleId(), supersedesBundleId: chain[0]!.bundleId });
    expect(() => validateBundleGraphSet([...chain, fork])).toThrow(/fork/);
    const cycle = { ...chain[0]!, recoversBundleId: chain.at(-1)!.bundleId };
    expect(() => validateBundleGraphSet([cycle, ...chain.slice(1)])).toThrow(/cycle/);
  });
});
