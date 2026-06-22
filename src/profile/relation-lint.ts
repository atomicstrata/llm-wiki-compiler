/**
 * @file src/profile/relation-lint.ts
 * @description Relation-store lint findings, making the append-only relation
 * store (`wiki/graph/relations.jsonl`) VISIBLE through the profile-aware lint
 * runner — additively, alongside the entity-page findings.
 *
 * Three concerns, all fail-open or fail-closed (lint NEVER crashes):
 *   - `dangling-relation` (error): a relation endpoint EntityId with no page on
 *     disk. The relation references a page that does not exist, so an interlink
 *     would dead-end. The finding names the relation id + the missing endpoint.
 *   - `relation-store-torn` (warning): the reader tolerated and REPORTED a torn
 *     trailing line (an incomplete final append). Surfaced verbatim so the
 *     half-written record is visible, not silently dropped.
 *   - `relation-store-corrupt` / `relation-store-too-new` / `relation-store-symlink`
 *     (error): the reader FAILED CLOSED (interior corruption / an unknown future
 *     schema version / a symlinked-or-non-regular store-file leaf). Caught here so
 *     lint reports the failure instead of throwing.
 *
 * A DEFAULT project (no `wiki/graph`) reads an EMPTY store, so this yields no
 * findings and the default lint output stays byte-identical.
 */

import { readRelations } from "../relations/store-read.js";
import { RelationStoreCorruptError, RelationStoreTooNewError, RelationStoreSymlinkError } from "../relations/types.js";
import { validateRelationAgainstProfile } from "../relations/relation-contract.js";
import type { RelationRef } from "../relations/types.js";
import type { EntityId, EntityPage, ProfilePack } from "./types.js";
import type { LintResult } from "../linter/types.js";

/** Rule id for a relation endpoint that references a non-existent page. */
const DANGLING_RELATION_RULE = "dangling-relation";
/** Rule id for a tolerated torn trailing line reported by the store reader. */
const RELATION_STORE_TORN_RULE = "relation-store-torn";
/** Rule id for a fail-closed interior-corruption read. */
const RELATION_STORE_CORRUPT_RULE = "relation-store-corrupt";
/** Rule id for a fail-closed unknown-future-schema-version read. */
const RELATION_STORE_TOO_NEW_RULE = "relation-store-too-new";
/** Rule id for a fail-closed symlinked/non-regular store-file leaf read. */
const RELATION_STORE_SYMLINK_RULE = "relation-store-symlink";
/** Rule id for a stored relation no longer valid against the CURRENT profile. */
const RELATION_PROFILE_INVALID_RULE = "relation-profile-invalid";

/** The lint `file` label for store-level (not page-level) relation findings. */
const RELATION_STORE_FILE = "wiki/graph/relations.jsonl";

/** Build the store-level finding a fail-closed read maps to, by error type. */
function readErrorFinding(error: unknown): LintResult | null {
  if (error instanceof RelationStoreTooNewError) {
    return { rule: RELATION_STORE_TOO_NEW_RULE, severity: "error", file: RELATION_STORE_FILE, message: error.message };
  }
  if (error instanceof RelationStoreCorruptError) {
    return { rule: RELATION_STORE_CORRUPT_RULE, severity: "error", file: RELATION_STORE_FILE, message: error.message };
  }
  if (error instanceof RelationStoreSymlinkError) {
    return { rule: RELATION_STORE_SYMLINK_RULE, severity: "error", file: RELATION_STORE_FILE, message: error.message };
  }
  return null;
}

/** Map one tolerated reader problem (e.g. a torn trailing line) to a finding. */
function tornFinding(problem: string): LintResult {
  return { rule: RELATION_STORE_TORN_RULE, severity: "warning", file: RELATION_STORE_FILE, message: problem };
}

/** A `dangling-relation` finding naming the relation id + the missing endpoint. */
function danglingFinding(rel: RelationRef, side: "from" | "to", missing: EntityId): LintResult {
  return {
    rule: DANGLING_RELATION_RULE,
    severity: "error",
    file: RELATION_STORE_FILE,
    message: `relation ${rel.id} (${rel.type}) ${side} endpoint ${missing} has no entity page`,
  };
}

/** Findings for either endpoint of `rel` whose page is absent from `pageIds`. */
function danglingForRelation(rel: RelationRef, pageIds: Set<string>): LintResult[] {
  const findings: LintResult[] = [];
  if (!pageIds.has(rel.from)) findings.push(danglingFinding(rel, "from", rel.from));
  if (!pageIds.has(rel.to)) findings.push(danglingFinding(rel, "to", rel.to));
  return findings;
}

/**
 * A `relation-profile-invalid` finding for a stored relation that no longer
 * satisfies the CURRENT profile (type removed, endpoint type no longer allowed,
 * or attributes now invalid). The record is RETAINED on disk — this only makes
 * the profile-adaptation mismatch visible.
 */
function profileInvalidFinding(rel: RelationRef, reasons: string[]): LintResult {
  return {
    rule: RELATION_PROFILE_INVALID_RULE,
    severity: "error",
    file: RELATION_STORE_FILE,
    message: `relation ${rel.id} (${rel.type}) is no longer valid against the profile: ${reasons.join(" ")}`,
  };
}

/**
 * Surface the relation store's issues as additive lint findings.
 *
 * Reads the store fail-closed (a corrupt / too-new store becomes a single
 * store-level finding rather than a thrown error), reports each tolerated
 * problem (torn trailing line) as a warning, flags every relation endpoint
 * that has no entity page among `pages` as a `dangling-relation` error, and
 * flags every stored relation no longer valid against the CURRENT `profile`
 * (type removed / endpoint type disallowed / attributes now invalid) as a
 * `relation-profile-invalid` error — records are RETAINED, only reclassified.
 *
 * @param root - Absolute project root directory.
 * @param pages - The non-default profile's collected entity pages (their `id`s
 *   are the page-existence set checked against each relation endpoint).
 * @param profile - The CURRENT profile pack each stored relation is re-validated
 *   against (profile-adaptation: a record whose type/endpoints/attributes the
 *   profile has outgrown is flagged, not deleted).
 * @returns All relation-store findings (possibly empty).
 */
export async function checkRelationStore(
  root: string,
  pages: EntityPage[],
  profile: ProfilePack,
): Promise<LintResult[]> {
  let read;
  try {
    read = await readRelations(root);
  } catch (error) {
    const finding = readErrorFinding(error);
    if (finding) return [finding];
    throw error; // a non-store error (e.g. confinement escape) is not ours to swallow
  }
  const pageIds = new Set<string>(pages.map((page) => page.id));
  const findings = read.problems.map(tornFinding);
  for (const rel of read.relations) {
    const reasons = validateRelationAgainstProfile(rel, profile);
    if (reasons.length > 0) findings.push(profileInvalidFinding(rel, reasons));
    findings.push(...danglingForRelation(rel, pageIds));
  }
  return findings;
}
