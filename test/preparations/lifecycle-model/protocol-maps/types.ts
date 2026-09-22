/**
 * @file test/preparations/lifecycle-model/protocol-maps/types.ts
 * @description The row grammar for a total protocol-preservation map.
 *
 * Authority design V2 §5.1 makes a checked-in map a BLOCKING precondition for the
 * Task 9D/9E driver migrations, and fixes the row shape: every existing durable
 * step names its current seam, the driver phase it will become, the exact bytes it
 * affects, its crash-before and crash-after classifications, how a resume
 * continues it idempotently, the tests that prove it, and its disposition under
 * the migration.
 *
 * The gate that gives the map its value is stated in the same section: "Every
 * existing step appears exactly once as an owned driver step or an
 * operation-specific adapter obligation. Unmapped and multiply-owned steps fail
 * the design gate." That is mechanical, so it is a test rather than a promise —
 * see protocol-maps.test.ts.
 *
 * The map is written BEFORE the migration and is not edited to match it. A step
 * whose behaviour changes must change here first, as a reviewed decision, which is
 * the whole point of preserving a protocol rather than reimplementing one.
 */

/** The common driver phase an existing step becomes (design V1/V2). */
export const DRIVER_PHASES = [
  "snapshot", "authorize", "plan", "observe", "apply/resume", "verify", "complete",
] as const;

export type DriverPhase = (typeof DRIVER_PHASES)[number];

/**
 * What the migration does to a step. `rejected` requires a dated decision naming
 * it — a step cannot be dropped by omission, only by an argued record.
 */
export const DISPOSITIONS = ["preserved", "strengthened", "rejected"] as const;

export type Disposition = (typeof DISPOSITIONS)[number];

/** Which operation owns the step. `shared` marks the common two-phase driver. */
export const PROTOCOL_OPERATIONS = [
  "reset", "quarantine", "purge", "supersession", "shared", "prune", "sweep",
] as const;

export type ProtocolOperation = (typeof PROTOCOL_OPERATIONS)[number];

/** One `symbol` declared in one repo-relative `file`. */
export interface SeamCitation {
  readonly symbol: string;
  /** Repo-relative, e.g. `src/preparations/reset.ts`. Basenames are not enough. */
  readonly file: string;
}

/** One existing durable step, mapped. */
export interface ProtocolMapRowV1 {
  /** Stable id, unique across the map. */
  readonly id: `PLA-MAP-${string}`;
  readonly operation: ProtocolOperation;
  /** The exact approved durable behaviour, stated as behaviour not as code. */
  readonly step: string;
  /**
   * The exact code responsible, as structured citations.
   *
   * A free-text seam was defeated three times: by an identifier appearing in a
   * comment, by a citation whose directory was discarded, and by symbols written
   * in a shape the extractor never matched. Structure removes all three — every
   * symbol a row claims is a citation the control resolves, and there is no prose
   * for one to hide in. Narrative belongs in `seamNote`, which is checked by
   * nobody and claims nothing.
   */
  readonly seam: readonly SeamCitation[];
  /** Free-text context. Deliberately unchecked and deliberately not evidence. */
  readonly seamNote?: string;
  readonly phase: DriverPhase;
  /** The exact bytes or record affected, or "none" for a pure decision. */
  readonly effect: string;
  /** Authoritative classification if the process dies immediately BEFORE. */
  readonly crashBefore: string;
  /** Authoritative classification if the process dies immediately AFTER. */
  readonly crashAfter: string;
  /** How the same operation continues idempotently from crashAfter. */
  readonly resume: string;
  /** Frozen regression ids and/or scenario titles that prove it. */
  readonly provingTests: readonly string[];
  readonly disposition: Disposition;
  /** Required when disposition is `rejected`: the dated decision that says so. */
  readonly rejectedBy?: string;
}

/** Construct one row positionally, so the file reads as a table. */
export function mapRow(
  id: ProtocolMapRowV1["id"],
  operation: ProtocolOperation,
  step: string,
  seam: readonly SeamCitation[],
  phase: DriverPhase,
  effect: string,
  crashBefore: string,
  crashAfter: string,
  resume: string,
  provingTests: readonly string[],
  disposition: Disposition,
  rejectedBy?: string,
  seamNote?: string,
): ProtocolMapRowV1 {
  return {
    id, operation, step, seam, phase, effect,
    crashBefore, crashAfter, resume, provingTests, disposition,
    ...(rejectedBy === undefined ? {} : { rejectedBy }),
    ...(seamNote === undefined ? {} : { seamNote }),
  };
}

/** Shorthand so a row's citations read as a table. */
export function at(symbol: string, file: string): SeamCitation {
  return { symbol, file };
}
