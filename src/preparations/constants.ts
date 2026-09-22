/**
 * @file src/preparations/constants.ts
 * @description Orchestration V2 launch ceilings (design section 26.1) plus the
 * pinned Milestone A handoff limits (section 10.1). Count limits name the
 * counted resource; byte limits carry a `BYTES` suffix so bounds arithmetic
 * never compares unlike units. Preparation's own manifest cap (2 MiB) is
 * deliberately distinct from the Milestone A bundle manifest cap (4 MiB); the
 * handoff subset is checked against the exact Milestone A caps imported from the
 * operation-bundle module rather than a second local copy.
 */

import {
  MAX_ACTIVE_BUNDLE_BYTES,
  MAX_BUNDLE_PAYLOAD_BYTES,
  MAX_MANIFEST_BYTES as MAX_MILESTONE_A_MANIFEST_BYTES,
  MAX_PAYLOAD_BYTES,
  MAX_RUN_EVIDENCE_BLOB_BYTES,
  MAX_RUN_EVIDENCE_BYTES as MAX_MILESTONE_A_RUN_EVIDENCE_BYTES,
} from "../operation-bundles/constants.js";

const KIBIBYTE_BYTES = 1024;
const MEBIBYTE_BYTES = 1024 * KIBIBYTE_BYTES;
const GIBIBYTE_BYTES = 1024 * MEBIBYTE_BYTES;

/** Only version-one preparation plans compile through this loader. */
export const PREPARATION_SCHEMA_VERSION = 1;

/** Maximum UTF-8 bytes in any interpolated safe path/identity component. */
export const MAX_SAFE_COMPONENT_BYTES = 128;

/** Maximum UTF-8 bytes accepted for one durable normalized-plan document. */
export const MAX_PLAN_BYTES = 2 * MEBIBYTE_BYTES;

/** Maximum nesting depth accepted before closed plan validation. */
export const MAX_PLAN_JSON_DEPTH = 32;

// --- Section 26.1 launch ceilings enforced by Task 1 bounds arithmetic ---
// Staging, capacity, and store ceilings (per-staging-call, prepared inputs,
// manifest/run bytes, transition envelope, control headroom, project-wide
// active bytes) are introduced by their consuming store and capacity modules.

/** Maximum logical phases declared by one normalized plan. */
export const MAX_LOGICAL_PHASES_PER_PLAN = 64;
/** Maximum materialized phase instances worst-cased for one run. */
export const MAX_PHASE_INSTANCES_PER_RUN = 256;
/** Maximum attempts per materialized phase instance. */
export const MAX_ATTEMPTS_PER_PHASE_INSTANCE = 3;
/** Maximum provider or host invocations worst-cased for one run. */
export const MAX_INVOCATIONS_PER_RUN = 256;
/** Maximum evidence references worst-cased for one run. */
export const MAX_EVIDENCE_REFS_PER_RUN = 8_192;
/** Maximum retained preparation-evidence bytes worst-cased for one run. */
export const MAX_RETAINED_EVIDENCE_BYTES = 8 * GIBIBYTE_BYTES;
/** Maximum checkpoint bytes worst-cased for one run. */
export const MAX_CHECKPOINT_BYTES_PER_RUN = 256 * MEBIBYTE_BYTES;
/** Maximum transitions worst-cased for one run. */
export const MAX_TRANSITIONS_PER_RUN = 3_200;

// --- Section 26.1 store, capacity, and staging ceilings (Task 2 consumers) ---
// Introduced here, adjacent to their launch-ceiling siblings, and consumed by
// the manifest/run/evidence stores, capacity accounting, and staging.

/**
 * Maximum prepared inputs worst-cased for one run (PO-INV-10). Task 1 could not
 * compute the per-run prepared-input cardinality because the plan grammar
 * carried no per-phase input count; capacity and staging enforce this ceiling
 * against the plan's declared prepared-input worst case rather than dropping it.
 */
export const MAX_PREPARED_INPUTS_PER_RUN = 4_096;

/** Maximum UTF-8 bytes accepted for one durable preparation manifest document. */
export const MAX_PREPARATION_MANIFEST_BYTES = 2 * MEBIBYTE_BYTES;

/** Maximum UTF-8 bytes accepted for one durable preparation-run record. */
export const MAX_PREPARATION_RUN_BYTES = 4 * MEBIBYTE_BYTES;

/**
 * Maximum bytes in one hash-chained transition envelope. The `handoff-started`
 * recovery authority is the largest fixed-shape transition — eight bounded
 * identity/digest fields, including the genesis-authority digest that pins the
 * reserved bundle's control budget and compensation topology — and serializes to
 * ~1.05 KiB, so this bound is 2 KiB: comfortable headroom for that record while
 * still tightly capping every transition against an oversized-record DoS.
 */
export const MAX_PREPARATION_TRANSITION_ENVELOPE_BYTES = 2 * KIBIBYTE_BYTES;

/** Reserved control headroom for fixed-shape terminal and settlement moves. */
export const PREPARATION_RUN_CONTROL_RESERVE_BYTES = 256 * KIBIBYTE_BYTES;

/** Maximum bytes in one immutable preparation-evidence object. */
export const MAX_PREPARATION_EVIDENCE_OBJECT_BYTES = 2 * GIBIBYTE_BYTES;

/** Maximum bytes accepted when reading the project preparation-key leaf. */
export const MAX_PREPARATION_KEY_FILE_BYTES = KIBIBYTE_BYTES;

/** New durable preparations accepted in one staging call. */
export const MAX_NEW_PREPARATIONS_PER_STAGING_CALL = 10;

/** Active nonterminal preparation runs project-wide. */
export const MAX_ACTIVE_NONTERMINAL_RUNS = 50;

/**
 * Active durable preparations per workspace. Sized so one LONG multi-stage workflow can
 * complete: a workflow whose every stage runs a durable preparation in a single
 * workspace accumulates one preparation per stage (completed ones remain counted until
 * pruned) — a ~15-stage pipeline needs ~14 slots, plus headroom for a parked or
 * re-staged attempt. Still finite under the project-wide run, byte, and inventory caps.
 */
export const MAX_ACTIVE_PREPARATIONS_PER_WORKSPACE = 24;

/** Active preparation bytes project-wide. */
export const MAX_ACTIVE_PREPARATION_BYTES = 32 * GIBIBYTE_BYTES;

/**
 * Host-owned directory-entry ceiling for one baseline-compatible preparation
 * inventory.
 *
 * Enforced PER TRAVERSAL — the active walk and the lifecycle registry walk each
 * carry their own counter capped at this value — and reconciled afterwards as a
 * combined refusal when their sum exceeds it.
 *
 * The refusal is equivalent to the baseline's for every shape exercised. The two
 * traversals count structurally comparable rather than provably identical entry
 * sets, so equality is not claimed. Worst-case traversal work is NOT equivalent: this is a classification bound, not a single shared I/O budget.
 */
export const MAX_PREPARATION_INVENTORY_ENTRIES = 100_000;

// --- Section 10.1 pinned Milestone A handoff subset ---------------------

/**
 * The exact Milestone A V2 design digest a handoff capacity contract must pin.
 * A conforming plan copies this literal so a pack or provider cannot assert a
 * different downstream contract.
 */
export const MILESTONE_A_DESIGN_DIGEST =
  "sha256:bff6f9d9fe776919011c2acd2169f48a29764706980a364dabc2ef6b35506ca8" as const;

/** Maximum bytes in one Milestone A bundle payload item (16 MiB). */
export const MAX_HANDOFF_ITEM_PAYLOAD_BYTES = MAX_PAYLOAD_BYTES;
/** Maximum aggregate Milestone A bundle payload bytes (64 MiB). */
export const MAX_HANDOFF_AGGREGATE_PAYLOAD_BYTES = MAX_BUNDLE_PAYLOAD_BYTES;
/** Maximum Milestone A manifest bytes (4 MiB). */
export const MAX_HANDOFF_MANIFEST_BYTES = MAX_MILESTONE_A_MANIFEST_BYTES;
/** Maximum bytes in one Milestone A run-evidence blob (256 KiB). */
export const MAX_HANDOFF_RUN_EVIDENCE_ITEM_BYTES = MAX_RUN_EVIDENCE_BLOB_BYTES;
/** Maximum aggregate Milestone A run-evidence bytes (16 MiB). */
export const MAX_HANDOFF_RUN_EVIDENCE_BYTES = MAX_MILESTONE_A_RUN_EVIDENCE_BYTES;
/** Maximum active Milestone A store contribution bytes (512 MiB). */
export const MAX_HANDOFF_ACTIVE_STORE_BYTES = MAX_ACTIVE_BUNDLE_BYTES;
