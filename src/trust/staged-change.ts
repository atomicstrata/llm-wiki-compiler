/**
 * @file src/trust/staged-change.ts
 * @description The typed STAGED-CHANGE model and the fail-closed staged-write
 * volume bound — the CLP Phase-2 deferred refinement of the candidate cap.
 *
 * When the Write Planner reaches a non-live-write {@link TrustDecision}
 * (`stage-for-review` / `quarantine` / `deny`), the proposed mutation is not
 * applied; it is captured as a {@link StagedChange} — a declarative,
 * serializable record of WHAT was proposed, WHY it was held, and the exact
 * {@link PlannedMutation}s that would run on approval. This module owns only
 * those types plus the volume guard; it performs NO I/O and holds no relation/
 * artifact logic.
 *
 * Volume bound. Staging is an unbounded-by-default surface: an untrusted actor
 * can otherwise flood the review queue. {@link assertStagedWriteBudget}
 * generalizes the existing fail-closed candidate cap — `src/import/run.ts`
 * throws `QueueFullError` when `pending + valid > maxNewCandidates` for
 * untrusted imports, and `src/mcp/okf-tools.ts` pins
 * `MAX_MCP_PENDING_CANDIDATES = 200` — into a two-level (per-call + per-session)
 * ceiling that throws a typed {@link StagedWriteOverflowError} naming the
 * breached cap. It NEVER silently clamps: an overflow is an error the caller
 * must handle, not a truncation it can miss.
 *
 * Cap defaults. {@link DEFAULT_STAGED_WRITE_PER_SESSION} is `200`, anchored
 * directly to the existing pending-candidate ceiling so the two surfaces agree.
 * {@link DEFAULT_STAGED_WRITE_PER_CALL} is `50`: a single planning call should
 * not be able to consume the whole session budget in one shot, but the limit is
 * generous enough for realistic batch proposals. Per-session ≥ per-call always.
 *
 * `StagedRelationRef` / `StagedArtifactRef` are Phase-4 STUBS declared here purely
 * so the {@link StagedChange.target} union is total across all {@link CandidateKind}s;
 * relation/artifact staging logic lands later and may replace these shapes. They
 * are deliberately distinct from the canonical relation `RelationRef`
 * (`src/relations/types.ts`), which is the real persisted-edge type.
 */

import type { TrustDecision } from "./decision.js";
import type {
  EntityRef,
  MutationOperation,
  PlannedMutation,
} from "./planner.js";
import type { PolicyHeldReasonCode } from "../review/policy.js";

/** The store a staged change targets. Phase 2 stages `page` only. */
export type CandidateKind =
  | "page"
  | "relation"
  | "artifact"
  | "lifecycle-transition"
  | "workflow-gate";

/**
 * Why a change was held for review. OPEN union that imports and extends the
 * canonical review-policy {@link PolicyHeldReasonCode} (so the policy codes —
 * `low-confidence`, `contradicted`, `schema-violating`, `provenance-violating`,
 * `manual-review-requested`, `imported-okf`, `all`) stay a strict subset, plus
 * the trust-routing codes `trust-blocked` / `human-gate`, and any future code.
 */
export type HeldReasonCode =
  | PolicyHeldReasonCode
  | "trust-blocked"
  | "human-gate"
  | (string & {});

/** Phase-4 STUB: a staged relation target. Distinct from the canonical `RelationRef`. */
export interface StagedRelationRef {
  fromId: string;
  toId: string;
  relationType: string;
}

/** Phase-4 STUB: a staged artifact target. Replaced when artifacts land. */
export interface StagedArtifactRef {
  artifactId: string;
  artifactType: string;
}

/** Target of a staged workflow-gate change. */
export interface WorkflowRunRef {
  workflowRunId: string;
}

/**
 * One held, not-yet-applied mutation captured for review. `planned` is the exact
 * set of live writes that would run on approval; `trustDecision` is the routing
 * the planner reached; `preconditionHash` (when present) pins optimistic
 * concurrency for replay.
 */
export interface StagedChange {
  id: string;
  kind: CandidateKind;
  target: EntityRef | StagedRelationRef | StagedArtifactRef | WorkflowRunRef;
  operation: MutationOperation;
  planned: PlannedMutation[];
  heldReasons: HeldReasonCode[];
  trustDecision: TrustDecision;
  preconditionHash?: string;
  createdAt: string;
}

/** Per-call / per-session ceilings for staged writes. */
export interface StagedWriteCaps {
  perCall: number;
  perSession: number;
}

/**
 * Default max staged writes a single planning call may add. Kept well below the
 * session ceiling so one call cannot exhaust the whole budget at once.
 */
export const DEFAULT_STAGED_WRITE_PER_CALL = 50;

/**
 * Default max staged writes held across a session. Anchored to the existing
 * `MAX_MCP_PENDING_CANDIDATES` so the staging and import surfaces share a limit.
 */
export const DEFAULT_STAGED_WRITE_PER_SESSION = 200;

/**
 * Thrown when a staged-write request would exceed a cap. Carries the breached
 * `cap` name and the numbers so callers can report fail-closed, never clamp.
 */
export class StagedWriteOverflowError extends Error {
  readonly cap: "per-call" | "per-session";
  readonly attempted: number;
  readonly limit: number;

  constructor(cap: "per-call" | "per-session", attempted: number, limit: number) {
    super(`staged-write ${cap} cap exceeded: ${attempted} > ${limit}`);
    this.name = "StagedWriteOverflowError";
    this.cap = cap;
    this.attempted = attempted;
    this.limit = limit;
  }
}

/**
 * Thrown when a staged-write count is not a non-negative integer. A negative,
 * NaN, or fractional count would slip past the pure `>` cap comparisons and
 * defeat the flood guard (fail OPEN), so it is rejected up front by name.
 */
export class StagedWriteInputError extends Error {
  constructor(field: "existingCount" | "requested", value: number) {
    super(`staged-write ${field} must be a non-negative integer, got ${value}`);
    this.name = "StagedWriteInputError";
  }
}

/** Assert a staged-write count is a non-negative integer, else throw by name. */
function assertNonNegativeInteger(
  field: "existingCount" | "requested",
  value: number,
): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new StagedWriteInputError(field, value);
  }
}

/**
 * Fail-closed staged-write volume bound. First validates both counts are
 * non-negative integers (a negative/NaN/fractional input would otherwise slip
 * past the `>` comparisons and fail OPEN). Then passes only when the request
 * fits BOTH the per-call cap (`requested <= perCall`) AND the per-session cap
 * (`existingCount + requested <= perSession`); otherwise throws a typed
 * {@link StagedWriteOverflowError} naming the breached cap. Never clamps.
 *
 * @param existingCount - Staged writes already held this session.
 * @param requested - Staged writes this call wants to add.
 * @param caps - The per-call and per-session ceilings to enforce.
 * @throws {StagedWriteInputError} When either count is not a non-negative integer.
 * @throws {StagedWriteOverflowError} When either ceiling would be exceeded.
 */
export function assertStagedWriteBudget(
  existingCount: number,
  requested: number,
  caps: StagedWriteCaps,
): void {
  assertNonNegativeInteger("existingCount", existingCount);
  assertNonNegativeInteger("requested", requested);
  if (requested > caps.perCall) {
    throw new StagedWriteOverflowError("per-call", requested, caps.perCall);
  }
  const sessionTotal = existingCount + requested;
  if (sessionTotal > caps.perSession) {
    throw new StagedWriteOverflowError("per-session", sessionTotal, caps.perSession);
  }
}
