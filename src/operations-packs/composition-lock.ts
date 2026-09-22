/**
 * @file src/operations-packs/composition-lock.ts
 * @description Independent recomputation and verification of CompositionLockV1
 * (design section 11.2). The loader NEVER trusts a supplied lock: it recomputes
 * the root pack digest, member table, flattened resolved-export table, and graph
 * digest from the parsed pack, then refuses any supplied lock whose canonical
 * bytes disagree. A lock is evidence of a resolved graph, not permission to
 * accept an invalid one. The supplied lock is itself bounded, unique-key,
 * exact-shape parsed before comparison so a malformed lock fails closed distinctly
 * from a disagreeing one.
 */

import { array, enumValue, exact, record } from "../operation-bundles/manifest-values.js";
import { canonicalBytes } from "../profile/templates/signing/canonical.js";
import { parseBoundedUniqueJson } from "../profile/templates/signing/json.js";
import { MAX_COMPOSITION_LOCK_BYTES } from "../products/constants.js";
import { composeSingleRoot, digestOf } from "./composition.js";
import { MAX_COMPOSITION_MEMBERS, MAX_FLATTENED_EXPORTS } from "./constants.js";
import { assertPackDigest, assertPackId, assertRefId, assertPackVersion } from "./ids.js";
import { CompositionLockError, PackParseError, asPackProblem } from "./problems.js";
import type {
  CompositionLockV1, CompositionMemberV1, ResolvedExportV1, WorkspaceOperationsPackV2,
} from "./types.js";

const LOCK_SCHEMA_VERSION = 1 as const;
const LOCK_KEYS = ["schemaVersion", "rootPackDigest", "members", "resolvedExports", "graphDigest"] as const;
const MEMBER_KEYS = ["packId", "packVersion", "packDigest", "memberDigest"] as const;
const EXPORT_KEYS = ["kind", "exposedId", "sourcePackDigest", "sourceId", "objectDigest"] as const;
const EXPORT_KINDS = ["provider-requirement", "recipe", "action", "alias"] as const;

/**
 * Independently recompute the authoritative composition lock for one pack. The
 * graph digest binds the schema version, root pack digest, member table, and
 * sorted export table; producer and consumer derive it from this one function.
 */
export function recomputeCompositionLock(pack: WorkspaceOperationsPackV2): CompositionLockV1 {
  const graph = composeSingleRoot(pack);
  const claim = {
    schemaVersion: LOCK_SCHEMA_VERSION,
    rootPackDigest: graph.rootPackDigest,
    members: graph.members,
    resolvedExports: graph.resolvedExports,
  };
  return { ...claim, graphDigest: digestOf(claim) };
}

/** Structurally rebuild one supplied composition-lock member row. */
function parseMember(value: unknown, label: string): CompositionMemberV1 {
  const node = record(value, label);
  exact(node, MEMBER_KEYS);
  return {
    packId: assertPackId(node.packId),
    packVersion: assertPackVersion(node.packVersion),
    packDigest: assertPackDigest(node.packDigest),
    memberDigest: assertPackDigest(node.memberDigest),
  };
}

/** Structurally rebuild one supplied resolved-export row. */
function parseResolvedExport(value: unknown, label: string): ResolvedExportV1 {
  const node = record(value, label);
  exact(node, EXPORT_KEYS);
  return {
    kind: enumValue(node.kind, EXPORT_KINDS, `${label}.kind`),
    exposedId: assertRefId(node.exposedId),
    sourcePackDigest: assertPackDigest(node.sourcePackDigest),
    sourceId: assertRefId(node.sourceId),
    objectDigest: assertPackDigest(node.objectDigest),
  };
}

/** Bounded, unique-key, exact-shape parse of one supplied composition lock. */
export function parseCompositionLock(text: string): CompositionLockV1 {
  return asPackProblem(() => {
    const root = record(parseBoundedUniqueJson(text, MAX_COMPOSITION_LOCK_BYTES), "composition lock");
    exact(root, LOCK_KEYS);
    if (root.schemaVersion !== LOCK_SCHEMA_VERSION) throw new PackParseError("composition lock schemaVersion must be 1");
    return {
      schemaVersion: LOCK_SCHEMA_VERSION,
      rootPackDigest: assertPackDigest(root.rootPackDigest),
      members: array(root.members, "members", MAX_COMPOSITION_MEMBERS).map((item, index) => parseMember(item, `members[${index}]`)),
      resolvedExports: array(root.resolvedExports, "resolvedExports", MAX_FLATTENED_EXPORTS).map((item, index) => parseResolvedExport(item, `resolvedExports[${index}]`)),
      graphDigest: assertPackDigest(root.graphDigest),
    };
  });
}

/**
 * Verify a supplied composition lock against the independently recomputed graph.
 * The supplied bytes are parsed for shape, then rejected unless they canonically
 * equal the recomputed lock. The recomputed authoritative lock is returned; the
 * supplied lock is never itself trusted as authority.
 */
export function verifyCompositionLock(pack: WorkspaceOperationsPackV2, suppliedText: string): CompositionLockV1 {
  return asPackProblem(() => {
    const recomputed = recomputeCompositionLock(pack);
    const supplied = parseCompositionLock(suppliedText);
    if (!canonicalBytes(supplied).equals(canonicalBytes(recomputed))) {
      throw new CompositionLockError("supplied composition lock disagrees with the recomputed graph");
    }
    return recomputed;
  });
}
