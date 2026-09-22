/**
 * @file src/operation-bundles/constants.ts
 * @description Milestone A launch limits from V2 section 22.1 and decision
 * D-012. Count limits name the counted resource; byte limits carry a `BYTES`
 * suffix so stores cannot accidentally compare unlike units.
 */

const KIBIBYTE_BYTES = 1024;
const MEBIBYTE_BYTES = 1024 * KIBIBYTE_BYTES;

/** Maximum bundles accepted by one staging request. */
export const MAX_NEW_BUNDLES_PER_STAGING_CALL = 10;
/** Maximum pending or awaiting bundles across a project. */
export const MAX_PENDING_BUNDLES = 50;
/** Maximum mutations declared by one bundle. */
export const MAX_MUTATIONS_PER_BUNDLE = 256;
/** Maximum UTF-8 bytes in one operation workspace id. */
export const MAX_WORKSPACE_ID_BYTES = 128;
/** Maximum UTF-8 bytes in one operation projection recipe id. */
export const MAX_RECIPE_ID_BYTES = 128;
/** Maximum bytes in one bundle payload. */
export const MAX_PAYLOAD_BYTES = 16 * MEBIBYTE_BYTES;
/** Maximum aggregate payload bytes in one bundle. */
export const MAX_BUNDLE_PAYLOAD_BYTES = 64 * MEBIBYTE_BYTES;
/** Maximum canonical manifest bytes. */
export const MAX_MANIFEST_BYTES = 4 * MEBIBYTE_BYTES;
/** Maximum complete operation-run record bytes. */
export const MAX_RUN_BYTES = 4 * MEBIBYTE_BYTES;
/** Maximum bytes in one ordinary transition envelope. */
export const MAX_TRANSITION_ENVELOPE_BYTES = 2 * KIBIBYTE_BYTES;
/** Maximum transitions budgeted for one operation run. */
export const MAX_RUN_TRANSITIONS = 1_100;
/** Bytes kept outside the ordinary transition budget for control records. */
export const RUN_CONTROL_RESERVE_BYTES = 128 * KIBIBYTE_BYTES;
/**
 * The control-transition budget a staged operation run gets when the producer
 * of the bundle names no other.
 *
 * IT IS A BUDGET FOR THE RUN'S WHOLE FUTURE, not for staging it, and reading it
 * as the latter produces an unapplyable bundle. `validateControlHeadroom`
 * charges this allowance for every control transition the run will ever append —
 * the terminal `succeeded`, a `recovery-required` park, a `recovery-resumed`, a
 * `compensation-began`, a `compensated` — and reserves slots ahead of the run
 * rather than behind it: reaching `applying` at all requires TWO free control
 * slots, so a run may always park and then retire honestly.
 *
 * THE FLOOR IS 4, NOT 2. Two reaches `applying` and settles, and strands there:
 * a park consumes one, and the `recovery-resumed` that follows returns the run
 * to `applying`, which demands two more. Four is the smallest value that
 * survives one full park-and-resume, or one park-and-compensate.
 *
 * SIXTEEN, because a floor is not a budget. It matches the allowance the
 * preparation service gives any run a caller did not size, so a bundle gets the
 * same recovery headroom whoever produced it — several parks and resumes, not
 * exactly one.
 */
export const DEFAULT_OPERATION_CONTROL_TRANSITION_ALLOWANCE = 16;
/** Maximum bytes in one run-evidence blob. */
export const MAX_RUN_EVIDENCE_BLOB_BYTES = 256 * KIBIBYTE_BYTES;
/** Maximum aggregate evidence bytes for one run. */
export const MAX_RUN_EVIDENCE_BYTES = 16 * MEBIBYTE_BYTES;
/** Maximum active payload, evidence, and orphan bytes project-wide. */
export const MAX_ACTIVE_BUNDLE_BYTES = 512 * MEBIBYTE_BYTES;
/** Maximum bytes in one retained source. */
export const MAX_RETAINED_SOURCE_BYTES = 16 * MEBIBYTE_BYTES;
/** Maximum retained-source bytes in one workspace. */
export const MAX_WORKSPACE_RETAINED_SOURCE_BYTES = 512 * MEBIBYTE_BYTES;
/** Maximum canonical bytes in one catalog record. */
export const MAX_CATALOG_RECORD_BYTES = 64 * KIBIBYTE_BYTES;
/** Maximum catalog records in one workspace. */
export const MAX_CATALOG_RECORDS_PER_WORKSPACE = 50_000;
/** Maximum complete catalog file bytes. */
export const MAX_CATALOG_FILE_BYTES = 32 * MEBIBYTE_BYTES;
/** Maximum bytes in one projection output. */
export const MAX_PROJECTION_BYTES = 16 * MEBIBYTE_BYTES;
/** Maximum projection bytes in one workspace. */
export const MAX_WORKSPACE_PROJECTION_BYTES = 256 * MEBIBYTE_BYTES;
