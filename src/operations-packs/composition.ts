/**
 * @file src/operations-packs/composition.ts
 * @description Single-root composition of one operations pack into a flattened
 * export table (design section 11.3). This slice is single-root only: imports are
 * refused at parse, so the member graph is one node with no edges — trivially
 * present and acyclic (rules 1-3). Composition still derives one complete
 * flattened export table WITHOUT rewriting member bytes (rule 10), rejects
 * duplicate destination ids and alias-invocation collisions (rule 6), and
 * validates every cross-object reference (rule 9). There is no last-wins merge;
 * order does not change the resolved graph because the export table is sorted by
 * canonical identity.
 */

import { canonicalDigest } from "../profile/templates/signing/canonical.js";
import { assertCrossReferences } from "./composition-refs.js";
import { MAX_FLATTENED_EXPORTS } from "./constants.js";
import { assertPackDigest, type Sha256Digest } from "./ids.js";
import { PackParseError } from "./problems.js";
import type {
  AliasDescriptorV1, ComposedGraphV1, CompositionMemberV1, ResolvedExportV1, WorkspaceOperationsPackV2,
} from "./types.js";
import { assertUniqueStrings } from "./values.js";

const EXPORT_SEPARATOR = "|";

/** The canonical `sha256:` digest of any data-only value. */
export function digestOf(value: unknown): Sha256Digest {
  return assertPackDigest(canonicalDigest(value));
}

/** Total lexicographic string order for deterministic export-table sorting. */
function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** The composite sort key an export row orders by: kind then exposed id. */
function exportKey(row: ResolvedExportV1): string {
  return `${row.kind}${EXPORT_SEPARATOR}${row.exposedId}`;
}

/** Build one export row binding an exposed id to its source object digest. */
function exportRow(
  kind: ResolvedExportV1["kind"], exposedId: string, object: unknown, rootPackDigest: Sha256Digest,
): ResolvedExportV1 {
  return { kind, exposedId, sourcePackDigest: rootPackDigest, sourceId: exposedId, objectDigest: digestOf(object) };
}

/** Derive the complete flattened export table without rewriting member bytes. */
function buildExportTable(pack: WorkspaceOperationsPackV2, rootPackDigest: Sha256Digest): ResolvedExportV1[] {
  const rows: ResolvedExportV1[] = [];
  for (const requirement of pack.providerRequirements) {
    rows.push(exportRow("provider-requirement", requirement.roleId, requirement, rootPackDigest));
  }
  for (const [id, recipe] of Object.entries(pack.recipes)) rows.push(exportRow("recipe", id, recipe, rootPackDigest));
  for (const [id, action] of Object.entries(pack.actions)) rows.push(exportRow("action", id, action, rootPackDigest));
  for (const alias of pack.aliases ?? []) rows.push(exportRow("alias", alias.aliasId, alias, rootPackDigest));
  if (rows.length > MAX_FLATTENED_EXPORTS) throw new PackParseError("flattened export table exceeds its cap");
  return rows.sort((left, right) => compareStrings(exportKey(left), exportKey(right)));
}

/** Build the single composition member and its derived identity digest. */
function buildMember(pack: WorkspaceOperationsPackV2, rootPackDigest: Sha256Digest): CompositionMemberV1 {
  const identity = { packId: pack.packId, packVersion: pack.packVersion, packDigest: rootPackDigest };
  return { ...identity, memberDigest: digestOf(identity) };
}

/** A single-root member graph is one present, trivially acyclic node (rules 2-3). */
function assertAcyclicPresentGraph(members: CompositionMemberV1[]): void {
  if (members.length !== 1) throw new PackParseError("single-root composition expects exactly one member");
}

/** No two aliases may share one (surface, host, locale, token) invocation (rule 6). */
function assertAliasInvocationsDistinct(aliases: readonly AliasDescriptorV1[]): void {
  const keys = aliases.map((alias) => [alias.surface, alias.host ?? "", alias.locale ?? "", alias.token].join(EXPORT_SEPARATOR));
  assertUniqueStrings(keys, "alias invocations");
}

/** Compose one single-root pack into its validated flattened export graph. */
export function composeSingleRoot(pack: WorkspaceOperationsPackV2): ComposedGraphV1 {
  assertCrossReferences(pack);
  const rootPackDigest = digestOf(pack);
  const members = [buildMember(pack, rootPackDigest)];
  assertAcyclicPresentGraph(members);
  const resolvedExports = buildExportTable(pack, rootPackDigest);
  assertUniqueStrings(resolvedExports.map((row) => row.exposedId), "export destinations");
  assertAliasInvocationsDistinct(pack.aliases ?? []);
  return { rootPackDigest, members, resolvedExports };
}
