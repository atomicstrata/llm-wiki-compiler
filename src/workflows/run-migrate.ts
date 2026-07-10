/**
 * @file src/workflows/run-migrate.ts
 * @description Forward-migration ladder for OLDER run-record schema versions.
 *
 * A persisted {@link WorkflowRun} carries a `schemaVersion`. The store gate fails
 * closed on a NEWER version (we cannot understand the future) but must NOT brick an
 * OLDER one — without a migration, the moment {@link WORKFLOW_RUN_SCHEMA_VERSION}
 * bumps, every persisted older run becomes unreadable AND un-cancellable (a whole
 * fleet bricks). This module is the migrate-on-read ladder that upgrades an older
 * record to the CURRENT shape (filling defaults for fields added since), so a
 * version bump degrades gracefully instead of catastrophically.
 *
 * ## INVARIANT — never bump the schema without a migration step
 * NEVER raise {@link WORKFLOW_RUN_SCHEMA_VERSION} without adding the corresponding
 * `migrateV<n>ToV<n+1>` step to {@link MIGRATION_STEPS}. The gate + this ladder make
 * a bump safe: an OLDER record migrates forward; a NEWER one fails closed. v1 is
 * the floor, so there is intentionally no v0 step — a hypothetical v0 record is
 * `unmigratable` (fail closed), proving the registry is consulted rather than
 * blindly upgrading.
 *
 * ## TRUST — never auto-sign a record that arrives without integrity
 * A migration step upgrades the SHAPE only; it does NOT confer trust. A v1 record
 * predates the {@link RUN_INTEGRITY_MIN_SCHEMA_VERSION} HMAC, so it arrives UNSIGNED.
 * {@link migrateV1ToV2} therefore NEVER fabricates an `integrity` field — auto-signing
 * an unsigned record would let an attacker's hand-crafted v1 record be accepted +
 * signed (reopening the C6 forgery hole). The reader surfaces a migrated-but-unsigned
 * record as `legacy-unsigned`; trust requires a record signed by THIS project's key.
 */

import { WORKFLOW_RUN_SCHEMA_VERSION } from "./types.js";

/**
 * A single forward step: upgrade a record from version `N` (its key) to `N+1`,
 * filling defaults for every field added in `N+1`. PURE — returns a new record,
 * never mutates its input. A version with no registered step is unmigratable.
 */
type MigrationStep = (record: Record<string, unknown>) => Record<string, unknown>;

/**
 * Upgrade a v1 record to the v2 SHAPE. v2 added `integrity`/`owner`/`pendingOutput`
 * and deep validation, but every new field is OPTIONAL in the shape, so the shape
 * upgrade is structural — no defaults to fabricate. It DROPS any `integrity` a v1
 * record carries: v1 predates tamper-evidence, so any `integrity` on it is meaningless
 * (or attacker-planted) and must NEVER be carried forward as if trusted. The reader
 * surfaces the result as `legacy-unsigned` (never auto-trusted).
 *
 * @param record - The parsed v1 record (shape not yet validated by the caller).
 * @returns A v2-shaped copy with any v1 `integrity` removed.
 */
function migrateV1ToV2(record: Record<string, unknown>): Record<string, unknown> {
  const { integrity: _dropLegacyIntegrity, ...rest } = record;
  return rest;
}

/**
 * The migration registry keyed on the SOURCE version: `MIGRATION_STEPS[n]` upgrades
 * a v`n` record to v`n+1`. `1: migrateV1ToV2` makes the v1→v2 bump safe fleet-wide;
 * v0 has no step (v1 is the floor), so a v0 record is `unmigratable`.
 */
const MIGRATION_STEPS: Record<number, MigrationStep> = {
  1: migrateV1ToV2,
};

/**
 * Forward-migrate `parsed` from `fromVersion` up to {@link WORKFLOW_RUN_SCHEMA_VERSION}.
 *
 * Walks the {@link MIGRATION_STEPS} ladder one version at a time. Returns the upgraded
 * record (with `schemaVersion` re-stamped to CURRENT) when every intermediate step is
 * registered, or `null` (fail closed) the moment a version lacks a step — an
 * un-migratable record is never silently passed through. A record already at the
 * current version is returned upgraded-in-place (an identity no-op).
 *
 * @param parsed - The parsed older record (shape NOT yet validated by the caller).
 * @param fromVersion - The record's stored `schemaVersion`.
 * @returns The upgraded record stamped to the current version, or `null` if unmigratable.
 */
export function migrateRun(
  parsed: Record<string, unknown>,
  fromVersion: number,
): Record<string, unknown> | null {
  if (fromVersion > WORKFLOW_RUN_SCHEMA_VERSION) return null; // newer: caller fails closed
  let record = parsed;
  let version = fromVersion;
  while (version < WORKFLOW_RUN_SCHEMA_VERSION) {
    const step = MIGRATION_STEPS[version];
    if (step === undefined) return null; // no path from this version: fail closed
    record = step(record);
    version += 1;
  }
  return { ...record, schemaVersion: WORKFLOW_RUN_SCHEMA_VERSION };
}
